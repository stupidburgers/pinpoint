"""D1 acceptance: demo site truth.

Two layers:
 * DOM layer (always runs): every flaws.json ref exists and the seeded defect is measurably present
   (independent of the engine); the `fixed/` variant has none; ok-* controls are healthy.
 * Engine layer (runs when engine/pinpoint-engine.js exists, i.e. after Package B): the audit of
   index.html contains every flaws.json (rule, ref); no finding anchors on ok-*; fixed/ has none of the
   flaw findings and a higher score.
Run: python -m pytest tests/e2e/test_site_truth.py -q
"""
import json
import os
import socket
import subprocess
import sys
import time

import pytest

playwright = pytest.importorskip('playwright.sync_api')

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SITE = os.path.join(ROOT, 'demo', 'site')
ENGINE = os.path.join(ROOT, 'engine', 'pinpoint-engine.js')
FLAWS = json.load(open(os.path.join(SITE, 'flaws.json'), encoding='utf8'))
VP = FLAWS['viewport']

# rule -> JS predicate(el) that is TRUE when the seeded defect is present on that element.
LUM = """
const lum=(c)=>{const m=c.match(/[\\d.]+/g).map(Number);const [r,g,b]=m.slice(0,3).map(v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)});return .2126*r+.7152*g+.0722*b};
const ratio=(a,b)=>{const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
const bgOf=(e)=>{while(e){const c=getComputedStyle(e).backgroundColor;if(c&&!/rgba\\(.*, 0\\)|transparent/.test(c))return c;e=e.parentElement}return 'rgb(255,255,255)'};
"""
PRED = {
    'a11y.contrast': "ratio(getComputedStyle(el).color, bgOf(el)) < 4.5",
    'a11y.tap-target': "(()=>{const r=el.getBoundingClientRect();return Math.min(r.width,r.height) < 24})()",
    'a11y.img-alt': "!el.hasAttribute('alt') || /\\.(png|jpe?g|gif|svg|webp)$/i.test(el.getAttribute('alt'))",
    'a11y.form-label': "!document.querySelector('label[for=\"'+el.id+'\"]') && !el.getAttribute('aria-label') && !el.closest('label')",
    'a11y.control-name': "!el.textContent.trim() && !el.getAttribute('aria-label') && !el.getAttribute('title')",
    'a11y.heading-order': "el.tagName==='H4'",
    'type.text-small': "parseFloat(getComputedStyle(el).fontSize) < 12",
    'layout.h-overflow': "document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 && el.getBoundingClientRect().right > innerWidth + 1",
    'spacing.tight-targets': "(()=>{const r=el.getBoundingClientRect(),p=el.previousElementSibling.getBoundingClientRect();return r.height<44 && r.left-p.right<8})()",
    'a11y.focus-indicator': "[...document.styleSheets].some(ss=>[...ss.cssRules].some(r=>r.selectorText&&el.matches(r.selectorText)&&(r.style.outlineStyle==='none'||r.style.outline==='none'||r.style.outline==='0')))",
    'a11y.lang': "!document.documentElement.getAttribute('lang')",
    'type.line-height': "(()=>{const s=getComputedStyle(el);return parseFloat(s.lineHeight) < 1.2*parseFloat(s.fontSize) && el.getBoundingClientRect().height > 2*parseFloat(s.fontSize)})()",
}


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


