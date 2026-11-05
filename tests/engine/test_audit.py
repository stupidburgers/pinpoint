import json
import re
from pathlib import Path

import pytest

from conftest import FIXTURES

RULES = ["a11y.contrast", "a11y.tap-target", "a11y.img-alt", "a11y.form-label", "a11y.control-name",
         "a11y.heading-order", "a11y.focus-indicator", "a11y.lang", "a11y.page-title", "a11y.viewport-zoom",
         "layout.h-overflow", "type.text-small", "type.line-height", "spacing.tight-targets"]
HEAD = '<html lang="en"><head><title>t</title></head><body style="margin:0;font:16px Arial">'
IMG = "data:image/gif;base64,R0lGODlhAQABAAAAACw="


def audit(page, **o):
    return page.pp.audit(o)


# ---------------- score (hand computed: 100 - sum(w * k)) ----------------

def small_texts(n):
    return "".join(f'<p style="font-size:11px">small text number {i}</p>' for i in range(n))


def imgs(n):
    return "".join(f'<img width="20" height="20" src="{IMG}" id="i{i}">' for i in range(n))


SCORE_TABLE = [
    ("<p>nothing wrong</p>", ["type.text-small"], 100),
    (small_texts(1), ["type.text-small"], 99),                      # low 1
    (small_texts(5), ["type.text-small"], 95),                      # 5 x 1
    (small_texts(7), ["type.text-small"], 95),                      # 5 + 2*0.25 = 5.5 -> 94.5 -> 95 (half up)
    (small_texts(9), ["type.text-small"], 94),                      # 5 + 4*0.25 = 6 -> 94
    (imgs(1), ["a11y.img-alt"], 92),                                # high 8
    (imgs(7), ["a11y.img-alt"], 56),                                # 5*8 + 2*2 = 44
    (imgs(40), ["a11y.img-alt"], 0),                                # 40 + 35*2 = 110 -> clamp 0
    (imgs(1) + small_texts(1), ["a11y.img-alt", "type.text-small"], 91),  # 8 + 1 across rules
]


@pytest.mark.parametrize("body,rules,want", SCORE_TABLE)
def test_score_table(blank, body, rules, want):
    page = blank(HEAD + body + "</body></html>")
    res = audit(page, rules=rules)
    assert res["score"] == want and isinstance(res["score"], int)


def test_score_medium_weight_and_mixed(blank):
    page = blank('<html><head></head><body><img width="20" height="20" src="' + IMG + '"></body></html>')
    res = audit(page, rules=["a11y.lang", "a11y.page-title", "a11y.img-alt"])
    # lang medium 4 + title low 1 + img high 8 = 13
    assert res["score"] == 87
    assert res["counts"] == {"high": 1, "medium": 1, "low": 1}
    assert res["byRule"] == {"a11y.lang": 1, "a11y.page-title": 1, "a11y.img-alt": 1}


def test_truncated_result_cannot_prove_absence_of_untouched_target(blank):
    page = blank(HEAD + '<button id="bad"></button></body></html>')
    initial = audit(page, rules=["a11y.control-name"])
    target = initial["findings"][0]["id"]
    page.evaluate("""() => {
      const bad = document.getElementById('bad');
      for (let i=0;i<200;i++) { const b=document.createElement('button'); b.id='early-'+i; bad.before(b); }
    }""")
    result = audit(page, rules=["a11y.control-name"])
    assert target not in [f["id"] for f in result["findings"]]
    assert any("truncated" in s for s in result["limits"])
    assert result["rules_covered"] == []
    assert page.locator('#bad').get_attribute('aria-label') is None


def test_global_finalization_error_cannot_prove_absence(blank):
    page = blank(HEAD + '<button id="bad"></button></body></html>')
    result = audit(page, rules=["a11y.control-name"], suppress={})
    assert any(e["rule"] == "engine" for e in result["errors"])
    assert result["rules_covered"] == []


