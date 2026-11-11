"""Isolated Hermes Desktop rig for Pinpoint E2E (productised from the Q5 spike rig, ADR 003; the spike itself is no longer shipped).

usage: python demo/rig/rig.py start|stop|status|reset-site|open-site [URL]|consent|shot PNG|eval JS   [--delete] [--no-app]
env:   RIG   rig dir          (required explicit isolated directory; must be OUTSIDE the live Hermes home)
       PORT  CDP port         (default 9444)
       PINPOINT_PYTHON_HALF=0 omits dashboard/ from the plugin copy so /api/plugins/pinpoint/* is 404 (desktop-only mode, SPEC scenario 6;
       measured: plugins.enabled/disabled do NOT gate dashboard routes, so the python half stays reachable)
       SITE_PORT 8765, LLM_PORT 8799, HERMES_EXE (default the installed Store package)
start creates RIG/{home,ud,site}, writes home/config.yaml, copies the plugin into home/plugins/pinpoint, starts
the fake LLM and the demo site (a COPY of demo/site, so scenarios never dirty the repo), launches Desktop with its OWN
HERMES_HOME/user-data-dir, waits for "Hermes gateway is ready", enables the Desktop half over CDP and reloads.
stop kills ONLY processes this rig started (pid files + command lines containing RIG/ud); --delete removes RIG.
"""
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')).replace('\\', '/')
RIG = os.environ.get('RIG', '').replace('\\', '/')
PORT = int(os.environ.get('PORT', '9444'))
SITE_PORT = int(os.environ.get('SITE_PORT', '8765'))
LLM_PORT = int(os.environ.get('LLM_PORT', '8799'))
HOME = RIG + '/home'
EXCLUDE_TOP = {'tests', 'demo', '.git', '.github', 'evidence', 'tools', 'docs', 'scripts', 'node_modules'}
EXCLUDE_ANY = {'__pycache__', '.pytest_cache'}
CREATE = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP


def exe():
    if os.environ.get('HERMES_EXE'):
        return os.environ['HERMES_EXE']
    # WindowsApps may deny listing: ask the package manager for the installed build.
    r = subprocess.run(['powershell', '-NoProfile', '-Command', '(Get-AppxPackage NousResearchInc.HermesAgent).InstallLocation'],
                       capture_output=True, text=True).stdout.strip()
    for base in ([r.replace('\\', '/')] if r else []):
        p = base + '/app/Hermes Agent.exe'
        if os.path.exists(p):
            return p
    sys.exit('Hermes Agent.exe not found; set HERMES_EXE')


def guard():
    if not RIG or not os.path.isabs(RIG):
        sys.exit('set RIG to an explicit absolute isolated test directory')
    if re.search(r'/appdata/local/hermes(/|$)', RIG.lower()):
        sys.exit('rig must be OUTSIDE %LOCALAPPDATA%/hermes (the gateway would attach to the host gateway)')


def pidfile(n):
    return '%s/%s.pid' % (RIG, n)


def read_pid_file(p):
    try:
        m = re.search(r'\d+', open(p).read())
        return int(m.group()) if m else None
    except OSError:
        return None


def alive(pid):
    r = subprocess.run(['tasklist', '/FI', 'PID eq %d' % pid, '/NH'], capture_output=True, text=True)
    return bool(re.search(r'\b%d\b' % pid, r.stdout))


def kill_tree(pid):
    subprocess.run(['taskkill', '/F', '/T', '/PID', str(pid)], capture_output=True)


def rig_pids():
    """PIDs of Electron processes whose command line carries THIS rig's user-data-dir."""
    ps = ("Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -ne $null -and $_.CommandLine -like '*user-data-dir*' } "
          "| ForEach-Object { '{0}|{1}' -f $_.ProcessId, $_.CommandLine }")
    out = subprocess.run(['powershell', '-NoProfile', '-Command', ps], capture_output=True, text=True).stdout
    needle = (RIG + '/ud').lower()
    pids = []
    for line in out.splitlines():
        pid, _, cmd = line.partition('|')
        norm = cmd.replace('\\', '/').replace('"', '').lower()
        i = norm.find(needle)
        if pid.strip().isdigit() and i >= 0 and norm[i + len(needle):i + len(needle) + 1] in ('', ' ', '/'):
            pids.append(int(pid))
    return pids


