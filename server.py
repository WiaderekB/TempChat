import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import sqlite3
import threading
import time
import traceback
from collections import deque
from contextlib import closing
from http import HTTPStatus
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import parse_qs, quote
from wsgiref.simple_server import make_server
from wsgiref.util import FileWrapper

import assets
from assets import Problem, require

ROOT = Path(__file__).resolve().parent
PRESENCE = 90
STATIC = {'/': 'index.html', '/admin': 'index.html', '/app.js': 'app.js',
          '/files.js': 'files.js', '/ui.js': 'ui.js', '/style.css': 'style.css',
          '/asset-view.js': 'asset-view.js',
          '/markdown.mjs': 'markdown.mjs', '/vendor/markdown-it.mjs': 'vendor/markdown-it.mjs'}
MIME = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css'}


def rows(cursor):
    return [dict(row) for row in cursor]


def field(data, key, limit):
    value = data.get(key)
    require(isinstance(value,str) and value.strip() and len(value) <= limit, 400, 'Check the information you entered.')
    return value.strip()


def retention(data):
    hours = data.get('hours',24)
    require(type(hours) is int and 1 <= hours <= 8760, 400, 'Choose a retention period between 1 and 8,760 hours.')
    return hours


def token_hash(value):
    return hashlib.sha256(value.encode()).hexdigest()


class Request:
    def __init__(self, env):
        self.env = env
        self.path = env['PATH_INFO']
        self.method = env['REQUEST_METHOD']
        self.query = parse_qs(env['QUERY_STRING'])
        self.stream = env['wsgi.input']
        self.length = int(env.get('CONTENT_LENGTH') or 0)
        self.cookies = SimpleCookie()
        self.cookies.load(env.get('HTTP_COOKIE',''))
        self.headers = []

    def cookie(self, key):
        item = self.cookies.get(key)
        return token_hash(item.value if item else '')

    def body(self):
        require(0 < self.length <= 300000, 413, 'Invalid request size.')
        value = json.loads(self.stream.read(self.length))
        require(isinstance(value,dict), 400, 'Invalid request data.')
        return value

    def arg(self, key, default=''):
        return self.query.get(key, [default])[0]


