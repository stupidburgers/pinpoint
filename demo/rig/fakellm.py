"""Scripted fake OpenAI-compatible LLM for the Pinpoint E2E rig (no keys, no network).

usage: python demo/rig/fakellm.py PORT LOG.jsonl [script.json] [--var KEY=VALUE ...]

script.json (re-read when its mtime changes; `POST /__script` replaces it, `POST /__reset` clears sequences):
{
  "vars": {"SITE": "C:/.../site"},                 # substituted for {SITE} in every string
  "turns": [                                       # first match wins
    {"name": "audit",
     "when": {"last_role": "user", "last_regex": "(?i)audit (my|the) page", "tools_include": ["tool_call"]},
     "calls": [{"tool": "pinpoint_audit", "args": {}}],      # or {"fixes": "01-contrast"} -> patch calls
     "finally": "Score is {tool.score}."}            # text after the last tool result; {tool.a.b.0} reads the JSON tool result
  ],
  "default": "ack: {last_text}"
}
A call {"tool": NAME, "args": {...}} is sent directly when NAME is among the request's tools, otherwise wrapped as
tool_call({calls:[{name,arguments}]}) because plugin tools are deferred in Desktop (measured, ADR 003 H).
{"fixes": STEP} expands to one `patch` call per edit of demo/fixes/fixes.json (steps run sequentially, one per turn).
Matchers: last_role, last_contains (str|list, all), last_contains_any, last_regex, tools_include, tools_exclude.
Every request is logged as one JSON line: t, stream, tools, last_role, last_text, turn, sent{tool_calls|text}.
"""
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
FIXES = os.path.join(HERE, '..', 'fixes', 'fixes.json')

args = [a for a in sys.argv[1:]]
VARS = {}
while '--var' in args:
    i = args.index('--var')
    k, _, v = args[i + 1].partition('=')
    VARS[k] = v
    del args[i:i + 2]
PORT = int(args[0])
LOG = open(args[1], 'a', encoding='utf-8')
SCRIPT_PATH = args[2] if len(args) > 2 else os.path.join(HERE, 'script.json')
LOCK = threading.Lock()
STATE = {'script': None, 'mtime': None, 'seq': None, 'n': 0}


def log(o):
    with LOCK:
        LOG.write(json.dumps(o, ensure_ascii=False)[:20000] + '\n')
        LOG.flush()


def load_script():
    try:
        m = os.path.getmtime(SCRIPT_PATH)
    except OSError:
        m = None
    if STATE['script'] is None or (m is not None and m != STATE['mtime']):
        try:
            STATE['script'] = json.load(open(SCRIPT_PATH, encoding='utf-8'))
        except Exception:
            STATE['script'] = {'turns': []}
        STATE['mtime'] = m
    return STATE['script']


def text_of(m):
    c = m.get('content')
    return c if isinstance(c, str) else ' '.join(p.get('text', '') for p in (c or []) if isinstance(p, dict))


def tool_json(txt):
    try:
        v = json.loads(txt)
        for _ in range(2):
            if isinstance(v, dict) and isinstance(v.get('output'), str):
                try:
                    v = json.loads(v['output'])
                except Exception:
                    break
        return v
    except Exception:
        return None


def subst(s, ctx):
    def rep(m):
        key = m.group(1)
        if key.startswith('tool.'):
            v = ctx.get('tool')
            for part in key[5:].split('.'):
                if isinstance(v, list) and part.isdigit() and int(part) < len(v):
                    v = v[int(part)]
                elif isinstance(v, dict) and part in v:
                    v = v[part]
                else:
                    return '?'
            return str(v)
        if key == 'last_text':
            return ctx.get('last_text', '')[:120]
        return str(VARS.get(key, ctx['vars'].get(key, m.group(0))))
    return re.sub(r'\{([A-Za-z_][\w.]*)\}', rep, s)


def deep(o, ctx):
    if isinstance(o, str):
        return subst(o, ctx)
    if isinstance(o, list):
        return [deep(x, ctx) for x in o]
    if isinstance(o, dict):
        return {k: deep(v, ctx) for k, v in o.items()}
    return o


def matches(w, last_role, lt, tools):
    if 'last_role' in w and w['last_role'] != last_role:
        return False
    c = w.get('last_contains')
    if c is not None and not all(x.lower() in lt.lower() for x in ([c] if isinstance(c, str) else c)):
        return False
    a = w.get('last_contains_any')
    if a is not None and not any(x.lower() in lt.lower() for x in a):
        return False
    if 'last_regex' in w and not re.search(w['last_regex'], lt):
        return False
    if any(t not in tools for t in w.get('tools_include', [])):
        return False
    if any(t in tools for t in w.get('tools_exclude', [])):
        return False
    return True