def test_result_shape(load):
    page = load("tap")
    r = audit(page)
    for k in ("protocol", "url", "key", "title", "viewport", "scroll", "t", "score", "counts", "byRule",
              "findings", "stats", "limits", "errors"):
        assert k in r
    assert r["protocol"] == 1 and r["viewport"] == {"w": 800, "h": 600, "dpr": 1}
    assert set(r["stats"]) >= {"elements", "ms", "checked"}
    f = r["findings"][0]
    for k in ("id", "rule", "sev", "confidence", "selector", "label", "note", "fix", "measured", "rect", "anchor", "pin"):
        assert k in f
    assert re.fullmatch(r"[a-z0-9.\-]+@[0-9a-f]{8}", f["id"])
    assert set(f["anchor"]) == {"tag", "role", "name", "textHash", "ref", "path", "nameAttr"}
    assert set(f["rect"]) == {"x", "y", "w", "h"}
    assert len(f["label"]) <= 40 and len(f["selector"]) <= 200


def test_findings_sorted_severity_then_document_order_and_pins(load):
    page = load("contrast")
    r = audit(page)
    rank = {"high": 0, "medium": 1, "low": 2}
    sevs = [rank[f["sev"]] for f in r["findings"]]
    assert sevs == sorted(sevs)
    assert [f["pin"] for f in r["findings"]] == list(range(1, len(r["findings"]) + 1))


# ---------------- determinism / options ----------------

def strip_volatile(r):
    r = json.loads(json.dumps(r))
    r.pop("t")
    r["stats"].pop("ms")
    return r


@pytest.mark.parametrize("fx", ["contrast", "tap", "focus", "heading-order", "overflow", "form-label"])
def test_determinism(load, fx):
    page = load(fx)
    a, b = audit(page), audit(page)
    assert strip_volatile(a) == strip_volatile(b)


def test_suppress_removes_ids_and_recomputes_score(load):
    page = load("img-alt")
    r1 = audit(page, rules=["a11y.img-alt"])
    ids = [f["id"] for f in r1["findings"]][:2]
    r2 = audit(page, rules=["a11y.img-alt"], suppress=ids)
    assert not ({f["id"] for f in r2["findings"]} & set(ids))
    assert len(r2["findings"]) == len(r1["findings"]) - 2
    assert r2["score"] > r1["score"] and r2["counts"]["high"] == r1["counts"]["high"] - 2


def test_max_findings_truncates_but_counts_everything(load):
    page = load("img-alt")
    full = audit(page, rules=["a11y.img-alt"])
    cut = audit(page, rules=["a11y.img-alt"], maxFindings=3)
    assert len(cut["findings"]) == 3
    assert cut["score"] == full["score"] and cut["counts"] == full["counts"]
    assert any("truncated" in l for l in cut["limits"])
    assert [f["id"] for f in cut["findings"]] == [f["id"] for f in full["findings"][:3]]


def test_rules_filter_and_unknown_rule(load):
    page = load("tap")
    r = audit(page, rules=["a11y.lang", "no.such.rule"])
    assert set(r["stats"]["checked"]) == {"a11y.lang"}
    assert set(r.get("rules_covered", [])) == {"a11y.lang"}
    assert r["errors"] == [{"rule": "no.such.rule", "message": "unknown rule"}]


def test_audit_never_throws_on_bad_opts(load):
    page = load("tap")
    for o in [None, {"rules": 5}, {"maxFindings": "x"}, {"suppress": None}, {"tapMin": -3}, {"contrast": "zzz"}]:
        r = page.evaluate("(o) => window.__pinpoint.audit(o)", o)
        assert r["protocol"] == 1


def test_rule_exception_goes_to_errors(load):
    page = load("tap", config={"test": True})
    page.evaluate("""() => { const o = document.querySelectorAll; Document.prototype.querySelectorAll = function(){ throw new Error('boom') }; window.__restore = () => { Document.prototype.querySelectorAll = o } }""")
    r = audit(page)
    page.evaluate("window.__restore()")
    assert r["protocol"] == 1 and isinstance(r["errors"], list)


# ---------------- ids ----------------

def test_ids_stable_when_banner_inserted_and_classes_change(load):
    page = load("img-alt")
    a = {f["anchor"]["ref"]: f["id"] for f in audit(page, rules=["a11y.img-alt"])["findings"]}
    page.evaluate("""() => { const d = document.createElement('div'); d.textContent = 'banner'; document.body.insertBefore(d, document.body.firstChild);
      document.querySelectorAll('img').forEach(i => { i.className = "zz"; }); }""")
    b = {f["anchor"]["ref"]: f["id"] for f in audit(page, rules=["a11y.img-alt"])["findings"]}
    assert a == b


