"""Atomic snapshots. Paths in a manifest are display data, never host paths."""
import base64
import codecs
import csv
import difflib
import hashlib
import io
import json
import re
import tempfile
import unicodedata
import zipfile
from bisect import bisect_left
from itertools import islice, zip_longest
from pathlib import PurePosixPath

MIB = 1024 * 1024
MAX_BYTES = 64 * MIB
MAX_HEADER = 4 * MIB
MAX_ENTRIES = 10000
MAX_ATTACHMENTS = 12
ROOM_BYTES = 512 * MIB
CODE_PATH = 'fragment'
EDIT_LIMIT = 256 * 1024
SEARCH_PAGE = 60
TABLE_PREVIEW_BYTES = 512 * 1024
TABLE_ROWS = 1000
TABLE_COLUMNS = 100


class Problem(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def require(condition, status, message):
    if not condition:
        raise Problem(status, message)


def path_name(value, nested=True):
    require(isinstance(value, str), 400, 'Invalid name.')
    value = unicodedata.normalize('NFC', value)
    parts = value.split('/')
    require(0 < len(value.encode()) <= 1024 and (nested or len(parts) == 1)
            and all(part.strip() and part not in ('.', '..') and len(part.encode()) <= 255 for part in parts)
            and not re.search(r'[\\:\x00-\x1f\x7f]', value), 400, 'Invalid path.')
    return value


def upload_header(stream, length):
    require(4 <= length <= MAX_BYTES + MAX_HEADER + 4, 413, 'The upload limit is 64 MiB plus the file list.')
    header_len = int.from_bytes(stream.read(4), 'big')
    require(0 < header_len <= min(MAX_HEADER, length - 4), 400, 'Invalid upload header.')
    head = json.loads(stream.read(header_len))
    require(isinstance(head, dict), 400, 'Invalid upload metadata.')
    return head, length - header_len - 4


def unpack(stream, length):
    head, remaining = upload_header(stream, length)
    size_total = remaining
    name = path_name(head.get('name'), False)
    kind, items, mode = head.get('kind'), head.get('entries'), head.get('mode')
    require(kind in ('folder', 'file') and isinstance(items, list) and len(items) <= MAX_ENTRIES,
            400, 'Invalid file list. Uploads can contain up to 10,000 items.')
    require(kind == 'folder' or len(items) == 1, 400, 'Expected one file.')
    require(mode in (None, 'copy', 'version'), 400, 'Invalid save mode.')
    require(remaining <= MAX_BYTES, 413, 'The upload limit is 64 MiB.')
    manifest, contents = {}, {}
    for item in items:
        require(isinstance(item, dict), 400, 'Invalid upload entry.')
        path = path_name(item.get('path'))
        size = item.get('size')
        require(path not in manifest and (kind == 'folder' or path == name), 400, 'Duplicate or invalid path.')
        if size is None and kind == 'folder':
            manifest[path] = None
            continue
        require(type(size) is int and 0 <= size <= remaining, 400, 'Invalid file size.')
        data = stream.read(size)
        require(len(data) == size, 400, 'Incomplete file.')
        remaining -= size
        digest = hashlib.sha256(data).hexdigest()
        contents[digest] = data
        manifest[path if kind == 'folder' else name] = digest
    for path in manifest:
        for ancestor in PurePosixPath(path).parents:
            require(manifest.get(str(ancestor)) is None, 400, 'A file occupies a folder path.')
    require(remaining == 0, 400, 'Invalid upload size.')
    note = head.get('note', '')
    require(isinstance(note, str) and len(note) <= 200, 400, 'The version note is too long.')
    return name, kind, mode, note.strip(), manifest, contents, size_total


def unpack_share(stream, length):
    head, remaining = upload_header(stream, length)
    text, sizes = head.get('text'), head.get('sizes')
    require(isinstance(text, str) and len(text) <= 64000, 400, 'A message can contain up to 64,000 characters.')
    text.encode()
    require(isinstance(sizes, list) and 0 < len(sizes) <= MAX_ATTACHMENTS and
            all(type(size) is int and size >= 4 for size in sizes) and sum(sizes) == remaining,
            400, 'Attach between 1 and 12 files or folders.')
    packets = [unpack(stream, size) for size in sizes]
    require(sum(packet[-1] for packet in packets) <= MAX_BYTES, 413, 'The attachment limit is 64 MiB.')
    return text, packets


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


def save(db, room, member, now, packet, announce=True):
    name, kind, mode, note, manifest, contents, size = packet
    existing = db.execute('SELECT * FROM assets WHERE room=? AND name=?', (room, name)).fetchone()
    if existing and mode == 'copy':
        name = copy_name(db, room, name, kind)
        if kind == 'file':
            manifest = {name: next(iter(manifest.values()))}
        existing = None
    if existing:
        require(mode == 'version' and existing['kind'] == kind, 409, 'An asset already uses this name.')
        asset = existing['id']
    else:
        asset = db.execute('INSERT INTO assets(room,name,kind) VALUES(?,?,?)', (room,name,kind)).lastrowid
    store_blobs(db, room, contents)
    if not announce:
        num = version(db, asset, member['nick'], now, note, manifest, size, '')
        return {'asset': asset, 'num': num, 'name': name, 'kind': kind, 'size': size}
    return revision(db, room, asset, member, now, note, manifest, size)


def share(db, room, member, now, text, packets):
    attachments = []
    for name, kind, _, _, manifest, blobs, size in packets:
        packet = (name, kind, 'copy', '', manifest, blobs, size)
        attachments.append(save(db, room, member, now, packet, announce=False))
    db.execute("INSERT INTO messages(room,kind,author,body,lang,created,sender,attachments) "
               "VALUES(?,'share',?,?,'',?,?,?)",
               (room, member['nick'], text, now, member['token'], json.dumps(attachments, ensure_ascii=False)))
    return {'attachments': attachments}


def store_blobs(db, room, contents):
    used = db.execute('SELECT coalesce(sum(length(data)),0) FROM blobs WHERE room=?', (room,)).fetchone()[0]
    for digest, data in contents.items():
        if db.execute('SELECT 1 FROM blobs WHERE room=? AND digest=?',(room,digest)).fetchone():
            continue
        used += len(data)
        require(used <= ROOM_BYTES, 413, 'This room has reached its 512 MiB storage limit.')
        db.execute('INSERT INTO blobs(room,digest,data) VALUES(?,?,?)', (room,digest,data))


def create_snippet(db, room, name):
    if db.execute('SELECT 1 FROM assets WHERE room=? AND name=?', (room, name)).fetchone():
        name = copy_name(db, room, name, 'code')
    return db.execute("INSERT INTO assets(room,name,kind) VALUES(?,?,'code')", (room, name)).lastrowid


def save_snippet(db, room, member, now, text, lang, data):
    asset = data.get('asset')
    if asset is None:
        name = data.get('title', '')
        require(isinstance(name, str) and len(name) <= 80, 400, 'A name can contain up to 80 characters.')
        asset = create_snippet(db, room, name.strip() or 'Code snippet')
    else:
        require(type(asset) is int and 0 < asset < 2**63, 400, 'Invalid code snippet.')
        require(db.execute("SELECT 1 FROM assets WHERE id=? AND room=? AND kind='code'",
                           (asset, room)).fetchone(), 404, 'Code snippet not found.')
    note = data.get('note', '')
    require(isinstance(note, str) and len(note) <= 200, 400, 'The version note is too long.')
    encoded = text.encode()
    digest = hashlib.sha256(encoded).hexdigest()
    store_blobs(db, room, {digest: encoded})
    return revision(db, room, asset, member, now, note.strip(), {CODE_PATH: digest}, len(encoded), text, lang)


def migrate_snippets(db):
    pending = db.execute("SELECT * FROM messages WHERE kind='code' AND asset IS NULL ORDER BY id").fetchall()
    for message in pending:
        room = message['room']
        asset = create_snippet(db, room, 'Code snippet')
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


def editable_text(db, room, digest):
    data = get_blob(db, room, digest, EDIT_LIMIT)
    if data is not None and b'\0' not in data:
        try:
            return data.decode()
        except UnicodeError:
            pass
    return None


def require_latest_version(db, row):
    latest = db.execute('SELECT max(num) FROM versions WHERE asset=?', (row['asset'],)).fetchone()[0]
    require(row['num'] == latest, 409, 'A newer version exists. Open the latest version to continue.')


def edit_text(db, room, row, manifest, path, member, now, text, note, lang):
    require_latest_version(db, row)
    original = editable_text(db, room, manifest[path])
    require(original is not None, 422, 'Only UTF-8 text files up to 256 KiB can be edited.')
    require(isinstance(text, str) and '\0' not in text, 400, 'Enter valid UTF-8 text.')
    require(isinstance(note, str) and len(note) <= 200, 400, 'The version note is too long.')
    snippet = row['kind'] == 'code'
    if snippet:
        require(text.strip() and len(text) <= 64000, 400, 'Code must contain between 1 and 64,000 characters.')
        require(isinstance(lang, str) and len(lang) <= 40, 400, 'Invalid language.')
    if original.replace('\r\n', '\n').replace('\r', '\n') == text and (not snippet or lang == row['lang']):
        return {'asset': row['asset'], 'num': row['num']}
    if '\r\n' in original and '\n' not in original.replace('\r\n', ''):
        text = text.replace('\r\n', '\n').replace('\n', '\r\n')
    encoded = text.encode()
    require(len(encoded) <= EDIT_LIMIT, 413, 'A file edited here can contain up to 256 KiB.')
    size = row['size'] - len(original.encode()) + len(encoded)
    require(size <= MAX_BYTES, 413, 'The asset would exceed the 64 MiB limit.')
    digest = hashlib.sha256(encoded).hexdigest()
    store_blobs(db, room, {digest: encoded})
    manifest[path] = digest
    filename = row['name'] if snippet else path
    return revision(db, room, row['asset'], member, now, note.strip() or f'Edited {filename}'[:200],
                    manifest, size, text if snippet else None, lang if snippet else '')


def update_folder(db, room, row, manifest, member, now, packet):
    require(row['kind'] == 'folder', 400, 'Select a folder.')
    require_latest_version(db, row)
    name, kind, mode, note, updates, contents, size = packet
    require(name == row['name'] and kind == 'folder' and mode is None and updates and
            all(digest is not None for digest in updates.values()), 400, 'Drop files into a folder.')
    require(len(manifest.keys() | updates.keys()) <= MAX_ENTRIES, 413, 'A folder can contain up to 10,000 items.')

    paths = sorted(manifest)
    merged_size = row['size'] + size
    for path in updates:
        prefix = path + '/'
        position = bisect_left(paths, prefix)
        require((position == len(paths) or not paths[position].startswith(prefix)) and
                (path not in manifest or manifest[path] is not None) and
                all(manifest.get(str(parent)) is None for parent in PurePosixPath(path).parents),
                400, 'The upload conflicts with a file or folder path.')
        if path in manifest:
            merged_size -= db.execute('SELECT length(data) FROM blobs WHERE room=? AND digest=?',
                                      (room, manifest[path])).fetchone()[0]
    require(merged_size <= MAX_BYTES, 413, 'The folder would exceed the 64 MiB limit.')
    store_blobs(db, room, contents)
    manifest.update(updates)
    if not note:
        note = f'Uploaded {next(iter(updates))}'[:200] if len(updates) == 1 else f'Uploaded {len(updates)} files'
    return revision(db, room, row['asset'], member, now, note, manifest, merged_size)


def snapshot(db, room, asset, num):
    row = db.execute('SELECT v.*,a.name,a.kind FROM versions v JOIN assets a ON a.id=v.asset '
                     'WHERE a.room=? AND a.id=? AND v.num=?', (room,asset,num)).fetchone()
    require(row, 404, 'Version not found.')
    return row, json.loads(row['manifest'])


def catalog(db, room):
    return [dict(row) for row in db.execute(
        'SELECT a.*,v.num,v.size,v.created,v.author,v.lang FROM assets a JOIN versions v ON v.asset=a.id '
        'WHERE a.room=? AND v.num=(SELECT max(num) FROM versions WHERE asset=a.id) '
        'ORDER BY v.created DESC,a.id DESC', (room,)
    )]


def search_paths(db, room, query, category, offset):
    query = unicodedata.normalize('NFC', query).casefold()
    items = [item for item in catalog(db, room)
             if category == 'all' or (item['kind'] == 'code') == (category == 'codes')]

    def matches():
        for item in items:
            if query in item['name'].casefold():
                yield {**item, 'path': '', 'entry_kind': item['kind']}
        for item in items:
            if item['kind'] != 'folder':
                continue
            _, manifest = snapshot(db, room, item['id'], item['num'])
            prefix = item['name'].casefold() + '/' if '/' in query else ''
            for path, digest in manifest.items():
                relative = path.casefold()
                if query in relative or (prefix and query in prefix + relative):
                    yield {**item, 'path': path, 'entry_kind': 'folder' if digest is None else 'file'}

    results = list(islice(matches(), offset, offset + SEARCH_PAGE + 1))
    return {'items': results[:SEARCH_PAGE], 'next': offset + SEARCH_PAGE if len(results) > SEARCH_PAGE else None}


def has_pdf_header(data):
    return b'%PDF-' in data[:1024]


def is_pdf(db, room, digest):
    header = db.execute('SELECT substr(data,1,1024) FROM blobs WHERE room=? AND digest=?', (room, digest)).fetchone()
    return bool(header and has_pdf_header(header[0]))


def companion_path(manifest, path, extension):
    stem = path.rsplit('.', 1)[0]
    exact = stem + extension
    if manifest.get(exact):
        return exact
    return next((candidate for candidate, digest in manifest.items() if digest and candidate.startswith(stem + '.')
                 and candidate[len(stem):].lower() == extension), None)


def preview(db, room, digest, path=''):
    suffix = PurePosixPath(path).suffix.lower() if path else ''
    if suffix == '.pdf':
        if is_pdf(db, room, digest):
            return {'type': 'pdf'}
        return {'type': 'binary', 'text': 'PDF preview unavailable. Download the file to open it.'}
    if suffix in ('.csv', '.tsv'):
        data = table_preview(db, room, digest, suffix)
        if data is not None:
            return data
    data = get_blob(db, room, digest, 5 * MIB)
    if data and (mime := raster_type(data)):
        return {'type': 'image', 'source': 'data:' + mime + ';base64,' + base64.b64encode(data).decode('ascii')}
    if data is not None and len(data) <= 256 * 1024:
        try:
            if data.startswith(b'PK\x03\x04') or data.startswith(b'PK\x05\x06'):
                with zipfile.ZipFile(io.BytesIO(data)) as z:
                    return {'type':'zip', 'text':'\n'.join(z.namelist()[:2048])}
            if b'\0' not in data:
                return {'type':'text', 'text':data.decode('utf-8')}
        except (UnicodeError, zipfile.BadZipFile):
            pass
    return {'type':'binary', 'text':'Preview unavailable. Download the file to open it.'}


def table_preview(db, room, digest, suffix):
    blob = db.execute('SELECT substr(data,1,?) AS sample,length(data) AS size FROM blobs WHERE room=? AND digest=?',
                      (TABLE_PREVIEW_BYTES, room, digest)).fetchone()
    if not blob:
        return None
    sample = blob['sample']
    source_limited = blob['size'] > len(sample)
    encoding = 'utf-16' if sample.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)) else 'utf-8-sig'
    try:
        source = codecs.getincrementaldecoder(encoding)().decode(sample, final=not source_limited)
    except UnicodeError:
        return None
    if '\0' in source:
        return None
    delimiter = '\t' if suffix == '.tsv' else ','
    if suffix == '.csv':
        try:
            delimiter = csv.Sniffer().sniff(source[:16384], delimiters=',;\t').delimiter
        except csv.Error:
            pass
    complete = source
    if source_limited:
        complete = source[:max(source.rfind('\n'), source.rfind('\r')) + 1]
    reader = csv.reader(io.StringIO(complete, newline=''), delimiter=delimiter, strict=True)
    entries = []
    columns = 0
    rows_limited = source_limited
    invalid = False
    try:
        for row in reader:
            if len(entries) == TABLE_ROWS:
                rows_limited = True
                break
            columns = max(columns, len(row))
            entries.append(row[:TABLE_COLUMNS])
    except csv.Error:
        invalid = not source_limited
    return {
        'type': 'table',
        'text': source,
        'rows': entries,
        'columns': min(columns, TABLE_COLUMNS),
        'rows_limited': rows_limited,
        'columns_limited': columns > TABLE_COLUMNS,
        'source_limited': source_limited,
        'invalid': invalid,
        'delimiter': delimiter,
    }