def expand(calls, ctx):
    out = []
    for c in calls:
        if 'fixes' in c:
            for e in json.load(open(FIXES, encoding='utf-8'))['edits']:
                if e['step'] == c['fixes']:
                    out.append({'tool': 'patch', 'args': {'mode': 'replace', 'path': '{SITE}/' + e['path'],
                                                          'old_string': e['old_string'], 'new_string': e['new_string']}})
        else:
            out.append(c)
    return [deep(c, ctx) for c in out]


def to_wire(call, tools, idx):
    name, a = call['tool'], call.get('args', {})
    if name in tools or 'tool_call' not in tools:
        fn = {'name': name, 'arguments': json.dumps(a)}
    else:
        fn = {'name': 'tool_call', 'arguments': json.dumps({'calls': [{'name': name, 'arguments': a}]})}
    return {'id': 'call_%d_%d' % (STATE['n'], idx), 'type': 'function', 'function': fn}


def decide(req):
    msgs = req.get('messages', [])
    tools = [t['function']['name'] for t in req.get('tools', []) if 'function' in t]
    last = msgs[-1] if msgs else {}
    lr, lt = last.get('role'), text_of(last)
    script = load_script()
    ctx = {'vars': script.get('vars', {}), 'last_text': lt}
    if lr == 'tool':
        ctx['tool'] = tool_json(lt)
    seq = STATE['seq']
    name = None
    if lr == 'tool' and seq:
        if seq['rest']:
            c = seq['rest'].pop(0)
            return seq['name'], [to_wire(c, tools, 0)], None, tools, lr, lt
        STATE['seq'] = None
        return seq['name'], None, subst(seq['finally'], ctx), tools, lr, lt
    STATE['seq'] = None
    for t in script.get('turns', []):
        if matches(t.get('when', {}), lr, lt, tools):
            name = t.get('name', '?')
            if t.get('calls'):
                calls = expand(t['calls'], ctx)
                if calls:
                    STATE['seq'] = {'name': name, 'rest': calls[1:], 'finally': t.get('finally', 'Done.')}
                    return name, [to_wire(calls[0], tools, 0)], None, tools, lr, lt
            return name, None, subst(t.get('say', t.get('finally', 'Done.')), ctx), tools, lr, lt
    return None, None, subst(script.get('default', 'ack: {last_text}'), ctx), tools, lr, lt


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path.endswith('/models'):
            self._json(200, {'object': 'list', 'data': [{'id': 'fake-1', 'object': 'model'}]})
        elif self.path == '/__state':
            self._json(200, {'requests': STATE['n'], 'seq': STATE['seq'] and STATE['seq']['name']})
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        n = int(self.headers.get('content-length', 0))
        body = self.rfile.read(n) or b'{}'
        if self.path == '/__script':
            with LOCK:
                STATE['script'] = json.loads(body)
                STATE['mtime'] = os.path.getmtime(SCRIPT_PATH) if os.path.exists(SCRIPT_PATH) else None
                STATE['seq'] = None
            return self._json(200, {'ok': True})
        if self.path == '/__reset':
            STATE['seq'] = None
            return self._json(200, {'ok': True})
        req = json.loads(body)
        with LOCK:
            STATE['n'] += 1
            turn, tcs, content, tools, lr, lt = decide(req)
        log({'t': time.time(), 'n': STATE['n'], 'stream': req.get('stream'), 'tools': tools, 'last_role': lr,
             'last_text': lt[:4000], 'turn': turn,
             'sent': {'tool_calls': [json.loads(tc['function']['arguments']) | {'_name': tc['function']['name']} for tc in tcs]} if tcs else {'text': content}})
        if req.get('stream'):
            self.send_response(200)
            self.send_header('content-type', 'text/event-stream')
            self.end_headers()

            def ch(delta, fin=None):
                self.wfile.write(('data: ' + json.dumps({'id': 'c1', 'object': 'chat.completion.chunk', 'model': 'fake-1',
                                                         'choices': [{'index': 0, 'delta': delta, 'finish_reason': fin}]}) + '\n\n').encode())
                self.wfile.flush()
            ch({'role': 'assistant'})
            if tcs:
                for i, tc in enumerate(tcs):
                    ch({'tool_calls': [{'index': i, **tc}]})
                ch({}, 'tool_calls')
            else:
                ch({'content': content})
                ch({}, 'stop')
            self.wfile.write(b'data: [DONE]\n\n')
            self.wfile.flush()
        else:
            msg = {'role': 'assistant', 'content': content}
            if tcs:
                msg['tool_calls'] = tcs
            self._json(200, {'id': 'c1', 'object': 'chat.completion', 'model': 'fake-1',
                             'choices': [{'index': 0, 'message': msg, 'finish_reason': 'tool_calls' if tcs else 'stop'}],
                             'usage': {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15}})


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
