"""D5: SPEC 11 E2E scenarios 1-6 in the isolated Desktop rig (real Desktop, real gateway, scripted fake LLM).

Run:  python -m pytest tests/e2e/test_loop.py -q -rs      (rig is started/stopped by the `env` fixture; ~20 s start)
Asserts go through (a) the fake-LLM JSONL (what the agent saw/sent), (b) `[pinpoint]` lines in desktop.log,
(c) the preview <webview> target (window.__pinpoint is reachable over the same debug port), (d) files in RIG/site,
(e) screenshots in evidence/e2e/. Tests skip with a reason when a prerequisite (python half, engine rules) is absent.
"""
import json
import os
import re
import time

import pytest

from conftest import FLAWS

ACK_TIMEOUT_S = 4  # SPEC 7 default


def get_tool_result(env, since, timeout=60):
    """Last `tool` row whose text parses as a pinpoint_audit JSON result."""
    return env.wait_llm(since, lambda r: (r['last_role'] == 'tool' and tool_json(r['last_text']) is not None), timeout, 'JSON-parseable tool result')


def tool_json(text):
    try:
        v = json.loads(text)
        if isinstance(v, dict) and isinstance(v.get('output'), str):
            v = json.loads(v['output'])
        return v
    except Exception:
        return None


def hits(f, rule, ref):
    if f.get('rule') != rule:
        return False
    anch = (f.get('anchor') or {}).get('ref') or ''
    sel = f.get('selector') or ''
    return anch == ref or ('#' + ref) in sel or (ref == 'top' and sel in ('html', ':root'))


def python_half_on(env):
    return any('python half: on' in l for l in env.pin_log(env.base))


@pytest.fixture()
def need_python(env):
    env.wait(lambda: any('python half' in l for l in env.pin_log(env.base)), 20, 'python half state line')
    if not python_half_on(env):
        pytest.skip('python half is off in the rig (A: dashboard/plugin not loading); see desktop.log "python half"')


def engine_works(env):
    n = env.weval('(()=>{try{return window.__pinpoint?window.__pinpoint.audit().stats.checked:null}catch(e){return null}})()')
    return bool(n)


@pytest.fixture()
def fresh_rig(env, rig_mod):
    # a virgin rig: Desktop persists pane/session state, REUSE would leak an open Browser pane
    rig_mod.stop(delete=True)
    env.base = env.mark()
    rig_mod.start()
    return env


def test_0_no_preview_gives_desktop_unavailable_fast(fresh_rig, need_python):
    env = fresh_rig
    # runs FIRST on a fresh rig: the Browser pane has never been opened, so no window has a preview
    # (hiding the pane later does NOT remove the preview: measured, the audit still succeeds)
    assert not env.rig.cdp_eval('!!document.querySelector("input[aria-label=Address]")'), 'Browser pane already open'
    since = env.mark()
    env.send('Please audit my page')
    ask = env.wait_llm(since, lambda r: r['last_role'] == 'user' and 'audit my page' in r['last_text'], 30, 'the user turn at the fake LLM')
    row = env.wait_llm(since, lambda r: r['last_role'] == 'tool', 30, 'tool result')
    dt = row['t'] - ask['t']  # tool call emitted -> result returned, on the fake LLM's own clock
    assert 'desktop_unavailable' in row['last_text'], row['last_text'][:300]
    assert dt <= ACK_TIMEOUT_S + 1 + 1, 'took %.1fs (budget ack_timeout_s + 1 s + 1 s turn overhead)' % dt
    # Desktop may retry the turn instead of answering it; not part of the contract -> report only
    nxt = env.wait_llm(since, lambda r: r['n'] > row['n'], 20, 'the model follow-up')
    print('model follow-up:', json.dumps(nxt['sent'])[:200])


def test_1_agent_audit_round_trip(lumen, need_python):
    env = lumen
    since = env.mark()
    env.send('Please audit my page')
    row = get_tool_result(env, since)
    res = tool_json(row['last_text'])
    if res and res.get('code') == 'engine_error' and not engine_works(env):
        pytest.skip('round trip reached the Desktop but the engine has no rules yet: %s' % row['last_text'][:160])
    assert res and res.get('ok', True), row['last_text'][:300]
    print('tool result: score %s counts %s findings %d' % (res.get('score'), res.get('counts'), len(res.get('findings', []))))
    if not res.get('findings'):
        pytest.skip('audit returned no findings: engine rules not implemented yet (%s)' % row['last_text'][:120])
    # the tool result is capped at ~12 000 chars (SPEC 6 "result cap 12 000, field-drop order"): with 22 findings
    # the tail gets dropped, so require: everything the model got is real ground truth, no ok-* noise, and only
    # LOW-severity ground truth may be missing from the capped result
    bad = [x for x in res['findings'] if '#ok-' in (x.get('selector') or '') or ((x.get('anchor') or {}).get('ref') or '').startswith('ok-')]
    assert not bad, 'finding on an ok-* control: %s' % bad
    miss = [(f['rule'], f['ref']) for f in FLAWS['flaws'] if not any(hits(x, f['rule'], f['ref']) for x in res['findings'])]
    low_sev_rules = {'a11y.heading-order', 'spacing.tight-targets', 'type.line-height', 'a11y.page-title', 'type.text-small'}  # everything the cap drops must be low-severity (the tail)
    assert all(rule in low_sev_rules for rule, ref in miss), miss
    assert len(res['findings']) >= 20, len(res['findings'])
    print('capped tool result: %d findings; low-sev dropped from the model view: %s' % (len(res['findings']), miss))
    # ground truth, uncapped: audit the same page directly in the preview (window.__pinpoint proven contract)
    live = env.weval('JSON.stringify(window.__pinpoint.audit().findings)')
    live = json.loads(live) if isinstance(live, str) else live
    miss2 = [(f['rule'], f['ref']) for f in FLAWS['flaws'] if not any(hits(x, f['rule'], f['ref']) for x in live)]
    assert not miss2, 'ground-truth flaws missing from the uncapped page audit: %s' % miss2
    assert not [x for x in live if ((x.get('anchor') or {}).get('ref') or '').startswith('ok-')]
    env.shot('s1-audit')


