import re

import pytest

T = "window.__pinpoint.__test"


@pytest.fixture()
def tp(load):
    return load("selectors", config={"test": True})


COLORS = [
    ("rgb(255, 0, 0)", (255, 0, 0, 1)),
    ("rgba(0, 0, 0, 0.5)", (0, 0, 0, 0.5)),
    ("rgb(10 20 30 / 50%)", (10, 20, 30, 0.5)),
    ("rgb(0 0 0/50%)", (0, 0, 0, 0.5)),
    ("rgb(100%, 0%, 50%)", (255, 0, 128, 1)),
    ("hsl(120, 100%, 50%)", (0, 255, 0, 1)),
    ("hsla(240 100% 50% / 0.25)", (0, 0, 255, 0.25)),
    ("#fff", (255, 255, 255, 1)),
    ("#11223380", (17, 34, 51, 0.5)),
    ("transparent", (0, 0, 0, 0)),
    ("color(srgb 1 0 0 / 0.5)", (255, 0, 0, 0.5)),
    ("rebeccapurple", (102, 51, 153, 1)),
    ("oklch(1 0 0)", (255, 255, 255, 1)),
    ("oklch(0 0 0)", (0, 0, 0, 1)),
    ("oklch(0.628 0.2577 29.23)", (255, 0, 0, 1)),
    ("color-mix(in srgb, red 50%, blue)", (128, 0, 128, 1)),
    ("color-mix(in oklab, white, black)", (99, 99, 99, 1)),
]


@pytest.mark.parametrize("src,want", COLORS)
def test_parse_color(tp, src, want):
    got = tp.evaluate(f"{T}.parseColor({src!r})")
    assert got is not None, src
    tol = 3 if ("oklch" in src or "oklab" in src or "mix" in src) else 1
    for k, w in zip("rgb", want[:3]):
        assert abs(got[k] - w) <= tol, (src, got)
    assert abs(got["a"] - want[3]) <= 0.02, (src, got)


def test_parse_color_garbage(tp):
    assert tp.evaluate(f"{T}.parseColor('not-a-color')") is None
    assert tp.evaluate(f"{T}.parseColor('')") is None


def test_ratio_known_values(tp):
    assert tp.evaluate(f"{T}.ratio({{r:0,g:0,b:0}}, {{r:255,g:255,b:255}})") == pytest.approx(21, abs=0.01)
    assert tp.evaluate(f"{T}.ratio({{r:119,g:119,b:119}}, {{r:255,g:255,b:255}})") == pytest.approx(4.48, abs=0.01)
    assert tp.evaluate(f"{T}.ratio({{r:255,g:255,b:255}}, {{r:255,g:255,b:255}})") == pytest.approx(1, abs=0.001)


@pytest.mark.parametrize("fg,bg,need", [
    ((170, 170, 170), (255, 255, 255), 4.5),
    ((200, 200, 200), (250, 245, 235), 4.5),
    ((130, 130, 160), (255, 255, 255), 3),
    ((90, 90, 90), (20, 20, 20), 4.5),
    ((120, 160, 200), (255, 255, 255), 7),
])
def test_suggest_fix_reaches_target(tp, fg, bg, need):
    f = f"{{r:{fg[0]},g:{fg[1]},b:{fg[2]}}}"
    b = f"{{r:{bg[0]},g:{bg[1]},b:{bg[2]}}}"
    res = tp.evaluate(f"{T}.suggestFix({f}, {b}, {need})")
    assert res["hex"].startswith("#") and len(res["hex"]) == 7
    c = tp.evaluate(f"{T}.parseColor({res['hex']!r})")
    r = tp.evaluate(f"{T}.ratio({{r:{c['r']},g:{c['g']},b:{c['b']}}}, {b})")
    assert r >= need
    assert res["dir"] in ("darker", "lighter")


def test_suggest_fix_unreachable(tp):
    res = tp.evaluate(f"{T}.suggestFix({{r:128,g:128,b:128}}, {{r:128,g:128,b:128}}, 7)")
    assert res["reachable"] is False


def test_fnv1a_known_vectors(tp):
    assert tp.evaluate(f"{T}.fnv1a('')") == "811c9dc5"
    assert tp.evaluate(f"{T}.fnv1a('a')") == "e40c292c"
    assert tp.evaluate(f"{T}.fnv1a('foobar')") == "bf9cf968"


def test_sanitize(tp):
    s = tp.evaluate(f"{T}.sanitize('a\\u0000b\\u202ec\\n\\td\\u2066e')")
    assert s == "abc d" + "e"


