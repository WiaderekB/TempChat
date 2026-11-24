"""Atomic snapshots. Paths in a manifest are display data, never host paths."""
import difflib
import hashlib
import io
import json
import re
import tempfile
import unicodedata
import zipfile
from pathlib import PurePosixPath

MIB = 1024 * 1024
MAX_BYTES = 64 * MIB
MAX_ENTRIES = 2048
ROOM_BYTES = 512 * MIB
CODE_PATH = 'fragment'


class Problem(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def require(condition, status, message):
    if not condition:
        raise Problem(status, message)


def path_name(value, nested=True):
    require(isinstance(value, str), 400, 'Niepoprawna nazwa.')
    value = unicodedata.normalize('NFC', value)
    parts = value.split('/')
    require(0 < len(value.encode()) <= 1024 and (nested or len(parts) == 1)
            and all(part.strip() and part not in ('.', '..') and len(part.encode()) <= 255 for part in parts)
            and not re.search(r'[\\:\x00-\x1f\x7f]', value), 400, 'Niepoprawna ścieżka.')
    return value


def unpack(stream, length):
    require(4 <= length <= MAX_BYTES + MIB + 4, 413, 'Limit przesyłania wynosi 64 MiB.')
    header_len = int.from_bytes(stream.read(4), 'big')
    require(0 < header_len <= min(MIB, length - 4), 400, 'Niepoprawny nagłówek pliku.')
    head = json.loads(stream.read(header_len))
    require(isinstance(head, dict), 400, 'Niepoprawny opis.')
    name = path_name(head.get('name'), False)
    kind, items, mode = head.get('kind'), head.get('entries'), head.get('mode')
    require(kind in ('folder', 'file') and isinstance(items, list) and len(items) <= MAX_ENTRIES,
            400, 'Niepoprawna lista plików lub więcej niż 2048 elementów.')
    require(kind == 'folder' or len(items) == 1, 400, 'Oczekiwano jednego pliku.')
    require(mode in (None, 'copy', 'version'), 400, 'Niepoprawny tryb zapisu.')
    remaining = length - header_len - 4
    require(remaining <= MAX_BYTES, 413, 'Limit przesyłania wynosi 64 MiB.')
    manifest, contents = {}, {}
    for item in items:
        require(isinstance(item, dict), 400, 'Niepoprawny wpis.')
        path = path_name(item.get('path'))
        size = item.get('size')
        require(path not in manifest and (kind == 'folder' or path == name), 400, 'Powtórzona lub błędna ścieżka.')
        if size is None and kind == 'folder':
            manifest[path] = None
            continue
        require(type(size) is int and 0 <= size <= remaining, 400, 'Niepoprawny rozmiar pliku.')
        data = stream.read(size)
        require(len(data) == size, 400, 'Niepełny plik.')
        remaining -= size
        digest = hashlib.sha256(data).hexdigest()
        contents[digest] = data
        manifest[path if kind == 'folder' else name] = digest
    for path in manifest:
        for ancestor in PurePosixPath(path).parents:
            require(manifest.get(str(ancestor)) is None, 400, 'Plik blokuje ścieżkę folderu.')
    require(remaining == 0, 400, 'Niepoprawny rozmiar paczki.')
    note = head.get('note', '')
    require(isinstance(note, str) and len(note) <= 200, 400, 'Opis wersji jest zbyt długi.')
    return name, kind, mode, note.strip(), manifest, contents, length - header_len - 4


def copy_name(db, room, name, kind):
    suffix = PurePosixPath(name).suffix if kind == 'file' else ''
    base = name.removesuffix(suffix) if suffix else name
    i = 2
    while True:
        extra = f' ({i})' + suffix
        short = base.encode()[:max(0, 255-len(extra.encode()))].decode(errors='ignore')
        candidate = short + extra
        if not db.execute('SELECT 1 FROM assets WHERE room=? AND name=?', (room, candidate)).fetchone():
            return candidate
        i += 1


def version(db, asset, author, now, note, manifest, size, lang):
    num = db.execute('SELECT coalesce(max(num),0)+1 FROM versions WHERE asset=?', (asset,)).fetchone()[0]
    db.execute('INSERT INTO versions(asset,num,author,created,note,manifest,size,lang) VALUES(?,?,?,?,?,?,?,?)',
               (asset, num, author, now, note, json.dumps(manifest, ensure_ascii=False), size, lang))
    return num


def revision(db, room, asset, member, now, note, manifest, size, snippet=None, lang=''):
    num = version(db, asset, member['nick'], now, note, manifest, size, lang)
    kind, body = ('code', snippet) if snippet is not None else ('asset', note)
    db.execute('INSERT INTO messages(room,kind,author,body,lang,asset,num,created,sender) VALUES(?,?,?,?,?,?,?,?,?)',
               (room, kind, member['nick'], body, lang, asset, num, now, member['token']))
    return {'asset': asset, 'num': num}


def save(db, room, member, now, packet):
    name, kind, mode, note, manifest, contents, size = packet
    existing = db.execute('SELECT * FROM assets WHERE room=? AND name=?', (room, name)).fetchone()
    if existing and mode == 'copy':
        name = copy_name(db, room, name, kind)
        if kind == 'file':
            manifest = {name: next(iter(manifest.values()))}
        existing = None
    if existing:
        require(mode == 'version' and existing['kind'] == kind, 409, 'Nazwa jest już zajęta.')
        asset = existing['id']
    else:
        asset = db.execute('INSERT INTO assets(room,name,kind) VALUES(?,?,?)', (room,name,kind)).lastrowid
    store_blobs(db, room, contents)
    return revision(db, room, asset, member, now, note, manifest, size)


def store_blobs(db, room, contents):
    used = db.execute('SELECT coalesce(sum(length(data)),0) FROM blobs WHERE room=?', (room,)).fetchone()[0]
    for digest, data in contents.items():
        if db.execute('SELECT 1 FROM blobs WHERE room=? AND digest=?',(room,digest)).fetchone():
            continue
        used += len(data)
        require(used <= ROOM_BYTES, 413, 'Pokój osiągnął limit 512 MiB danych plikowych.')
        db.execute('INSERT INTO blobs(room,digest,data) VALUES(?,?,?)', (room,digest,data))


def create_snippet(db, room, name):
    if db.execute('SELECT 1 FROM assets WHERE room=? AND name=?', (room, name)).fetchone():
        name = copy_name(db, room, name, 'code')
    return db.execute("INSERT INTO assets(room,name,kind) VALUES(?,?,'code')", (room, name)).lastrowid


def save_snippet(db, room, member, now, text, lang, data):
    asset = data.get('asset')
    if asset is None:
        name = data.get('title', '')
        require(isinstance(name, str) and len(name) <= 80, 400, 'Nazwa może zawierać do 80 znaków.')
        asset = create_snippet(db, room, name.strip() or 'Fragment kodu')
    else:
        require(type(asset) is int and 0 < asset < 2**63, 400, 'Niepoprawny fragment.')
        require(db.execute("SELECT 1 FROM assets WHERE id=? AND room=? AND kind='code'",
                           (asset, room)).fetchone(), 404, 'Nie znaleziono fragmentu kodu.')
    note = data.get('note', '')
    require(isinstance(note, str) and len(note) <= 200, 400, 'Opis wersji jest zbyt długi.')
    encoded = text.encode()
    digest = hashlib.sha256(encoded).hexdigest()
    store_blobs(db, room, {digest: encoded})
    return revision(db, room, asset, member, now, note.strip(), {CODE_PATH: digest}, len(encoded), text, lang)


def migrate_snippets(db):
    pending = db.execute("SELECT * FROM messages WHERE kind='code' AND asset IS NULL ORDER BY id").fetchall()
    for message in pending:
        room = message['room']
        asset = create_snippet(db, room, 'Fragment kodu')
        data = message['body'].encode()
        digest = hashlib.sha256(data).hexdigest()
        db.execute('INSERT OR IGNORE INTO blobs(room,digest,data) VALUES(?,?,?)', (room, digest, data))
        num = version(db, asset, message['author'], message['created'], '', {CODE_PATH: digest}, len(data), message['lang'])
        db.execute('UPDATE messages SET asset=?,num=? WHERE id=?', (asset, num, message['id']))


def get_blob(db, room, digest, limit=None):
    sql = 'SELECT data FROM blobs WHERE room=? AND digest=?'
    if limit:
        sql += ' AND length(data)<=?'
    row = db.execute(sql, (room,digest,limit) if limit else (room,digest)).fetchone()
    return row[0] if row else None


def snapshot(db, room, asset, num):
    row = db.execute('SELECT v.*,a.name,a.kind FROM versions v JOIN assets a ON a.id=v.asset '
                     'WHERE a.room=? AND a.id=? AND v.num=?', (room,asset,num)).fetchone()
    require(row, 404, 'Nie znaleziono wersji.')
    return row, json.loads(row['manifest'])


def preview(db, room, digest):
    data = get_blob(db, room, digest, 256 * 1024)
    if data is not None:
        try:
            if data.startswith(b'PK\x03\x04') or data.startswith(b'PK\x05\x06'):
                with zipfile.ZipFile(io.BytesIO(data)) as z:
                    return {'type':'zip', 'text':'\n'.join(z.namelist()[:2048])}
            if b'\0' not in data:
                return {'type':'text', 'text':data.decode('utf-8')}
        except (UnicodeError, zipfile.BadZipFile):
            pass
    return {'type':'binary', 'text':'Podgląd niedostępny. Pobierz plik, aby go otworzyć.'}


def changes(old, new):
    result = []
    for path in sorted(old.keys() | new.keys()):
        if path not in old:
            state = 'added'
        elif path not in new:
            state = 'removed'
        elif old[path] != new[path]:
            state = 'changed'
        else:
            continue
        result.append({'path':path,'state':state})
    return result


def diff_text(db, room, old, new, path):
    require(path in old or path in new, 404, 'Brak pliku.')
    lines = []
    for version in (old,new):
        digest = version.get(path)
        data = get_blob(db, room, digest, 64 * 1024) if digest else b''
        if data is None or b'\0' in data:
            return 'Porównanie tekstowe niedostępne dla tego pliku.'
        try:
            lines.append(data.decode().splitlines(keepends=True))
        except UnicodeError:
            return 'Plik binarny.'
    if max(map(len, lines)) > 2000:
        return 'Plik przekracza limit 2000 wierszy podglądu różnic.'
    return ''.join(line if line.endswith('\n') else line+'\n' for line in
                   difflib.unified_diff(*lines, fromfile='poprzednia', tofile='wybrana')) or 'Brak różnic w tekście.'


def archive(db, room, name, manifest):
    out = tempfile.TemporaryFile()
    try:
        with zipfile.ZipFile(out, 'w', zipfile.ZIP_STORED) as z:
            z.writestr(name+'/', b'')
            for path, digest in manifest.items():
                full = name+'/'+path
                if digest is None:
                    z.writestr(full+'/', b'')
                else:
                    z.writestr(full, get_blob(db, room, digest))
        out.seek(0)
        return out
    except BaseException:
        out.close()
        raise
