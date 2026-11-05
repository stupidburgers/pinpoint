"""E2E fixtures: the isolated Desktop rig (demo/rig/rig.py) driven over CDP.

Opt-in: Desktop E2E needs the installed app, so it is skipped unless the app exists. Env:
  PINPOINT_E2E_REUSE=1   reuse an already running rig (no stop/start); default is a fresh start
  PINPOINT_E2E_KEEP=1    leave the rig running afterwards
  RIG / PORT / SITE_PORT / LLM_PORT as in rig.py
"""
import importlib.util
import json
import os
import re
import sys
import time
import urllib.request

import pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
FLAWS = json.load(open(os.path.join(ROOT, 'demo', 'site', 'flaws.json'), encoding='utf8'))


def load_rig():
    spec = importlib.util.spec_from_file_location('pinpoint_rig', os.path.join(ROOT, 'demo', 'rig', 'rig.py'))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


class Env:
    """Thin driver around rig.py + the fake-LLM log + the rig's webview target."""

    def __init__(self, rig):
        self.rig = rig
        self.llm_log = rig.RIG + '/fakellm.jsonl'
        self.desktop_log = rig.HOME + '/logs/desktop.log'
        self.site_dir = rig.RIG + '/site'
        self._ws = None

    # ---- logs -------------------------------------------------------------
    def llm_rows(self):
        try:
            return [json.loads(x) for x in open(self.llm_log, encoding='utf8').read().splitlines() if x.strip()]
        except OSError:
            return []

    def mark(self):
        try:
            d = os.path.getsize(self.desktop_log)
        except OSError:
            d = 0
        return {'llm': len(self.llm_rows()), 'log': d}

    def pin_log(self, since=None):
        try:
            with open(self.desktop_log, 'rb') as f:
                f.seek((since or {}).get('log', 0))
                txt = f.read().decode('utf8', 'replace')
        except OSError:
            return []
        return [l for l in txt.splitlines() if '[pinpoint]' in l]

    def wait(self, pred, timeout=45, what='condition'):
        t0 = time.time()
        while time.time() - t0 < timeout:
            v = pred()
            if v:
                return v
            try:
                self.consent()  # the host consent dialog can appear at any time the preview is first scripted
            except Exception:
                pass
            time.sleep(0.4)
        try:
            extra = chr(10) + 'last llm rows: %s' % ('; '.join('%s/%s/%s/%s' % (r.get('n'), r.get('last_role'), r.get('turn'), r['last_text'][:60]) for r in self.llm_rows()[-6:]))
        except Exception:
            extra = ''
        pytest.fail('timeout %ds waiting for %s%s' % (timeout, what, extra))

    def wait_llm(self, since, pred, timeout=45, what='fake-LLM request'):
        return self.wait(lambda: next((r for r in self.llm_rows()[since['llm']:] if pred(r)), None), timeout, what)

    def wait_pin_log(self, since, pattern, timeout=45):
        return self.wait(lambda: next((l for l in self.pin_log(since) if re.search(pattern, l)), None), timeout, 'desktop.log /%s/' % pattern)

    # ---- app --------------------------------------------------------------
    def send(self, text):
        r = self.rig
        ok = r.cdp_eval('(()=>{const el=document.querySelector(\'[data-slot="composer-rich-input"]\');if(!el)return false;el.focus();return true})()')
        assert ok, 'composer editor not found'
        r.cdp_call('Input.insertText', text=text)
        time.sleep(0.4)
        r.press('Enter', 'Enter', 13)

    def open_site(self, url=None):
        return self.rig.open_site(url)

    def consent(self):
        if self.rig.consent_dialog():
            return self.rig.allow_consent()
        return False

    def click_panel(self, text):
        return self.rig.click_text(text)

    def shot(self, name):
        d = os.path.join(ROOT, 'evidence', 'e2e')
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, name + '.png')
        import base64
        open(p, 'wb').write(base64.b64decode(self.rig.cdp_call('Page.captureScreenshot', format='png')['result']['data']))
        return p

    # ---- the preview <webview> target (reachable over the same debug port) --
    def webview(self):
        import websocket
        if self._ws is None:
            tabs = json.load(urllib.request.urlopen('http://127.0.0.1:%d/json' % self.rig.PORT))
            t = next((t for t in tabs if t['type'] == 'webview'), None)
            if not t:
                return None
            self._ws = websocket.create_connection(t['webSocketDebuggerUrl'], max_size=None, suppress_origin=True)
            self._i = 100
            self.wcall('Emulation.setDeviceMetricsOverride', width=1280, height=800, deviceScaleFactor=1, mobile=False)
        return self._ws

    def wcall(self, method, **params):
        self._i += 1
        self._ws.send(json.dumps({'id': self._i, 'method': method, 'params': params}))
        while True:
            m = json.loads(self._ws.recv())
            if m.get('id') == self._i:
                return m

    def weval(self, js):
        if self.webview() is None:
            return None
        r = self.wcall('Runtime.evaluate', expression=js, returnByValue=True, awaitPromise=True)
        return r.get('result', {}).get('result', {}).get('value')

    def drop_webview(self):
        if self._ws:
            try:
                self._ws.close()
            except Exception:
                pass
        self._ws = None


def pytest_collection_modifyitems(config, items):
    pass


@pytest.fixture(scope='session')
def rig_mod():
    return load_rig()


@pytest.fixture(scope='session')
def env(rig_mod):
    try:
        rig_mod.exe()
    except SystemExit:
        pytest.skip('Hermes Desktop is not installed on this machine (E2E needs the app)')
    if not os.path.exists(os.path.join(ROOT, 'engine', 'pinpoint-engine.js')) or not os.path.exists(os.path.join(ROOT, 'desktop', 'plugin.js')):
        pytest.skip('engine/ or desktop/plugin.js not built yet')
    e = Env(rig_mod)
    e.base = e.mark()  # desktop.log persists across restarts: only look at lines written after this
    reuse = os.environ.get('PINPOINT_E2E_REUSE') == '1' and rig_mod.status()['cdp']
    if reuse:
        e.base = {'llm': 0, 'log': 0}  # desktop.log is rewritten per launch; with a reused rig, scan it whole
    else:
        rig_mod.stop(delete=True)  # fresh dirs: Desktop persists sessions, queued turns and pane layout in the rig
        e.base = e.mark()
        rig_mod.start()
    yield e
    e.drop_webview()
    if os.environ.get('PINPOINT_E2E_KEEP') != '1':
        rig_mod.stop(delete=True)


@pytest.fixture()
def lumen(env):
    """Fresh copy of the demo site, Browser pane on it at a 1280 px emulated viewport, consent granted when asked."""
    env.rig.reset_site()
    env.drop_webview()
    env.llm_reset()
    env.open_site('http://127.0.0.1:%d/' % env.rig.SITE_PORT)
    env.webview()
    return env


def _llm_reset(self):
    try:
        urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:%d/__reset' % self.rig.LLM_PORT, b'{}', {'content-type': 'application/json'}))
    except Exception:
        pass


Env.llm_reset = _llm_reset