def test_applying_fixes_makes_ids_vanish_without_new_ones(load):
    page = load("form-label")
    before = {f["id"] for f in audit(page, rules=["a11y.form-label"])["findings"]}
    page.evaluate("""() => document.querySelectorAll('[id^=bad-]').forEach(e => e.setAttribute('aria-label', 'Fixed ' + e.id))""")
    after = audit(page, rules=["a11y.form-label"])
    assert before and after["findings"] == []

    page = load("img-alt")
    before = {f["id"] for f in audit(page, rules=["a11y.img-alt"])["findings"]}
    page.evaluate("""() => { document.querySelectorAll('img[id^=bad-],input[id^=bad-]').forEach(e => { e.setAttribute('alt', 'Described ' + e.id); e.removeAttribute('role') });
      document.querySelectorAll('[role=img][id^=bad-]').forEach(e => e.setAttribute('aria-label', 'x')) }""")
    assert audit(page, rules=["a11y.img-alt"])["findings"] == []

    page = load("contrast")
    page.evaluate("""() => { document.querySelectorAll('[id^=bad-]').forEach(e => { e.style.color = '#000'; e.style.opacity = '1'; e.style.backgroundColor = '#fff' });
      document.querySelectorAll('[id^=bad-]').forEach(e => { let n = e.parentElement; while (n && n !== document.body) { n.style.opacity = '1'; n = n.parentElement } }) }""")
    res = audit(page, rules=["a11y.contrast"])
    assert res["findings"] == []


def test_duplicate_elements_get_distinct_ids(blank):
    page = blank(HEAD + f'<div><img width="20" height="20" src="{IMG}"><img width="20" height="20" src="{IMG}"></div></body></html>')
    ids = [f["id"] for f in audit(page, rules=["a11y.img-alt"])["findings"]]
    assert len(ids) == 2 and len(set(ids)) == 2


def test_ids_same_across_page_reload(load):
    page = load("img-alt")
    a = [f["id"] for f in audit(page)["findings"]]
    page.reload()
    page.pp.inject()
    b = [f["id"] for f in audit(page)["findings"]]
    assert a == b


# ---------------- selector round trip on every fixture ----------------

@pytest.mark.parametrize("name", sorted(p.stem for p in FIXTURES.glob("*.html") if p.stem not in ("blank",)))
def test_selector_round_trip_100_percent(load, name):
    page = load(name, config={"test": True})
    r = audit(page, maxFindings=1000)
    assert r["errors"] == []
    bad = page.evaluate("""(sels) => sels.filter(s => { const e = window.__pinpoint.__test.resolve(s[0]); return !e || (s[1] && e.id !== s[1]) }).map(s => s[0])""",
                        [[f["selector"], f["anchor"]["ref"]] for f in r["findings"]])
    assert bad == []


# ---------------- performance & large pages ----------------

def big_page(cards):
    out = [HEAD]
    for i in range(cards):
        extra = f'<img width="20" height="20" src="{IMG}">' if i % 60 == 0 else ""
        out.append(f'<div class="card"><h3>Title {i}</h3><p>Some text number {i} <a href="#l{i}">link {i}</a></p><button>Go {i}</button>{extra}</div>')
    out.append("</body></html>")
    return "".join(out)


def test_perf_4800_elements_under_400ms(blank):
    page = blank(big_page(950))
    n = page.evaluate("document.querySelectorAll('*').length")
    assert 4500 < n <= 5000
    best = min(audit(page)["stats"]["ms"] for _ in range(3))
    r = audit(page)
    assert r["stats"]["elements"] > 4500
    assert not any("large page" in l for l in r["limits"])
    assert best < 400, best


def test_large_page_switches_to_viewport_mode(blank):
    page = blank(big_page(1400) + "")
    n = page.evaluate("document.querySelectorAll('*').length")
    assert n > 5000
    r = audit(page)
    assert any("large page" in l and "viewport" in l for l in r["limits"])
    assert r["stats"]["ms"] < 800
    # a far-away bad image is excluded; one near the top is present
    refs = {f["selector"] for f in r["findings"] if f["rule"] == "a11y.img-alt"}
    assert 0 < len(refs) < 1400 // 60 + 1