class App:
    def __init__(self, directory, password, origin, sweep=True, trusted_proxy=''):
        require(12 <= len(password) <= 1024, 500, 'Set ADMIN_PASSWORD to between 12 and 1,024 characters.')
        self.password = token_hash(password)
        self.origin = origin.rstrip('/')
        self.trusted_proxy = ipaddress.ip_network(trusted_proxy, strict=False) if trusted_proxy else None
        Path(directory).mkdir(parents=True, exist_ok=True)
        self.database = str(Path(directory) / 'rooms.sqlite3')
        self.limits = {}
        self.limit_lock = threading.Lock()
        self.uploads = threading.BoundedSemaphore(3)
        with closing(self.connect()) as db:
            db.executescript((ROOT/'schema.sql').read_text())
            with db:
                db.execute('BEGIN IMMEDIATE')
                for table, name, declaration in (
                    ('messages', 'sender', 'TEXT'),
                    ('versions', 'lang', "TEXT NOT NULL DEFAULT ''"),
                ):
                    columns = {column['name'] for column in db.execute(f'PRAGMA table_info({table})')}
                    if name not in columns:
                        db.execute(f'ALTER TABLE {table} ADD COLUMN {name} {declaration}')
                assets.migrate_snippets(db)
        if sweep:
            threading.Thread(target=self.sweeper,daemon=True).start()

    def connect(self):
        db = sqlite3.connect(self.database, timeout=30, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        db.execute('PRAGMA secure_delete=ON')
        return db

    def clean(self, db, now):
        db.execute('DELETE FROM rooms WHERE expires<=?', (now,))
        db.execute('DELETE FROM admins WHERE expires<=?', (now,))

    def sweeper(self):
        while True:
            try:
                with closing(self.connect()) as db:
                    self.clean(db, int(time.time()))
            except sqlite3.Error:
                traceback.print_exc()
            time.sleep(30)

    def throttle(self, req, action, limit):
        now = time.monotonic()
        identity = req.env.get('REMOTE_ADDR','')
        if self.trusted_proxy and identity:
            try:
                if ipaddress.ip_address(identity) in self.trusted_proxy:
                    identity = str(ipaddress.ip_address(req.env.get('HTTP_X_REAL_IP', '')))
            except ValueError:
                pass
        key = (action,identity)
        with self.limit_lock:
            if len(self.limits) > 512:
                self.limits = {k:q for k,q in self.limits.items() if q and q[-1]>now-60}
            q = self.limits.setdefault(key, deque())
            while q and q[0] <= now-60:
                q.popleft()
            require(len(q)<limit, 429, 'Too many attempts. Try again in a minute.')
            q.append(now)

    def set_cookie(self, req, name, value, path, age=None):
        flags = f'{name}={value}; HttpOnly; SameSite=Strict; Path={path}'
        if self.origin.startswith('https://'):
            flags += '; Secure'
        if age is not None:
            flags += f'; Max-Age={age}'
        req.headers.append(('Set-Cookie',flags))

    def __call__(self, env, start_response):
        status, extra = 200, []
        try:
            req = Request(env)
            result = self.dispatch(req)
            extra = req.headers
            if isinstance(result, tuple):
                mime, payload = result
            else:
                mime, payload = 'application/json; charset=utf-8', json.dumps(result, ensure_ascii=False).encode()
        except (Problem, ValueError, UnicodeError, RecursionError) as err:
            status = err.status if isinstance(err, Problem) else 400
            message = str(err) if isinstance(err, Problem) else 'Invalid request data.'
            mime, payload = 'application/json', json.dumps({'error': message}).encode()
        except Exception:
            traceback.print_exc()
            status, mime, payload = 500, 'application/json', b'{"error":"Server error."}'
        headers = [('Content-Type',mime),('Cache-Control','no-store'),
                   ('Referrer-Policy','no-referrer'),('X-Content-Type-Options','nosniff'),
                   ('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")]
        if isinstance(payload,bytes):
            headers.append(('Content-Length',str(len(payload))))
            body = [payload]
        else:
            body = FileWrapper(payload,64*1024)
        start_response(f'{status} {HTTPStatus(status).phrase}', headers + extra)
        return body

    def dispatch(self, req):
        path, method = req.path, req.method
        if method == 'GET' and (path in STATIC or re.fullmatch(r'/r/[0-9]{6}',path)):
            name = STATIC.get(path, 'index.html')
            return MIME[Path(name).suffix] + '; charset=utf-8', (ROOT/'web'/name).read_bytes()
        if path == '/api/health' and method == 'GET':
            with closing(self.connect()) as db:
                db.execute('SELECT code FROM rooms LIMIT 1').fetchone()
            return {'ok':True}
        if method != 'GET':
            require(req.env.get('HTTP_X_TEMPCHAT') == '1' and req.env.get('HTTP_ORIGIN', self.origin) == self.origin,
                    403, 'Request origin is not allowed.')
        now = int(time.time())
        with closing(self.connect()) as db, db:
            if path.startswith('/api/admin/'):
                return self.admin(db,req,now)
            match = re.fullmatch(r'/api/room/([0-9]{6})/(.+)',path)
            require(match,404,'Not found.')
            room, action = match.groups()
            if method == 'POST' and action == 'assets':
                self.member(db,req,room,now)
                require(self.uploads.acquire(blocking=False),503,'Other uploads are in progress. Try again shortly.')
                try:
                    packet = assets.unpack(req.stream,req.length)
                    db.execute('BEGIN IMMEDIATE')
                    saved_at = int(time.time())
                    member = self.member(db,req,room,saved_at)
                    return assets.save(db,room,member,saved_at,packet)
                finally:
                    self.uploads.release()
            db.execute('BEGIN IMMEDIATE' if method != 'GET' or action == 'state' else 'BEGIN')
            if action == 'join' and method == 'POST':
                self.throttle(req,'join',45)
                self.room(db,room,now)
                nick = field(req.body(),'nick',40)
                token = secrets.token_urlsafe(32)
                db.execute('DELETE FROM members WHERE token=? AND room=?',(req.cookie('member'),room))
                db.execute('INSERT INTO members VALUES(?,?,?,?)',(token_hash(token),room,nick,now))
                self.touch(db,room,now)
                self.set_cookie(req,'member',token,f'/api/room/{room}/')
                return {'code':room}
            member = self.member(db,req,room,now)
            nick = member['nick']
            if action == 'state' and method == 'GET':
                if now-member['seen']>=15:
                    db.execute('UPDATE members SET seen=? WHERE token=?',(now,member['token']))
                    self.touch(db,room,now)
                info = self.room(db,room,now)
                people = [r[0] for r in db.execute('SELECT nick FROM members WHERE room=? AND seen>? ORDER BY nick',(room,now-PRESENCE))]
                return {'room':dict(info),'nick':nick,'people':people,
                        'last':db.execute('SELECT coalesce(max(id),0) FROM messages WHERE room=?',(room,)).fetchone()[0]}
            if action == 'leave' and method == 'POST':
                db.execute('DELETE FROM members WHERE token=?',(member['token'],))
                if not db.execute('SELECT 1 FROM members WHERE room=? AND seen>?',(room, now-PRESENCE)).fetchone():
                    db.execute('UPDATE rooms SET expires=?+hours*3600 WHERE code=?',(now,room))
                self.set_cookie(req,'member','',f'/api/room/{room}/',0)
                return {'ok':True}
            if action == 'messages':
                if method == 'POST':
                    data = req.body()
                    kind = data.get('kind')
                    require(kind in ('text','code'),400,'Choose a message type.')
                    body = data.get('body')
                    require(isinstance(body,str) and body.strip() and len(body)<=64000,400,'A message must be between 1 and 64,000 characters.')
                    lang = data.get('lang','')
                    require(isinstance(lang,str) and len(lang)<=40,400,'Invalid language.')
                    if kind == 'code':
                        return assets.save_snippet(db, room, member, now, body, lang, data)
                    db.execute("INSERT INTO messages(room,kind,author,body,lang,created,sender) VALUES(?,?,?,?,?,?,?)",
                               (room,kind,nick,body,'',now,member['token']))
                    return {'ok':True}
                if method == 'GET':
                    return self.messages(db,req,room,member['token'])
            if action == 'catalog' and method == 'GET':
                items = rows(db.execute('SELECT a.*,v.num,v.size,v.created,v.author,v.lang FROM assets a JOIN versions v '
                    'ON v.asset=a.id WHERE a.room=? AND v.num=(SELECT max(num) FROM versions WHERE asset=a.id) ORDER BY v.created DESC,a.id DESC',(room,)))
                return {'files': [item for item in items if item['kind'] != 'code'],
                        'codes': [item for item in items if item['kind'] == 'code']}
            code = re.fullmatch(r'code/(\d+)',action)
            if code and method == 'GET':
                row = db.execute("SELECT id,author,body,lang,created,asset,num FROM messages "
                                 "WHERE room=? AND kind='code' AND id=?", (room,code[1])).fetchone()
                require(row,404,'Code snippet not found.')
                return dict(row)
            return self.asset_action(db,req,room,member,now,action)

    @staticmethod
    def room(db,room,now):
        item = db.execute('SELECT * FROM rooms WHERE code=? AND expires>?',(room,now)).fetchone()
        require(item,404,'Room not found. Check the code or ask the host if the room is still open.')
        return item

    def member(self,db,req,room,now):
        self.room(db,room,now)
        row = db.execute('SELECT * FROM members WHERE room=? AND token=?',(room,req.cookie('member'))).fetchone()
        require(row,401,'Enter a nickname to join the room.')
        return row

    @staticmethod
    def touch(db,room,now):
        db.execute('UPDATE rooms SET expires=?+hours*3600 WHERE code=?',(now+PRESENCE,room))

    @staticmethod
    def messages(db,req,room,token):
        query = ('SELECT m.id,m.room,m.kind,m.author,m.body,m.lang,m.asset,m.num,m.created,a.name,a.kind AS asset_kind,'
                 'coalesce(m.sender=?,0) AS mine FROM messages m LEFT JOIN assets a ON a.id=m.asset WHERE m.room=?')
        if req.arg('after'):
            return rows(db.execute(query+' AND m.id>? ORDER BY m.id LIMIT 80',(token,room,int(req.arg('after')))))
        return rows(db.execute(query+' AND m.id<? ORDER BY m.id DESC LIMIT 80',(token,room,int(req.arg('before',str(2**63-1))))))[::-1]

    def admin(self,db,req,now):
        action = req.path.removeprefix('/api/admin/')
        method = req.method
        db.execute('BEGIN IMMEDIATE' if method != 'GET' else 'BEGIN')
        if action == 'login' and method == 'POST':
            self.throttle(req,'admin',8)
            password = req.body().get('password')
            require(isinstance(password, str) and len(password) <= 1024 and
                    hmac.compare_digest(self.password, token_hash(password)), 401, 'Incorrect admin password.')
            token = secrets.token_urlsafe(32)
            db.execute('DELETE FROM admins WHERE token=?', (req.cookie('admin'),))
            db.execute('INSERT INTO admins VALUES(?,?)',(token_hash(token),now+43200))
            self.set_cookie(req,'admin',token,'/api/admin/',43200)
            return {'ok':True}
        require(db.execute('SELECT 1 FROM admins WHERE token=? AND expires>?',(req.cookie('admin'),now)).fetchone(),401,'Log in to the admin panel.')
        if action == 'logout' and method == 'POST':
            db.execute('DELETE FROM admins WHERE token=?',(req.cookie('admin'),))
            self.set_cookie(req,'admin','','/api/admin/',0)
            return {'ok':True}
        if action == 'rooms' and method == 'GET':
            return rows(db.execute('SELECT r.*,(SELECT count(*) FROM members WHERE room=r.code AND seen>?) AS online '
                                   'FROM rooms r WHERE expires>? ORDER BY created DESC,code',(now-PRESENCE,now)))
        if action == 'rooms' and method == 'POST':
            data = req.body()
            name, hours = field(data,'title',80), retention(data)
            while True:
                code = f'{secrets.randbelow(1000000):06}'
                if not db.execute('SELECT 1 FROM rooms WHERE code=?',(code,)).fetchone():
                    break
            db.execute('INSERT INTO rooms VALUES(?,?,?,?,?)',(code,name,hours,now,now+hours*3600))
            return {'code':code}
        match = re.fullmatch(r'rooms/(\d{6})',action)
        if match:
            room = self.room(db,match[1],now)
            if method == 'GET':
                return dict(room)
            if method == 'PATCH':
                data = req.body()
                require('title' in data or 'hours' in data, 400, 'Provide a room name or retention period.')
                title = field(data, 'title', 80) if 'title' in data else room['title']
                hours = retention(data) if 'hours' in data else room['hours']
                expires = room['expires'] + 3600 * (hours - room['hours'])
                db.execute('UPDATE rooms SET title=?,hours=?,expires=? WHERE code=?',
                           (title, hours, expires, room['code']))
                return {'ok': True, 'room': {**dict(room), 'title': title, 'hours': hours, 'expires': expires}}
            if method == 'DELETE':
                db.execute('DELETE FROM rooms WHERE code=?',(room['code'],))
                return {'ok':True}
        raise Problem(404,'Not found.')

    def asset_action(self,db,req,room,member,now,action):
        match = re.fullmatch(r'assets/(\d+)(?:/(\d+)/(download|preview|changes|restore))?',action)
        require(match,404,'Asset not found.')
        asset, num, op = match.groups()
        if not op and req.method == 'GET':
            obj = db.execute('SELECT * FROM assets WHERE id=? AND room=?',(asset,room)).fetchone()
            require(obj,404,'Asset not found.')
            history = rows(db.execute('SELECT num,author,created,note,size,lang FROM versions WHERE asset=? ORDER BY num DESC',(asset,)))
            return {**dict(obj),'history':history}
        row, manifest = assets.snapshot(db,room,asset,num)
        path = req.arg('path')
        if op == 'restore' and req.method == 'POST':
            snippet = None
            if row['kind'] == 'code':
                snippet = assets.get_blob(db, room, manifest[assets.CODE_PATH]).decode()
            return assets.revision(db,room,asset,member,now,f'Restored v{num}',manifest,row['size'],snippet,row['lang'])
        require(req.method == 'GET' and op != 'restore',405,'Method not allowed.')
        if op == 'changes':
            base = req.arg('from', str(int(num)-1))
            require(re.fullmatch(r'[0-9]{1,19}', base) and int(base) < int(num),
                    400, 'Choose an earlier version to compare.')
            old = assets.snapshot(db, room, asset, int(base))[1] if int(base) else {}
            if path:
                if req.arg('format') == 'split':
                    return assets.diff_blocks(db, room, old, manifest, path)
                return {'text':assets.diff_text(db,room,old,manifest,path)}
            return assets.changes(old, manifest, details=req.arg('format') == 'split')
        if op == 'preview' and not path and row['kind']=='folder':
            return {'type':'folder','entries':[{'path':p,'dir':v is None} for p,v in sorted(manifest.items())]}
        if not path and row['kind'] != 'folder':
            path = next(iter(manifest))
        if path:
            require(manifest.get(path),404,'File not found.')
            if op == 'preview':
                if row['kind'] == 'code':
                    return {'type': 'text', 'text': assets.get_blob(db, room, manifest[path]).decode(), 'lang': row['lang']}
                return assets.preview(db,room,manifest[path])
            payload = assets.get_blob(db,room,manifest[path])
            filename = row['name'] + '.txt' if row['kind'] == 'code' else path.split('/')[-1]
        else:
            payload = assets.archive(db,room,row['name'],manifest)
            filename = row['name']+'.zip'
        req.headers.append(('Content-Disposition',"attachment; filename*=UTF-8''"+quote(filename,safe='')))
        return 'application/octet-stream',payload


def create():
    return App(os.getenv('DATA_DIR','data'), os.environ['ADMIN_PASSWORD'],
               os.getenv('APP_URL','http://localhost:3087'), trusted_proxy=os.getenv('TRUSTED_PROXY', ''))


if __name__ == '__main__':
    from socketserver import ThreadingMixIn
    from wsgiref.simple_server import WSGIServer

    class LocalServer(ThreadingMixIn, WSGIServer):
        daemon_threads = True

    with make_server('127.0.0.1',int(os.getenv('PORT','3087')),create(),server_class=LocalServer) as server:
        server.serve_forever()