def raster_type(data):
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image/png'
    if data.startswith(b'\xff\xd8\xff'):
        return 'image/jpeg'
    if data.startswith((b'GIF87a', b'GIF89a')):
        return 'image/gif'
    if data.startswith(b'RIFF') and data[8:12] == b'WEBP':
        return 'image/webp'


def changes(old, new, details=False):
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
        item = {'path': path, 'state': state}
        if details:
            item['dir'] = (new[path] if path in new else old[path]) is None
        result.append(item)
    return result


def diff_lines(db, room, old, new, path):
    require(path in old or path in new, 404, 'File not found.')
    lines, endings = [], []
    for version in (old,new):
        digest = version.get(path)
        data = get_blob(db, room, digest, 64 * 1024) if digest else b''
        if data is None or b'\0' in data:
            return None, 'A text diff is unavailable for this file.'
        try:
            text = data.decode().replace('\r\n', '\n').replace('\r', '\n')
            endings.append(text.endswith('\n'))
            lines.append(text.removesuffix('\n').split('\n') if text else [])
        except UnicodeError:
            return None, 'Binary file.'
    if max(map(len, lines)) > 2000:
        return None, 'This file exceeds the 2,000-line diff limit.'
    message = ''
    if lines[0] == lines[1] and old.get(path) != new.get(path):
        if endings[0] != endings[1]:
            message = 'Final newline added.' if endings[1] else 'Final newline removed.'
        elif old.get(path) and new.get(path):
            message = 'Line endings changed.'
    return lines, message


