import base64
import io
import json
import sqlite3
import tempfile
import time
import unittest
import zipfile
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from http.cookies import SimpleCookie
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit
from wsgiref.util import setup_testing_defaults

import assets
from server import App

ORIGIN = 'https://rooms.example.test'
PASSWORD = 'testowe hasło 24 '


def make_packet(name, kind, entries, mode=None, note=''):
    meta = {
        'name': name,
        'kind': kind,
        'mode': mode,
        'note': note,
        'entries': [{'path': path, 'size': len(data) if data is not None else None}
                    for path, data in entries.items()],
    }
    header = json.dumps(meta).encode()
    return len(header).to_bytes(4, 'big') + header + b''.join(data for data in entries.values() if data is not None)


class Client:
    def __init__(self, app):
        self.app = app
        self.cookies = {}

    def call(self, method, path, data=None, origin=ORIGIN):
        if isinstance(data, bytes):
            payload = data
        else:
            payload = json.dumps(data).encode() if data is not None else b''
        target = urlsplit(path)
        cookie = '; '.join(pair for (prefix, _), pair in self.cookies.items() if target.path.startswith(prefix))
        env = {}
        setup_testing_defaults(env)
        env.update(REQUEST_METHOD=method, PATH_INFO=target.path, QUERY_STRING=target.query,
                   CONTENT_LENGTH=str(len(payload)), HTTP_COOKIE=cookie, HTTP_ORIGIN=origin, HTTP_X_TEMPCHAT='1')
        env['wsgi.input'] = io.BytesIO(payload)
        result = {}

        def start(status, headers):
            result.update(status=int(status.split()[0]), headers=dict(headers))

        response = self.app(env, start)
        try:
            body = b''.join(response)
        finally:
            if hasattr(response, 'close'):
                response.close()
        headers = result['headers']
        if headers.get('Set-Cookie'):
            jar = SimpleCookie(headers['Set-Cookie'])
            for name, item in jar.items():
                key = (item['path'], name)
                if item['max-age'] == '0':
                    self.cookies.pop(key, None)
                else:
                    self.cookies[key] = f'{name}={item.value}'
        if headers['Content-Type'].startswith('application/json'):
            body = json.loads(body)
        return result['status'], body, headers


class TempChatTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = directory.name
        self.app = App(directory.name, PASSWORD, ORIGIN, sweep=False)
        self.admin, self.ala, self.ola = [Client(self.app) for _ in range(3)]

    def call(self, client, expected, method, path, data=None, **kwargs):
        status, body, _ = client.call(method, path, data, **kwargs)
        self.assertEqual(status, expected, body if type(body) is not bytes else body[:150])
        return body

    def room(self, hours=24):
        self.call(self.admin, 200, 'POST', '/api/admin/login', {'password': PASSWORD})
        room = self.call(self.admin, 200, 'POST', '/api/admin/rooms', {'title': 'Projekt', 'hours': hours})
        self.code = room['code']
        self.base = '/api/room/' + self.code + '/'
        self.call(self.ala, 200, 'POST', self.base + 'join', {'nick': 'Ala'})
        return self.base

    def save(self, data, expected=200, client=None):
        return self.call(client or self.ala, expected, 'POST', self.base + 'assets', data)

    def test_static_pages_and_health(self):
        for path in ('/', '/admin', '/r/001234', '/app.js', '/asset-view.js', '/files.js', '/ui.js', '/style.css',
                     '/markdown.mjs', '/vendor/markdown-it.mjs', '/vendor/fonts/FiraCode-Regular.woff2',
                     '/pdf-preview.js', '/vendor/pdfjs/pdf.min.mjs', '/vendor/pdfjs/pdf.worker.min.mjs'):
            with self.subTest(path=path):
                self.assertTrue(self.call(self.ala, 200, 'GET', path))
        self.assertIn(b'<html lang="en">', self.call(self.ala, 200, 'GET', '/'))
        self.assertEqual(self.call(self.ala, 200, 'GET', '/api/health'), {'ok': True})

    def test_edit_nested_file_creates_folder_version_without_replacing_unchanged_line(self):
        base = self.room()
        data = self.save(make_packet('Project', 'folder', {
            'docs/example.txt': b'www\nSuper mega test hey!', 'docs/keep.txt': b'keep',
            'image.dat': b'\0',
        }))
        url = base + f'assets/{data["asset"]}/'
        query = '?path=docs/example.txt'
        self.assertTrue(self.call(self.ala, 200, 'GET', url + '1/preview' + query)['editable'])
        edit = self.call(self.ala, 200, 'GET', url + '1/edit' + query)
        self.call(self.ola, 401, 'POST', url + '1/edit' + query, edit)
        self.call(self.ala, 422, 'POST', url + '1/edit?path=image.dat', edit)
        self.assertEqual(self.call(self.ala, 200, 'POST', url + '1/edit' + query, edit)['num'], 1)
        edit['text'] += '\n\naaaa'
        revision = self.call(self.ala, 200, 'POST', url + '1/edit' + query, edit)
        self.assertEqual(revision['num'], 2)
        self.call(self.ala, 409, 'POST', url + '1/edit' + query, {'text': 'stale edit'})
        self.assertEqual(self.call(self.ala, 200, 'GET', url + '2/download?path=docs/keep.txt'), b'keep')
        self.assertEqual(self.call(self.ala, 200, 'GET', url + '1/download' + query), b'www\nSuper mega test hey!')
        self.assertEqual(self.call(self.ala, 200, 'GET', url + '2/download' + query), edit['text'].encode())
        diff = self.call(self.ala, 200, 'GET', url + '2/changes' + query + '&format=split')
        self.assertEqual(diff['blocks'][0][1], {
            'before': [2, 'Super mega test hey!'], 'after': [2, 'Super mega test hey!'], 'changed': False,
        })
        self.assertEqual([item['after'] for item in diff['blocks'][0] if item['changed']], [[3, ''], [4, 'aaaa']])
        self.call(self.ala, 200, 'POST', url + '2/edit' + query, {'text': edit['text'] + '\n'})
        diff = self.call(self.ala, 200, 'GET', url + '3/changes' + query + '&format=split')
        self.assertEqual(diff['notice'], 'Final newline added.')

    def test_upload_to_tree_commits_only_dropped_paths_and_rejects_stale_versions(self):
        base = self.room()
        project = self.save(make_packet('Project', 'folder', {
            'docs/readme.md': b'old', 'docs/keep.txt': b'keep',
            'empty': None, 'notes.txt': b'notes',
        }))
        url = base + f'assets/{project["asset"]}/'
        updates = make_packet('Project', 'folder', {
            'docs/readme.md': b'\0replacement', 'docs/new.txt': b'',
        })
        self.call(self.ola, 401, 'POST', url + '1/files', updates)
        for path in ('empty', 'docs', 'notes.txt/nested'):
            with self.subTest(path=path):
                collision = make_packet('Project', 'folder', {'unrelated.txt': b'extra', path: b'conflict'})
                self.call(self.ala, 400, 'POST', url + '1/files', collision)
        revision = self.call(self.ala, 200, 'POST', url + '1/files', updates)
        self.assertEqual(revision['num'], 2)
        self.call(self.ala, 409, 'POST', url + '1/files', updates)
        self.assertEqual(self.call(self.ala, 200, 'GET', url + '1/download?path=docs/readme.md'), b'old')
        self.assertEqual(self.call(self.ala, 200, 'GET', url + '2/download?path=docs/readme.md'), b'\0replacement')
        self.assertEqual(self.call(self.ala, 200, 'GET', url + '2/download?path=docs/new.txt'), b'')
        self.assertEqual(self.call(self.ala, 200, 'GET', url + '2/download?path=docs/keep.txt'), b'keep')
        self.call(self.ala, 404, 'GET', url + '2/download?path=unrelated.txt')
        changes = self.call(self.ala, 200, 'GET', url + '2/changes')
        self.assertEqual(changes, [{'path': 'docs/new.txt', 'state': 'added'}, {'path': 'docs/readme.md', 'state': 'changed'}])
        history = self.call(self.ala, 200, 'GET', url.rstrip('/'))['history']
        self.assertEqual(history[0]['size'], len(b'\0replacementkeepnotes'))

    def test_latex_compiles_the_selected_snapshot_with_its_dependencies(self):
        base = self.room()
        draft = b'first version'
        project = {'chapters/main.tex': draft, 'figures/diagram.png': b'figure'}
        created = self.save(make_packet('Project', 'folder', project))
        self.save(make_packet('Project', 'folder', {**project, 'chapters/main.tex': b'new'}, mode='version'))
        prefix = base + f'assets/{created["asset"]}/1/'
        tex = '?path=chapters/main.tex'
        self.assertNotIn('latex', self.call(self.ala, 200, 'GET', prefix + 'preview' + tex))
        self.app.tex_socket = '/test/worker.sock'
        self.assertTrue(self.call(self.ala, 200, 'GET', prefix + 'preview' + tex)['latex'])
        self.call(self.ola, 401, 'POST', prefix + 'latex' + tex)
        self.call(self.ala, 405, 'GET', prefix + 'latex' + tex)
        self.call(self.ala, 400, 'POST', prefix + 'latex?path=figures/diagram.png')
        self.call(self.ala, 400, 'POST', prefix + 'latex' + tex + '&engine=invalid')

        def compile_version(socket_path, package, entry, engine):
            self.assertEqual((socket_path, entry, engine), ('/test/worker.sock', 'chapters/main.tex', 'xelatex'))
            with zipfile.ZipFile(package) as archive:
                self.assertEqual({path: archive.read(path) for path in archive.namelist()}, project)
            return b'%PDF-1.5'

        with patch('server.request_pdf', side_effect=compile_version):
            status, pdf, headers = self.ala.call('POST', prefix + 'latex' + tex + '&engine=xelatex')
            self.assertEqual((status, pdf, headers['Content-Type']), (200, b'%PDF-1.5', 'application/pdf'))
            self.assertTrue(headers['Content-Disposition'].endswith('main.pdf'))

    def test_uploaded_pdf_and_tex_companion_use_the_selected_folder_version(self):
        base = self.room()
        tex = br'\documentclass{article}'
        pdf = b'%PDF-1.7\nuploaded document'
        project = self.save(make_packet('Reports', 'folder', {
            'draft/report.tex': tex, 'draft/report.PDF': pdf, 'draft/invalid.pdf': b'invalid',
        }))
        self.save(make_packet('Reports', 'folder', {'draft/report.tex': tex}, mode='version'))
        url = base + f'assets/{project["asset"]}/'
        source = self.call(self.ala, 200, 'GET', url + '1/preview?path=draft/report.tex')
        self.assertEqual((source['text'], source['pdf_path']), (tex.decode(), 'draft/report.PDF'))
        self.assertNotIn('latex', source)
        new_source = self.call(self.ala, 200, 'GET', url + '2/preview?path=draft/report.tex')
        self.assertNotIn('pdf_path', new_source)
        preview = self.call(self.ala, 200, 'GET', url + '1/preview?path=draft/report.PDF')
        self.assertEqual(preview, {'type': 'pdf', 'tex_path': 'draft/report.tex'})
        download = url + '1/download?path=draft/report.PDF'
        self.call(self.ola, 401, 'GET', download)
        status, body, headers = self.ala.call('GET', download)
        self.assertEqual((status, body, headers['Content-Type']), (200, pdf, 'application/pdf'))
        self.assertTrue(headers['Content-Disposition'].startswith('attachment;'))
        invalid = self.call(self.ala, 200, 'GET', url + '1/preview?path=draft/invalid.pdf')
        self.assertEqual(invalid['type'], 'binary')

        standalone = self.save(make_packet('standalone.pdf', 'file', {'standalone.pdf': pdf}))
        prefix = base + f'assets/{standalone["asset"]}/1/'
        self.assertEqual(self.call(self.ala, 200, 'GET', prefix + 'preview'), {'type': 'pdf'})
        self.assertEqual(self.call(self.ala, 200, 'GET', prefix + 'download'), pdf)

    def test_word_diff_marks_only_the_changed_text(self):
        self.assertEqual(assets.diff_words('Zmień szerokość na 12.', 'Zmień szerokość na 18.'), {
            'before': [['Zmień szerokość na ', False], ['12', True], ['.', False]],
            'after': [['Zmień szerokość na ', False], ['18', True], ['.', False]],
        })

    def test_admin_access_and_origin(self):
        path = '/api/admin/login'
        self.call(self.ala, 401, 'GET', '/api/admin/rooms')
        rejected = self.call(self.ala, 401, 'POST', path, {'password': 'złe hasło'})
        self.assertEqual(rejected['error'], 'Incorrect admin password.')
        self.call(self.ala, 403, 'POST', path, {'password': PASSWORD}, origin='https://other.example.test')
        status, _, headers = self.ala.call('POST', path, {'password': PASSWORD})
        self.assertEqual(status, 200)
        self.assertIn('HttpOnly; SameSite=Strict; Path=/api/admin/; Secure', headers['Set-Cookie'])
        self.call(self.ala, 200, 'POST', '/api/admin/logout')
        self.call(self.ala, 401, 'GET', '/api/admin/rooms')

    def test_two_participants_and_room_isolation(self):
        base = self.room()
        self.call(self.ola, 401, 'GET', base + 'messages')
        self.call(self.ola, 200, 'POST', base + 'join', {'nick': 'Ola'})
        self.assertEqual(self.call(self.ala, 200, 'GET', base + 'state')['people'], ['Ala', 'Ola'])
        self.call(self.ala, 200, 'POST', base + 'messages', {'kind': 'text', 'body': 'Cześć'})
        self.call(self.ola, 200, 'POST', base + 'messages',
                  {'kind': 'code', 'lang': 'python', 'body': 'print("dzień dobry")\n'})
        chat = self.call(self.ala, 200, 'GET', base + 'messages')
        self.assertEqual([(m['author'], m['kind']) for m in chat], [('Ala', 'text'), ('Ola', 'code')])
        self.assertEqual([m['mine'] for m in chat], [1, 0])
        self.assertEqual([m['mine'] for m in self.call(self.ola, 200, 'GET', base + 'messages')], [0, 1])
        self.assertNotIn('sender', chat[0])
        snippets = self.call(self.ala, 200, 'GET', base + 'catalog')['codes']
        self.assertEqual(snippets[0]['id'], chat[1]['asset'])
        self.assertEqual(snippets[0]['name'], 'Code snippet')
        item = self.call(self.ala, 200, 'GET', base + f'code/{chat[1]["id"]}')
        self.assertEqual(item['body'], 'print("dzień dobry")\n')
        self.assertNotIn('sender', item)
        other = self.call(self.admin, 200, 'POST', '/api/admin/rooms', {'title': 'Osobny pokój'})
        other_base = '/api/room/' + other['code'] + '/'
        self.call(self.ala, 200, 'POST', other_base + 'join', {'nick': 'Ala'})
        self.call(self.ala, 404, 'GET', other_base + f'code/{item["id"]}')
        self.call(self.ola, 200, 'POST', base + 'leave')
        self.assertEqual(self.call(self.ala, 200, 'GET', base + 'state')['people'], ['Ala'])

    def test_same_nick_and_long_message(self):
        base = self.room()
        self.call(self.ola, 200, 'POST', base + 'join', {'nick': 'Ala'})
        text = 'Akapit numer jeden.\n\n' * 100
        self.call(self.ala, 200, 'POST', base + 'messages', {'kind': 'text', 'body': text})
        item = self.call(self.ola, 200, 'GET', base + 'messages')[0]
        self.assertEqual(item['body'], text)
        self.assertFalse(item['mine'])

    def test_named_code_versions_diff_and_restore(self):
        base = self.room()
        self.call(self.ola, 200, 'POST', base + 'join', {'nick': 'Ola'})
        first = self.call(self.ala, 200, 'POST', base + 'messages',
                          {'kind': 'code', 'title': 'Pierwsza funkcja', 'lang': 'python', 'body': 'print(1)\n'})
        asset = first['asset']
        url = base + f'assets/{asset}'
        self.call(self.ola, 200, 'POST', base + 'messages',
                  {'kind': 'code', 'asset': asset, 'lang': 'js', 'body': 'console.log(2)\n', 'note': 'Zmiana języka'})
        history = self.call(self.ala, 200, 'GET', url)['history']
        self.assertEqual([(row['num'], row['lang']) for row in history], [(2, 'js'), (1, 'python')])
        self.assertEqual(history[0]['note'], 'Zmiana języka')
        diff = self.call(self.ala, 200, 'GET', url + '/2/changes?path=fragment')['text']
        self.assertTrue(diff.startswith('--- previous\n+++ selected\n'))
        self.assertIn('-print(1)\n+console.log(2)', diff)
        self.assertEqual(self.call(self.ala, 200, 'POST', url + '/1/restore')['num'], 3)
        restored = self.call(self.ala, 200, 'GET', url + '/3/preview')
        self.assertEqual(restored, {'type': 'text', 'text': 'print(1)\n', 'lang': 'python'})
        catalog = self.call(self.ala, 200, 'GET', base + 'catalog')
        self.assertEqual(catalog['files'], [])
        self.assertEqual([(row['name'], row['num']) for row in catalog['codes']], [('Pierwsza funkcja', 3)])
        history = self.call(self.ala, 200, 'GET', base + 'messages')
        self.assertEqual([(row['name'], row['num'], row['mine']) for row in history],
                         [('Pierwsza funkcja', 1, 1), ('Pierwsza funkcja', 2, 0), ('Pierwsza funkcja', 3, 1)])

    def test_legacy_code_is_migrated_once(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory, 'rooms.sqlite3')
            schema = Path(__file__).resolve().parents[1].joinpath('schema.sql').read_text()
            legacy = schema.replace(", lang TEXT NOT NULL DEFAULT ''", '').replace(', sender TEXT', '')
            now = int(time.time())
            with closing(sqlite3.connect(database)) as db, db:
                db.executescript(legacy)
                db.execute('INSERT INTO rooms VALUES(?,?,?,?,?)', ('000001', 'Stary pokój', 24, now, now + 3600))
                db.execute("INSERT INTO messages VALUES(1,'000001','code','Ala','hello','js',NULL,NULL,?)", (now,))
            app = App(directory, PASSWORD, ORIGIN, sweep=False)
            client = Client(app)
            base = '/api/room/000001/'
            self.call(client, 200, 'POST', base + 'join', {'nick': 'Ola'})
            old = self.call(client, 200, 'GET', base + 'messages')[0]
            self.assertEqual((old['id'], old['num'], old['body'], old['mine']), (1, 1, 'hello', 0))
            client.app = App(directory, PASSWORD, ORIGIN, sweep=False)
            codes = self.call(client, 200, 'GET', base + 'catalog')['codes']
            self.assertEqual([(item['id'], item['num']) for item in codes], [(old['asset'], 1)])

    def test_file_conflict_history_restore_and_copy(self):
        base = self.room()
        original = make_packet('program.py', 'file', {'program.py': b'print(1)\n'})
        item = self.save(original)
        url = base + f'assets/{item["asset"]}'
        self.save(original, 409)
        self.save(make_packet('program.py', 'file', {'program.py': b'print(2)\n'}, 'version', 'Nowa liczba'))
        history = self.call(self.ala, 200, 'GET', url)['history']
        self.assertEqual([item['num'] for item in history], [2, 1])
        self.assertEqual(history[0]['note'], 'Nowa liczba')
        preview = self.call(self.ala, 200, 'GET', url + '/2/preview')
        self.assertEqual(preview, {'type': 'text', 'text': 'print(2)\n'})
        diff = self.call(self.ala, 200, 'GET', url + '/2/changes?path=program.py')['text']
        self.assertIn('-print(1)\n+print(2)', diff)
        restored = self.call(self.ala, 200, 'POST', url + '/1/restore')
        self.assertEqual(restored['num'], 3)
        self.assertEqual(self.call(self.ala, 200, 'GET', url + '/3/download'), b'print(1)\n')
        copied = self.save(make_packet('program.py', 'file', {'program.py': b'print(1)\n'}, 'copy'))
        self.assertNotEqual(copied['asset'], item['asset'])
        names = [item['name'] for item in self.call(self.ala, 200, 'GET', base + 'catalog')['files']]
        self.assertCountEqual(names, ['program.py', 'program (2).py'])

    def test_nested_folder_zip_and_folder_changes(self):
        base = self.room()
        source = {'src': None, 'src/Żółć.java': b'class A {}', 'empty': None, 'old.txt': b''}
        item = self.save(make_packet('Projekt', 'folder', source))
        url = base + f'assets/{item["asset"]}'
        entries = self.call(self.ala, 200, 'GET', url + '/1/preview')['entries']
        self.assertIn({'path': 'empty', 'dir': True}, entries)
        self.assertIn({'path': 'src/Żółć.java', 'dir': False}, entries)
        payload = self.call(self.ala, 200, 'GET', url + '/1/download')
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            self.assertIn('Projekt/empty/', archive.namelist())
            self.assertEqual(archive.read('Projekt/src/Żółć.java'), b'class A {}')
            self.assertEqual(archive.read('Projekt/old.txt'), b'')
        self.assertEqual(self.call(self.ala, 200, 'GET', url + '/1/download?path=src%2F%C5%BB%C3%B3%C5%82%C4%87.java'),
                         b'class A {}')
        self.save(make_packet('Projekt', 'folder', {'src': None, 'src/Żółć.java': b'class B {}', 'new.txt': b'n'}, 'version'))
        changes = self.call(self.ala, 200, 'GET', url + '/2/changes')
        self.assertEqual({change['path']: change['state'] for change in changes},
                         {'empty': 'removed', 'new.txt': 'added', 'old.txt': 'removed', 'src/Żółć.java': 'changed'})

    def test_invalid_folder_paths_do_not_create_assets(self):
        base = self.room()
        for path in ('../a', '/a', 'a/../b', 'a\\b', 'C:/x', 'a//b'):
            with self.subTest(path=path):
                self.save(make_packet('Test', 'folder', {path: b'x'}), 400)
        self.save(make_packet('Test', 'folder', {'a': b'file', 'a/b': b'child'}), 400)
        self.assertEqual(self.call(self.ala, 200, 'GET', base + 'catalog')['files'], [])

    def test_split_diff_compares_selected_versions_and_includes_removed_paths(self):
        base = self.room()
        name, path = 'Project', 'src/app.js'
        first = self.save(make_packet(name, 'folder', {
            path: b'const total = 1;\nreturn total;\n',
            'archive': None,
            'old.txt': b'legacy\n',
        }))
        self.save(make_packet(name, 'folder', {path: b'const total = 2;\nreturn total;\n'}, 'version'))
        self.save(make_packet(name, 'folder', {
            path: b'const total = 3;\nreturn total;\n', 'new.txt': b'new\n',
        }, 'version'))
        url = base + f'assets/{first["asset"]}/3/changes'
        changes = self.call(self.ala, 200, 'GET', url + '?format=split&from=1')
        self.assertIn({'path': 'archive', 'state': 'removed', 'dir': True}, changes)
        self.assertIn({'path': 'old.txt', 'state': 'removed', 'dir': False}, changes)
        diff = self.call(self.ala, 200, 'GET', url + '?format=split&from=1&path=src%2Fapp.js')
        self.assertEqual(diff['blocks'], [[
            {'before': [1, 'const total = 1;'], 'after': [1, 'const total = 3;'], 'changed': True,
             'words': {'before': [['const total = ', False], ['1', True], [';', False]],
                       'after': [['const total = ', False], ['3', True], [';', False]]}},
            {'before': [2, 'return total;'], 'after': [2, 'return total;'], 'changed': False},
        ]])
        removed = self.call(self.ala, 200, 'GET', url + '?format=split&from=1&path=old.txt')
        self.assertEqual(removed['blocks'], [[{'before': [1, 'legacy'], 'after': None, 'changed': True}]])
        self.call(self.ala, 400, 'GET', url + '?from=3')

    def test_raster_image_preview(self):
        base = self.room()
        png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/WloAAAAASUVORK5CYII=')
        item = self.save(make_packet('pixel.png', 'file', {'pixel.png': png}))
        preview = self.call(self.ala, 200, 'GET', base + f'assets/{item["asset"]}/1/preview')
        self.assertEqual(preview['type'], 'image')
        self.assertTrue(preview['source'].startswith('data:image/png;base64,'))
        self.assertEqual(base64.b64decode(preview['source'].split(',', 1)[1]), png)

    def test_large_folder_search_pages_paths_in_latest_versions(self):
        base = self.room()
        entries = {f'inputs/{index:05}/' + 'report-' + 'a' * 105 + '.csv': b''
                   for index in range(10_000)}
        packet = make_packet('Project', 'folder', entries)
        self.assertGreater(int.from_bytes(packet[:4], 'big'), assets.MAX_HEADER // 4)
        item = self.save(packet)
        url = base + f'assets/{item["asset"]}/1/preview'
        self.assertEqual(len(self.call(self.ala, 200, 'GET', url)['entries']), 10_000)
        self.call(self.ola, 401, 'GET', base + 'search?q=report')
        search = base + 'search?q=report'
        page = self.call(self.ala, 200, 'GET', search)
        self.assertEqual(len(page['items']), 60)
        self.assertEqual(page['next'], 60)
        second = self.call(self.ala, 200, 'GET', search + '&offset=60')
        self.assertTrue({item['path'] for item in page['items']}.isdisjoint(item['path'] for item in second['items']))
        exact = self.call(self.ala, 200, 'GET', base + 'search?q=project%2Finputs%2F09999')
        self.assertEqual([result['path'] for result in exact['items']], [next(reversed(entries))])
        self.save(make_packet('Project', 'folder', {'docs/Notes.txt': b'notes'}, 'version'))
        self.assertEqual(self.call(self.ala, 200, 'GET', search)['items'], [])
        result = self.call(self.ala, 200, 'GET', base + 'search?q=notes&category=files')['items']
        self.assertEqual([(hit['num'], hit['path']) for hit in result], [(2, 'docs/Notes.txt')])

    def test_delimited_tables_decode_quotes_and_cap_large_previews(self):
        base = self.room()
        csv_source = '\ufeffcity;notes;value\r\nPoznań;"one; two";10\r\nŁódź;"line 1\nline 2";20\r\n'
        item = self.save(make_packet('report.CSV', 'file', {'report.CSV': csv_source.encode()}))
        preview = self.call(self.ala, 200, 'GET', base + f'assets/{item["asset"]}/1/preview')
        self.assertEqual(preview['delimiter'], ';')
        self.assertEqual(preview['rows'], [['city', 'notes', 'value'], ['Poznań', 'one; two', '10'],
                                           ['Łódź', 'line 1\nline 2', '20']])
        self.assertEqual(preview['text'], csv_source.lstrip('\ufeff'))
        tsv_source = ('Name\tRole\nŁucja\tEditor\n' + 'A\tB\n' * 70_000).encode('utf-16')
        item = self.save(make_packet('sheet.tsv', 'file', {'sheet.tsv': tsv_source}))
        preview = self.call(self.ala, 200, 'GET', base + f'assets/{item["asset"]}/1/preview')
        self.assertEqual(preview['rows'][:2], [['Name', 'Role'], ['Łucja', 'Editor']])
        self.assertEqual(len(preview['rows']), 1000)
        self.assertTrue(preview['source_limited'])
        self.assertTrue(preview['rows_limited'])

    def test_latex_file_preview_and_snippet_download(self):
        base = self.room()
        source = r'\section{Wstęp}' + '\n'
        data = source.encode()
        uploaded = self.save(make_packet('notes.tex', 'file', {'notes.tex': data}))
        self.assertEqual(self.call(self.ala, 200, 'GET', base + f'assets/{uploaded["asset"]}/1/preview'),
                         {'type': 'text', 'text': source})
        for title, expected in [('Notes', 'Notes.tex'), ('Outline.TeX', 'Outline.TeX')]:
            with self.subTest(title=title):
                fragment = self.call(self.ala, 200, 'POST', base + 'messages',
                                     {'kind': 'code', 'title': title, 'lang': 'tex', 'body': source})
                status, payload, headers = self.ala.call('GET', base + f'assets/{fragment["asset"]}/1/download')
                self.assertEqual((status, payload), (200, data))
                self.assertEqual(headers['Content-Disposition'], "attachment; filename*=UTF-8''" + expected)

    def test_concurrent_uploads_have_distinct_versions(self):
        self.room()
        self.call(self.ola, 200, 'POST', self.base + 'join', {'nick': 'Ola'})
        first = self.save(make_packet('test.txt', 'file', {'test.txt': b'1'}))
        with ThreadPoolExecutor(2) as pool:
            futures = [pool.submit(self.save, make_packet('test.txt', 'file', {'test.txt': content}, 'version'), 200, client)
                       for client, content in [(self.ala, b'2'), (self.ola, b'3')]]
            results = [future.result() for future in futures]
        self.assertEqual({item['num'] for item in results}, {2, 3})
        self.assertEqual({item['asset'] for item in results}, {first['asset']})

    def test_close_cascades_and_revokes_access(self):
        base = self.room()
        self.save(make_packet('file.txt', 'file', {'file.txt': b'content'}))
        self.call(self.ala, 200, 'POST', base + 'messages', {'kind': 'text', 'body': 'Rozmowa'})
        self.call(self.ala, 401, 'DELETE', '/api/admin/rooms/' + self.code)
        self.call(self.admin, 200, 'DELETE', '/api/admin/rooms/' + self.code)
        self.call(self.ala, 404, 'GET', base + 'state')
        self.call(self.ola, 404, 'POST', base + 'join', {'nick': 'Ola'})
        with closing(self.app.connect()) as db:
            for table in ['rooms', 'members', 'messages', 'assets', 'versions', 'blobs']:
                self.assertEqual(db.execute(f'SELECT count(*) FROM {table}').fetchone()[0], 0)

    def test_room_settings_require_admin_and_support_partial_updates(self):
        base = self.room()
        path = '/api/admin/rooms/' + self.code
        self.call(self.ala, 401, 'GET', path)
        self.call(self.ala, 401, 'PATCH', path, {'title': 'Unauthorized'})
        original = self.call(self.admin, 200, 'GET', path)

        renamed = self.call(self.admin, 200, 'PATCH', path, {'title': '  Updated name  '})['room']
        self.assertEqual(renamed, {**original, 'title': 'Updated name'})
        self.assertEqual(self.call(self.ala, 200, 'GET', base + 'state')['room']['title'], 'Updated name')

        extended = self.call(self.admin, 200, 'PATCH', path, {'hours': 36})['room']
        self.assertEqual(extended, {**renamed, 'hours': 36, 'expires': renamed['expires'] + 12 * 3600})
        self.call(self.admin, 400, 'PATCH', path, {})
        self.call(self.admin, 400, 'PATCH', path, {'title': 'Rejected', 'hours': 0})
        self.assertEqual(self.call(self.admin, 200, 'GET', path), extended)
        self.assertEqual(self.call(self.admin, 200, 'PATCH', path, {'hours': 1})['room']['hours'], 1)

        self.call(self.admin, 200, 'POST', '/api/admin/logout')
        self.call(self.admin, 401, 'GET', path)

    def test_retention_rejoin_restart_and_sweep(self):
        base = self.room()
        path = '/api/admin/rooms/' + self.code
        self.call(self.admin, 400, 'PATCH', path, {'hours': 0})
        self.call(self.admin, 200, 'PATCH', path, {'hours': 36})
        self.save(make_packet('file.txt', 'file', {'file.txt': b'content'}))
        self.call(self.ala, 200, 'POST', base + 'leave')
        self.assertEqual(self.call(self.admin, 200, 'GET', '/api/admin/rooms')[0]['online'], 0)
        self.ola.app = App(self.directory, PASSWORD, ORIGIN, sweep=False)
        self.call(self.ola, 200, 'POST', base + 'join', {'nick': 'Ola'})
        self.assertEqual(self.call(self.ola, 200, 'GET', base + 'catalog')['files'][0]['name'], 'file.txt')
        with closing(self.app.connect()) as db:
            room = db.execute('SELECT expires,hours FROM rooms WHERE code=?', (self.code,)).fetchone()
            self.assertEqual(room['hours'], 36)
            self.app.clean(db, room['expires'])
            self.assertFalse(db.execute('SELECT 1 FROM blobs').fetchone())
        self.call(self.ola, 404, 'GET', base + 'messages')

    def test_one_hour_retention_starts_when_the_last_participant_leaves(self):
        joined_at = 1_700_000_000
        with patch('server.time.time', return_value=joined_at):
            base = self.room(hours=1)
            self.call(self.admin, 400, 'POST', '/api/admin/rooms', {'title': 'Too short', 'hours': 0})
            self.call(self.ola, 200, 'POST', base + 'join', {'nick': 'Ola'})
            self.save(make_packet('file.txt', 'file', {'file.txt': b'content'}))
            path = '/api/admin/rooms/' + self.code
            initial_expiry = self.call(self.admin, 200, 'GET', path)['expires']

        left_at = joined_at + 20
        with patch('server.time.time', return_value=left_at):
            self.call(self.ala, 200, 'POST', base + 'leave')
            self.assertEqual(self.call(self.admin, 200, 'GET', path)['expires'], initial_expiry)
            self.call(self.ola, 200, 'POST', base + 'leave')
            self.assertEqual(self.call(self.admin, 200, 'GET', path)['expires'], left_at + 3600)

        with closing(self.app.connect()) as db:
            self.app.clean(db, left_at + 3599)
            self.assertTrue(db.execute('SELECT 1 FROM blobs').fetchone())
            self.app.clean(db, left_at + 3600)
            self.assertFalse(db.execute('SELECT 1 FROM blobs').fetchone())
