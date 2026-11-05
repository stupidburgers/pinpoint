"""D4: the scripted fake LLM behaves (no Desktop needed)."""
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request

import pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
RIGDIR = os.path.join(ROOT, 'demo', 'rig')


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


@pytest.fixture()
def llm(tmp_path):
    port = free_port()
    log = tmp_path / 'req.jsonl'
    proc = subprocess.Popen([sys.executable, os.path.join(RIGDIR, 'fakellm.py'), str(port), str(log),
                             os.path.join(RIGDIR, 'script.json'), '--var', 'SITE=/x/site'])
    for _ in range(50):
        try:
            socket.create_connection(('127.0.0.1', port), 0.2).close()
            break
        except OSError:
            time.sleep(0.1)

    def post(messages, tools=('tool_search', 'tool_describe', 'tool_call', 'patch'), stream=False):
        body = json.dumps({'model': 'fake-1', 'stream': stream, 'messages': messages,
                           'tools': [{'type': 'function', 'function': {'name': t}} for t in tools]}).encode()
        r = urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:%d/v1/chat/completions' % port, body, {'content-type': 'application/json'}))
        return r.read().decode()

    yield post, log
    proc.kill()


def msg(r, c, **kw):
    return dict(role=r, content=c, **kw)


def test_audit_wraps_deferred_tool_and_summarises_result(llm):
    post, log = llm
    out = json.loads(post([msg('user', 'please audit my page')]))
    tc = out['choices'][0]['message']['tool_calls'][0]['function']
    assert tc['name'] == 'tool_call'
    assert json.loads(tc['arguments']) == {'calls': [{'name': 'pinpoint_audit', 'arguments': {}}]}
    res = {'ok': True, 'score': 41, 'counts': {'high': 7, 'medium': 5, 'low': 3}}
    out = json.loads(post([msg('user', 'audit my page'), msg('tool', json.dumps(res), tool_call_id='c')]))
    assert 'score 41, 7 high, 5 medium, 3 low' in out['choices'][0]['message']['content']
    rows = [json.loads(x) for x in log.read_text().splitlines()]
    assert [r['turn'] for r in rows] == ['audit', 'audit'] and rows[0]['sent']['tool_calls'][0]['_name'] == 'tool_call'


def test_unavailable_branch(llm):
    post, _ = llm
    out = json.loads(post([msg('user', 'audit my page'), msg('tool', '{"ok":false,"code":"desktop_unavailable"}')]))
    assert 'not open' in out['choices'][0]['message']['content']


def test_fix_sequence_emits_real_patch_calls_one_per_turn_streaming(llm):
    post, _ = llm
    raw = post([msg('user', 'Pinpoint: fix pin #1 [a11y.contrast] on http://127.0.0.1:8765/')], stream=True)
    assert raw.rstrip().endswith('data: [DONE]')
    first = None
    for line in raw.splitlines():
        if line.startswith('data: {'):
            d = json.loads(line[6:])['choices'][0]['delta']
            if 'tool_calls' in d:
                first = d['tool_calls'][0]['function']
    a = json.loads(first['arguments'])
    assert first['name'] == 'patch' and a['path'] == '/x/site/styles.css' and 'b8ad9f' in a['old_string']
    second = json.loads(post([msg('user', 'fix pin 1'), msg('tool', '{"success":true}')]))
    assert json.loads(second['choices'][0]['message']['tool_calls'][0]['function']['arguments'])['old_string'].startswith('.plan .price-note')
    done = json.loads(post([msg('user', 'fix pin 1'), msg('tool', '{"success":true}')]))
    assert 'low-contrast' in done['choices'][0]['message']['content']


def test_default_ack(llm):
    post, _ = llm
    assert json.loads(post([msg('user', 'hello there')]))['choices'][0]['message']['content'].startswith('ack: hello')