def diff_text(db, room, old, new, path):
    lines, notice = diff_lines(db, room, old, new, path)
    if notice:
        return notice
    return ''.join(line+'\n' for line in
                   difflib.unified_diff(*lines, fromfile='previous', tofile='selected', lineterm='')) or 'No text changes.'


def diff_words(before, after):
    tokens = [re.findall(r'\w+|\s+|[^\w\s]', line) for line in (before, after)]
    if max(map(len, tokens)) > 256:
        return None
    old, new = tokens
    matcher = difflib.SequenceMatcher(None, old, new, autojunk=False)
    if not any(any(not token.isspace() for token in old[start:start + size])
               for start, _, size in matcher.get_matching_blocks()):
        return None
    left, right = [], []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        changed = tag != 'equal'
        if i1 != i2:
            left.append([''.join(old[i1:i2]), changed])
        if j1 != j2:
            right.append([''.join(new[j1:j2]), changed])
    return {'before': left, 'after': right}


def diff_blocks(db, room, old, new, path):
    lines, notice = diff_lines(db, room, old, new, path)
    if notice:
        return {'blocks': [], 'notice': notice}
    before, after = lines
    blocks = []
    for group in difflib.SequenceMatcher(None, before, after, autojunk=False).get_grouped_opcodes(3):
        block = []
        for tag, i1, i2, j1, j2 in group:
            left = enumerate(before[i1:i2], i1 + 1)
            right = enumerate(after[j1:j2], j1 + 1)
            for old_line, new_line in zip_longest(left, right):
                line = {
                    'before': list(old_line) if old_line else None,
                    'after': list(new_line) if new_line else None,
                    'changed': tag != 'equal',
                }
                if tag == 'replace' and old_line and new_line:
                    words = diff_words(old_line[1], new_line[1])
                    if words:
                        line['words'] = words
                block.append(line)
        blocks.append(block)
    return {'blocks': blocks, 'notice': '' if blocks else 'No text changes.'}


def archive(db, room, name, manifest):
    out = tempfile.TemporaryFile()
    try:
        with zipfile.ZipFile(out, 'w', zipfile.ZIP_STORED) as z:
            prefix = name+'/' if name else ''
            if prefix:
                z.writestr(prefix, b'')
            for path, digest in manifest.items():
                full = prefix+path
                if digest is None:
                    z.writestr(full+'/', b'')
                else:
                    z.writestr(full, get_blob(db, room, digest))
        out.seek(0)
        return out
    except BaseException:
        out.close()
        raise