def spawn(name, argv, env=None):
    lg = open('%s/%s.log' % (RIG, name), 'ab')
    p = subprocess.Popen(argv, stdout=lg, stderr=lg, stdin=subprocess.DEVNULL, env=env, creationflags=CREATE, close_fds=True)
    open(pidfile(name), 'w').write(str(p.pid))
    return p.pid


def port_open(port):
    try:
        socket.create_connection(('127.0.0.1', port), 0.3).close()
        return True
    except OSError:
        return False


def copy_plugin():
    dst = HOME + '/plugins/pinpoint'
    shutil.rmtree(dst, ignore_errors=True)

    def ign(d, names):
        top = os.path.abspath(d).replace('\\', '/') == ROOT
        return [n for n in names if n in EXCLUDE_ANY or (top and n in EXCLUDE_TOP)]
    shutil.copytree(ROOT, dst, ignore=ign)
    if os.environ.get('PINPOINT_PYTHON_HALF', '1') == '0':
        shutil.rmtree(dst + '/dashboard', ignore_errors=True)


def reset_site():
    shutil.rmtree(RIG + '/site', ignore_errors=True)
    shutil.copytree(ROOT + '/demo/site', RIG + '/site', ignore=shutil.ignore_patterns('serve.py', '__pycache__'))


def cdp_call(method, **params):
    import websocket
    tabs = json.load(urllib.request.urlopen('http://127.0.0.1:%d/json' % PORT))
    ws_url = [t for t in tabs if t['type'] == 'page'][0]['webSocketDebuggerUrl']
    ws = websocket.create_connection(ws_url, max_size=None, suppress_origin=True)
    ws.send(json.dumps({'id': 1, 'method': method, 'params': params}))
    while True:
        m = json.loads(ws.recv())
        if m.get('id') == 1:
            ws.close()
            return m


def cdp_eval(js):
    r = cdp_call('Runtime.evaluate', expression=js, returnByValue=True, awaitPromise=True)
    return r.get('result', {}).get('result', {}).get('value')


def start(no_app=False):
    guard()
    for d in ('home/plugins', 'home/logs', 'ud'):
        os.makedirs(RIG + '/' + d, exist_ok=True)
    with open(HOME + '/config.yaml', 'w') as f:
        f.write('_config_version: 52\nmodel: {provider: custom, default: fake-1, base_url: "http://127.0.0.1:%d/v1", api_key: fake}\n'
                'plugins: {enabled: [pinpoint]}\n' % LLM_PORT)
    copy_plugin()
    reset_site()
    py = sys.executable
    env = dict(os.environ)
    env.pop('PYTHONPATH', None)
    if not port_open(LLM_PORT):
        spawn('fakellm', [py, ROOT + '/demo/rig/fakellm.py', str(LLM_PORT), RIG + '/fakellm.jsonl', ROOT + '/demo/rig/script.json',
                          '--var', 'SITE=' + RIG + '/site'], env)
    if not port_open(SITE_PORT):
        spawn('site', [py, ROOT + '/demo/site/serve.py', str(SITE_PORT), '--root', RIG + '/site'], env)
    for _ in range(50):
        if port_open(LLM_PORT) and port_open(SITE_PORT):
            break
        time.sleep(0.1)
    if no_app:
        print('rig services up (no app): llm %d site %d' % (LLM_PORT, SITE_PORT))
        return
    if rig_pids():
        sys.exit('rig Electron already running; stop first')
    logf = HOME + '/logs/desktop.log'
    before = os.path.getsize(logf) if os.path.exists(logf) else 0
    aenv = dict(os.environ, HERMES_HOME=HOME, HERMES_DESKTOP_SKIP_PROTOCOL_REGISTRATION='1')
    aenv.pop('PYTHONPATH', None)
    pid = spawn('electron', [exe(), '--remote-debugging-port=%d' % PORT, '--user-data-dir=%s/ud' % RIG], aenv)
    t0 = time.time()
    ready = False
    while time.time() - t0 < 120:
        if os.path.exists(logf):
            with open(logf, 'rb') as f:
                f.seek(before)
                if b'Hermes gateway is ready' in f.read():
                    ready = True
                    break
        time.sleep(0.5)
    if not ready:
        sys.exit('gateway not ready in 120 s; see %s' % logf)
    print('gateway ready after %.1f s (electron pid %d)' % (time.time() - t0, pid))
    for _ in range(60):
        try:
            cdp_eval('1')
            break
        except Exception:
            time.sleep(0.5)
    cdp_eval('localStorage.setItem("hermes.desktop.pluginDecisions.v2", JSON.stringify({pinpoint:true})); true')
    cdp_call('Page.reload')
    time.sleep(3)
    print('desktop half enabled:', cdp_eval('localStorage.getItem("hermes.desktop.pluginDecisions.v2")'))