@pytest.fixture(scope='module')
def base():
    port = free_port()
    proc = subprocess.Popen([sys.executable, os.path.join(SITE, 'serve.py'), str(port)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    for _ in range(50):
        try:
            socket.create_connection(('127.0.0.1', port), 0.2).close()
            break
        except OSError:
            time.sleep(0.1)
    yield 'http://127.0.0.1:%d' % port
    proc.kill()


@pytest.fixture(scope='module')
def browser():
    with playwright.sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


def open_page(browser, url):
    pg = browser.new_page(viewport={'width': VP['w'], 'height': VP['h']})
    pg.goto(url + ('&' if '?' in url else '?') + 'noreload')
    pg.wait_for_load_state('load')
    return pg


def dom_defect(pg, rule, ref):
    js = "(()=>{%s const el=document.getElementById(%s); if(!el) return null; return !!(%s)})()" % (LUM, json.dumps(ref), PRED[rule])
    return pg.evaluate(js)


def test_flaws_json_shape():
    assert len(FLAWS['flaws']) >= 14
    assert {f['flaw'] for f in FLAWS['flaws']} == set(range(1, 15))
    for f in FLAWS['flaws']:
        assert f['expect'] is True and f['rule'] in PRED and f['ref'] and not f['ref'].startswith('ok-')


def test_fixed_is_up_to_date():
    sys.path.insert(0, os.path.join(ROOT, 'demo', 'fixes'))
    import build
    with open(os.path.join(SITE, 'fixed', 'styles.css'), encoding='utf8', newline='') as f:
        before = f.read()
    build.build()
    with open(os.path.join(SITE, 'fixed', 'styles.css'), encoding='utf8', newline='') as f:
        after = f.read()
    assert before == after, 'run python demo/fixes/build.py'


def test_dom_flaws_present(base, browser):
    pg = open_page(browser, base + '/')
    missing = [(f['rule'], f['ref']) for f in FLAWS['flaws'] if dom_defect(pg, f['rule'], f['ref']) is not True]
    assert not missing, missing
    for c in FLAWS['controls']:
        assert pg.evaluate('!!document.getElementById(%s)' % json.dumps(c)), c
    pg.close()


def test_dom_fixed_has_no_flaws(base, browser):
    pg = open_page(browser, base + '/fixed/')
    left = [(f['rule'], f['ref']) for f in FLAWS['flaws'] if dom_defect(pg, f['rule'], f['ref']) is True]
    assert not left, left
    pg.close()


def test_ok_controls_are_healthy(base, browser):
    pg = open_page(browser, base + '/')
    r = pg.evaluate("""(()=>{%s
      const out={};
      out.lede=ratio(getComputedStyle(document.getElementById('ok-lede')).color,bgOf(document.getElementById('ok-lede')));
      out.img=document.getElementById('ok-feature-img').getAttribute('alt').length;
      out.label=!!document.querySelector('label[for=ok-name]');
      const b=document.getElementById('ok-subscribe').getBoundingClientRect(); out.btn=[b.width,b.height];
      return out})()""" % LUM)
    assert r['lede'] >= 6 and r['img'] > 10 and r['label'] and r['btn'][1] >= 44, r
    pg.close()


def run_engine(pg):
    pg.evaluate('(' + open(ENGINE, encoding='utf8').read() + ')()')
    return pg.evaluate('window.__pinpoint.audit()')


@pytest.mark.skipif(not os.path.exists(ENGINE), reason='engine/pinpoint-engine.js not landed yet (Package B)')
def test_engine_finds_every_flaw_and_no_ok_control(base, browser):
    pg = open_page(browser, base + '/')
    res = run_engine(pg)
    got = {(f['rule'], f.get('anchor', {}).get('ref')) for f in res['findings']}
    missing = [(f['rule'], f['ref']) for f in FLAWS['flaws'] if (f['rule'], f['ref']) not in got]
    assert not missing, missing
    assert not [g for g in got if (g[1] or '').startswith('ok-')]
    pg.close()


@pytest.mark.skipif(not os.path.exists(ENGINE), reason='engine/pinpoint-engine.js not landed yet (Package B)')
def test_engine_fixed_is_clean_and_scores_higher(base, browser):
    a = run_engine(open_page(browser, base + '/'))
    b = run_engine(open_page(browser, base + '/fixed/'))
    want = {(f['rule'], f['ref']) for f in FLAWS['flaws']}
    got = {(f['rule'], f.get('anchor', {}).get('ref')) for f in b['findings']}
    assert not (want & got), want & got
    assert b['score'] > a['score']
    print('score before/after', a['score'], b['score'])
