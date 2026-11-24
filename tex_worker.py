import json
import os
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import zipfile
from http.client import HTTPConnection, HTTPException
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from socketserver import UnixStreamServer
from urllib.parse import quote, unquote

import assets
from assets import Problem, require

ENGINES = ('pdflatex', 'xelatex')
BUILD_SECONDS = 35
MAX_PDF = 16 * assets.MIB
MAX_ARCHIVE = assets.MAX_BYTES + 2 * assets.MAX_HEADER


class CompilerConnection(HTTPConnection):
    def __init__(self, path):
        super().__init__('localhost', timeout=BUILD_SECONDS + 10)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


def request_pdf(socket_path, archive, entry, engine):
    size = os.fstat(archive.fileno()).st_size
    require(size <= MAX_ARCHIVE, 413, 'This project is too large to compile.')
    connection = CompilerConnection(socket_path)
    try:
        connection.request('POST', '/compile', archive, {
            'Content-Length': str(size),
            'X-Tex-Entry': quote(entry, safe=''),
            'X-Tex-Engine': engine,
        })
        response = connection.getresponse()
        if response.status in (400, 413, 422):
            error = json.loads(response.read(16384))['error']
            raise Problem(response.status, error)
        require(response.status == 200, 503, 'The LaTeX compiler is unavailable. Try again shortly.')
        pdf = response.read(MAX_PDF + 1)
        require(len(pdf) <= MAX_PDF and pdf.startswith(b'%PDF-'), 503, 'The compiler returned an invalid PDF.')
        return pdf
    except (OSError, HTTPException, ValueError, KeyError) as error:
        raise Problem(503, 'The LaTeX compiler is unavailable. Try again shortly.') from error
    finally:
        connection.close()


def unpack_project(package, root):
    with zipfile.ZipFile(package) as archive:
        entries = archive.infolist()
        require(len(entries) <= assets.MAX_ENTRIES and sum(info.file_size for info in entries) <= assets.MAX_BYTES,
                413, 'This project is too large to compile.')
        for info in entries:
            target = root / assets.path_name(info.filename.removesuffix('/'))
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info) as source, target.open('xb') as output:
                    shutil.copyfileobj(source, output)


def file_limit():
    import resource

    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_PDF, MAX_PDF))


def compile_pdf(package, entry, engine):
    with tempfile.TemporaryDirectory(prefix='tex-') as temp:
        root = Path(temp) / 'project'
        output = Path(temp) / 'build'
        home = Path(temp) / 'home'
        for directory in (root, output, home):
            directory.mkdir()
        unpack_project(package, root)
        source = root / assets.path_name(entry)
        require(source.is_file() and source.suffix.lower() == '.tex', 400, 'Select a .tex file to compile.')
        require(engine in ENGINES, 400, 'Choose a LaTeX engine.')
        executable = shutil.which(engine)
        require(executable, 503, 'The selected LaTeX engine is unavailable.')
        deadline = time.monotonic() + BUILD_SECONDS
        env = {
            'PATH': str(Path(executable).parent) + os.pathsep + os.defpath,
            'HOME': str(home), 'TMPDIR': temp, 'LC_ALL': 'C.UTF-8',
            'TEXINPUTS': f'.:{root}:', 'BIBINPUTS': f'{source.parent}:{root}:',
            'BSTINPUTS': f'{source.parent}:{root}:', 'TEXMFOUTPUT': str(output),
            'openin_any': 'p', 'openout_any': 'p', 'shell_escape': 'f',
            'MKTEXPK': '0', 'MKTEXTFM': '0', 'MKTEXTEX': '0', 'MKTEXFMT': '0',
        }
        command = [executable, '-no-shell-escape', '-no-parse-first-line', '-interaction=nonstopmode',
                   '-halt-on-error', '-file-line-error', '-jobname=tempchat',
                   '-output-directory=' + str(output), './' + source.name]

        def run(args, cwd):
            with tempfile.TemporaryFile(dir=temp) as log:
                with subprocess.Popen(args, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                      stdout=log, stderr=log, start_new_session=True,
                                      preexec_fn=file_limit) as process:
                    try:
                        status = process.wait(timeout=max(0, deadline - time.monotonic()))
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        raise Problem(422, f'Compilation exceeded {BUILD_SECONDS} seconds.') from None
                if status:
                    log.seek(max(0, log.tell() - 6000))
                    detail = log.read().decode('utf-8', errors='replace').replace(temp + '/', '')
                    raise Problem(422, 'LaTeX compilation failed.\n' + detail.strip())

        run(command, source.parent)
        aux = output / 'tempchat.aux'
        if aux.exists() and b'\\bibdata{' in aux.read_bytes():
            run(['bibtex', 'tempchat'], output)
            run(command, source.parent)
        run(command, source.parent)
        pdf = output / 'tempchat.pdf'
        require(pdf.is_file(), 422, 'LaTeX produced no pages. Select the main document to compile.')
        data = pdf.read_bytes()
        require(data.startswith(b'%PDF-'), 422, 'LaTeX produced an invalid PDF.')
        return data


class CompileHandler(BaseHTTPRequestHandler):
    def address_string(self):
        return 'tempchat'

    def do_POST(self):
        self.connection.settimeout(12)
        try:
            require(self.path == '/compile', 400, 'Unknown compiler endpoint.')
            size = int(self.headers.get('Content-Length', '0'))
            require(0 < size <= MAX_ARCHIVE, 413, 'This project is too large to compile.')
            with tempfile.TemporaryFile() as package:
                remaining = size
                while remaining:
                    chunk = self.rfile.read(min(remaining, 64 * 1024))
                    require(chunk, 400, 'Incomplete LaTeX project.')
                    package.write(chunk)
                    remaining -= len(chunk)
                package.seek(0)
                pdf = compile_pdf(package, unquote(self.headers.get('X-Tex-Entry', '')),
                                  self.headers.get('X-Tex-Engine', ''))
            self.reply(200, 'application/pdf', pdf)
        except Problem as error:
            self.reply(error.status, 'application/json', json.dumps({'error': str(error)}).encode())
        except (zipfile.BadZipFile, FileExistsError, NotADirectoryError, ValueError):
            self.reply(400, 'application/json', b'{"error":"Invalid LaTeX project."}')

    def reply(self, status, mime, body):
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == '__main__':
    path = Path(os.environ.get('TEX_SOCKET', '/run/tex/compiler.sock'))
    path.unlink(missing_ok=True)
    os.umask(0o077)
    with UnixStreamServer(str(path), CompileHandler) as server:
        server.serve_forever()
