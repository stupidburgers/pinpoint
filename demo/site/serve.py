"""Static server for the Lumen demo site with HMR-like live reload.

usage: python demo/site/serve.py [port] [--root DIR]      (default port 8765, root = this folder)

* CSS change  -> the page swaps the <link> href with a cache buster, NO reload (pins survive).
* HTML/JS/other change -> location.reload().
* The reload client is injected into HTML responses on the fly (files on disk stay clean);
  add ?noreload to a URL to skip it. Events come from SSE at /__reload.
stdlib only, binds 127.0.0.1.
"""
import http.server
import json
import os
import socketserver
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))

CLIENT_JS = r"""(function () {
  var es = new EventSource('/__reload');
  es.onmessage = function (m) {
    var d = {}; try { d = JSON.parse(m.data); } catch (e) { return; }
    if (d.kind === 'css') {
      var links = document.querySelectorAll('link[rel=stylesheet]');
      for (var i = 0; i < links.length; i++) {
        var u = new URL(links[i].href);
        if (u.origin !== location.origin) continue;
        u.searchParams.set('v', String(d.t));
        links[i].href = u.toString();
      }
    } else if (d.kind === 'reload') {
      location.reload();
    }
  };
})();"""


class State:
    clients = []
    lock = threading.Lock()


def scan(root):
    out = {}
    for base, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if not d.startswith('.') and d != '__pycache__']
        for f in files:
            p = os.path.join(base, f)
            try:
                out[p] = os.stat(p).st_mtime_ns
            except OSError:
                pass
    return out


def watcher(root):
    prev = scan(root)
    while True:
        time.sleep(0.25)
        cur = scan(root)
        changed = [p for p in cur if prev.get(p) != cur[p]] + [p for p in prev if p not in cur]
        prev = cur
        if not changed:
            continue
        kind = 'css' if all(p.lower().endswith('.css') for p in changed) else 'reload'
        msg = ('data: ' + json.dumps({'kind': kind, 't': int(time.time() * 1000),
                                      'files': [os.path.relpath(p, root) for p in changed]}) + '\n\n').encode()
        with State.lock:
            for w in list(State.clients):
                try:
                    w.write(msg)
                    w.flush()
                except Exception:
                    State.clients.remove(w)


class Handler(http.server.SimpleHTTPRequestHandler):
    root = HERE

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=Handler.root, **kw)

    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path == '/__reload':
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Connection', 'keep-alive')
            self.end_headers()
            self.wfile.write(b': hello\n\n')
            self.wfile.flush()
            with State.lock:
                State.clients.append(self.wfile)
            try:
                while True:
                    time.sleep(15)
                    self.wfile.write(b': ping\n\n')
                    self.wfile.flush()
            except Exception:
                with State.lock:
                    if self.wfile in State.clients:
                        State.clients.remove(self.wfile)
            return
        if path == '/__reload.js':
            b = CLIENT_JS.encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/javascript')
            self.send_header('Content-Length', str(len(b)))
            self.end_headers()
            self.wfile.write(b)
            return
        if path.endswith('/') or path.endswith('.html'):
            fs = self.translate_path(path)
            if os.path.isdir(fs):
                fs = os.path.join(fs, 'index.html')
            if os.path.isfile(fs) and 'noreload' not in self.path:
                b = open(fs, 'rb').read()
                i = b.lower().rfind(b'</body>')
                tag = b'<script src="/__reload.js"></script>\n'
                b = b[:i] + tag + b[i:] if i >= 0 else b + tag
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(b)))
                self.end_headers()
                self.wfile.write(b)
                return
        super().do_GET()


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main(argv):
    port = 8765
    root = HERE
    args = list(argv)
    while args:
        a = args.pop(0)
        if a == '--root':
            root = os.path.abspath(args.pop(0))
        elif a.isdigit():
            port = int(a)
    Handler.root = root
    threading.Thread(target=watcher, args=(root,), daemon=True).start()
    srv = Server(('127.0.0.1', port), Handler)
    print('Lumen demo on http://127.0.0.1:%d/ (root %s)' % (port, root), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main(sys.argv[1:])