def press(key, code, vk, mod=0):
    for t in ('rawKeyDown', 'keyUp'):
        cdp_call('Input.dispatchKeyEvent', type=t, key=key, code=code, windowsVirtualKeyCode=vk, nativeVirtualKeyCode=vk, modifiers=mod)


def click_text(text, within='document'):
    """Click the first <button> whose text equals `text` (exact, trimmed). Returns True if found."""
    js = '(()=>{const r=%s;const b=[...r.querySelectorAll("button")].find(b=>b.textContent.trim()===%s);if(b)b.click();return !!b})()' % (within, json.dumps(text))
    return bool(cdp_eval(js))


def open_site(url=None):
    """D3 (measured 2026-11-04): Ctrl+Shift+L toggles the Browser pane; the first-run dialog 'Stay signed in to your sites' is
    dismissed with 'Don't show again' (NEVER 'Use my profile': it would copy the user's cookies); the URL goes into
    input[aria-label=Address] + Enter."""
    url = url or 'http://127.0.0.1:%d/' % SITE_PORT
    if not cdp_eval('!!document.querySelector("input[aria-label=Address]")'):
        press('L', 'KeyL', 76, 10)
        time.sleep(1.5)
    click_text("Don't show again")
    time.sleep(0.5)
    cdp_eval('(()=>{const i=document.querySelector("input[aria-label=Address]");i.focus();i.select();return true})()')
    cdp_call('Input.insertText', text=url)
    press('Enter', 'Enter', 13)
    time.sleep(2.5)
    return cdp_eval('document.querySelector("input[aria-label=Address]").value')


def consent_dialog():
    return cdp_eval('(()=>{const d=document.querySelector("[data-testid=plugin-preview-consent]");return d?d.innerText:null})()')


def allow_consent():
    """D3: the host consent dialog is a normal DOM dialog (data-testid=plugin-preview-consent); click 'Allow on this site'."""
    ok = click_text('Allow on this site', 'document.querySelector("[data-testid=plugin-preview-consent]")||document')
    time.sleep(1)
    return ok


def status():
    out = {'rig': RIG, 'electron_pids': rig_pids(), 'gateway_pid': read_pid_file(HOME + '/gateway.pid'),
           'fakellm': port_open(LLM_PORT), 'site': port_open(SITE_PORT), 'cdp': port_open(PORT)}
    out['gateway_alive'] = bool(out['gateway_pid']) and alive(out['gateway_pid'])
    print(json.dumps(out))
    return out


def stop(delete=False):
    killed = []
    for pid in rig_pids():
        kill_tree(pid)
        killed.append(pid)
    g = read_pid_file(HOME + '/gateway.pid')
    if g and alive(g):
        kill_tree(g)
        killed.append(g)
    for n in ('fakellm', 'site', 'electron'):
        p = read_pid_file(pidfile(n))
        if p and alive(p):
            kill_tree(p)
            killed.append(p)
        try:
            os.remove(pidfile(n))
        except OSError:
            pass
    time.sleep(1)
    print('killed', killed)
    if delete:
        shutil.rmtree(RIG, ignore_errors=True)
        print('deleted', RIG)


if __name__ == '__main__':
    guard()
    a = sys.argv[1:]
    cmd = a[0] if a else 'status'
    if cmd == 'start':
        start('--no-app' in a)
    elif cmd == 'stop':
        stop('--delete' in a)
    elif cmd == 'status':
        status()
    elif cmd == 'reset-site':
        reset_site()
    elif cmd == 'shot':
        import base64
        open(a[1], 'wb').write(base64.b64decode(cdp_call('Page.captureScreenshot', format='png')['result']['data']))
        print('saved', a[1])
    elif cmd == 'open-site':
        print(open_site(a[1] if len(a) > 1 else None))
    elif cmd == 'consent':
        print(consent_dialog())
        print('allowed' if allow_consent() else 'no dialog')
    elif cmd == 'eval':
        v = cdp_eval(a[1])
        print(v if isinstance(v, str) else json.dumps(v))
    else:
        sys.exit(__doc__)