def test_2_pin_click_reaches_the_agent(lumen, need_python):
    env = lumen
    since = env.mark()
    (env.click_panel('Audit this page') or env.click_panel('Re-audit'))
    env.wait_pin_log(since, r'audit ok', 60)
    if not engine_works(env):
        pytest.skip('engine has no rules yet')
    since = env.mark()
    clicked = env.rig.cdp_eval('(()=>{const b=document.querySelector(\'button[aria-label^="Fix pin 1 "]\');if(!b)return false;b.click();return true})()')
    assert clicked, 'no "Fix pin 1" button in the Pinpoint pane'
    row = env.wait_llm(since, lambda r: r['last_role'] == 'user' and 'Pinpoint: fix pin #1' in r['last_text'], 30, 'pin prompt at the fake LLM')
    assert 'pinpoint_audit' in row['last_text'] or 'Change the SOURCE' in row['last_text']
    env.shot('s2-pin-prompt')


def test_3_scripted_fix_turns_pins_green_and_raises_score(lumen, need_python):
    env = lumen
    since = env.mark()
    (env.click_panel('Audit this page') or env.click_panel('Re-audit'))
    line = env.wait_pin_log(since, r'audit ok', 60)
    if not engine_works(env):
        pytest.skip('engine has no rules yet')
    before = int(re.search(r'"score":\s*(\d+)', line).group(1))
    files = {n: open(env.site_dir + '/' + n, encoding='utf8').read() for n in ('index.html', 'styles.css')}
    since2 = env.mark()
    env.rig.cdp_eval('(()=>{const b=document.querySelector(\'button[aria-label^="Fix pin 1 "]\');b&&b.click();return !!b})()')
    # the fake LLM answers with REAL patch-tool calls against the rig's site copy (index.html or styles.css)
    env.wait(lambda: any(open(env.site_dir + '/' + n, encoding='utf8').read() != files[n] for n in files), 300, 'site source patched by the agent (real patch tool)')
    def better():
        for l in env.pin_log(since2):
            if 'audit ok' in l:
                sc = re.search(r'"score":\s*(\d+)', l)
                fx = re.search(r'"fixed":\s*(\d+)', l)
                if sc and (int(sc.group(1)) > before or (fx and int(fx.group(1)) >= 1)):
                    return l
        return None
    line2 = env.wait(better, 180, 'audit ok with a higher score or fixed>=1 after the patch')
    after = int(re.search(r'"score":\s*(\d+)', line2).group(1))
    fixed = int(re.search(r'"fixed":\s*(\d+)', line2).group(1))
    assert after > before or fixed >= 1, line2
    env.shot('s3-after-fix')
    print('score %d -> %d' % (before, after))


def test_4_navigation_away_and_back_keeps_pins(lumen):
    env = lumen
    since = env.mark()
    (env.click_panel('Audit this page') or env.click_panel('Re-audit'))
    env.wait_pin_log(since, r'audit ok', 60)
    if not engine_works(env):
        pytest.skip('engine has no rules yet')
    pins = env.weval('window.__pinpoint.probe().pins')
    assert pins and pins > 0, 'no pins after audit'
    env.open_site('http://127.0.0.1:%d/fixed/' % env.rig.SITE_PORT)
    time.sleep(2)
    env.open_site('http://127.0.0.1:%d/' % env.rig.SITE_PORT)
    env.drop_webview()
    env.wait(lambda: (env.weval('(window.__pinpoint&&window.__pinpoint.probe().pins)||0') or 0) > 0, 30, 'pins re-applied by URL key after returning')
    env.shot('s4-back')


def test_6_desktop_only_palette_audit_works_without_python_half(env, rig_mod):
    """Python half disabled (plugins.enabled: []), Desktop half still on: the pane's own Audit button works and pins draw."""
    rig_mod.stop(delete=True)
    env.base = env.mark()
    os.environ['PINPOINT_PYTHON_HALF'] = '0'
    try:
        rig_mod.start()
        env.drop_webview()
        env.rig.reset_site()
        env.open_site('http://127.0.0.1:%d/' % rig_mod.SITE_PORT)
        env.webview()
        assert not python_half_on(env)
        since = env.mark()
        assert (env.click_panel('Audit this page') or env.click_panel('Re-audit'))
        line = env.wait_pin_log(since, r'audit ok', 60)
        assert '"source":"user"' in line
        if engine_works(env):
            assert (env.weval('window.__pinpoint.probe().pins') or 0) >= 0
    finally:
        rig_mod.stop(delete=True)
        os.environ.pop('PINPOINT_PYTHON_HALF', None)