def test_selector_round_trip_all_elements(tp):
    n = tp.evaluate(f"""(() => {{
      const t = {T}; let bad = [];
      const all = [...document.querySelectorAll('body *')].filter(e => e.localName !== 'script');
      for (const el of all) {{ const s = t.selectorFor(el); if (t.resolve(s) !== el) bad.push(s); }}
      return {{n: all.length, bad}};
    }})()""")
    assert n["bad"] == [] and n["n"] > 25


def test_selector_prefers_stable_id(tp):
    assert tp.evaluate(f"{T}.selectorFor(document.getElementById('lnk-home'))") == "#lnk-home"
    assert tp.evaluate(f"{T}.selectorFor(document.getElementById('top'))") == "#top"


def test_selector_rejects_generated_and_duplicate_ids(tp):
    for i in ("react-12345678", "42424242", "dup", "1abc", "weird:id"):
        s = tp.evaluate(f"{T}.selectorFor(document.querySelector('[id=\"{i}\"]'))")
        assert not s.startswith("#" + i), (i, s)
    s = tp.evaluate(f"{T}.selectorFor(document.getElementById('gen-1'))")
    assert s == "#gen-1"


def test_selector_attr_forms(tp):
    s = tp.evaluate(f"{T}.selectorFor(document.querySelector('input[name=email]'))")
    assert s == 'input[name="email"]'
    s = tp.evaluate(f"{T}.selectorFor(document.querySelector('a[href=\"https://other.example/about\"]'))")
    assert s == 'a[href="https://other.example/about"]'
    s = tp.evaluate(f"{T}.selectorFor(document.querySelector('img[src*=team]'))")
    assert s == 'img[src$="team.png"]'


def test_selector_ignores_hashed_classes(tp):
    s = tp.evaluate(f"{T}.selectorFor(document.querySelectorAll('.css-9z8y7x6')[1])")
    assert "css-9z8y7x6" not in s and "css-1a2b3c4" not in s
    s = tp.evaluate(f"{T}.selectorFor(document.querySelectorAll('.card .btn')[2])")
    assert ".btn" in s


def test_selector_charset_and_length(tp):
    out = tp.evaluate(f"""(() => [...document.querySelectorAll('body *')].map(e => {T}.selectorFor(e)))()""")
    for s in out:
        assert len(s) <= 200
        assert re.fullmatch(r"[\w#.\-:>\[\]=\"'()*~+,/ $]+", s), s


def test_selector_shadow_and_iframe(tp):
    s = tp.evaluate(f"{T}.selectorFor(document.getElementById('host').shadowRoot.getElementById('sb'))")
    assert ">>>" in s
    ok = tp.evaluate(f"{T}.resolve({s!r}) === document.getElementById('host').shadowRoot.getElementById('sb')")
    assert ok
    ok = tp.evaluate(f"""(() => {{ const d = document.getElementById('frm').contentDocument;
      const el = d.getElementById('inner-p'); const s = {T}.selectorFor(el); return [s, {T}.resolve(s) === el]; }})()""")
    assert ok[1] is True and ">>>" in ok[0]


def test_fingerprint_ignores_class_style_alt_and_label(tp):
    res = tp.evaluate(f"""(() => {{
      const t = {T}; const b = document.querySelectorAll('.card .btn')[0];
      const a = t.fingerprint('a11y.tap-target', b);
      b.className = 'zzz'; b.style.color = 'red'; b.setAttribute('aria-label','x'); b.setAttribute('alt','y');
      return [a, t.fingerprint('a11y.tap-target', b)];
    }})()""")
    assert res[0] == res[1]


def test_fingerprint_changes_with_text_and_rule(tp):
    res = tp.evaluate(f"""(() => {{
      const t = {T}; const b = document.querySelectorAll('.card .btn')[0];
      return [t.fingerprint('r1', b), t.fingerprint('r2', b), t.fingerprint('r1', document.querySelectorAll('.card .btn')[1])];
    }})()""")
    assert len(set(res)) == 3


def test_id_format(tp):
    i = tp.evaluate(f"{T}.idFor('a11y.contrast', document.getElementById('lnk-home'))")
    assert re.fullmatch(r"a11y\.contrast@[0-9a-f]{8}", i)


def test_url_key(tp):
    k = tp.evaluate(f"{T}.urlKey('HTTP://Example.COM:8080/a/b/?utm_source=x&b=2&a=1&fbclid=z')")
    assert k == "http://example.com:8080/a/b?a=1&b=2"
    assert tp.evaluate(f"{T}.urlKey('http://x.io/#/route/1')") == "http://x.io#/route/1"
    assert tp.evaluate(f"{T}.urlKey('http://x.io/p/#section')") == "http://x.io/p"
