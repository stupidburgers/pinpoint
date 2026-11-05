import re

import pytest

from test_rules_core import bad_ids, ok_ids


def findings(page, rule, opts=None):
    o = dict(opts or {})
    o["rules"] = [rule]
    res = page.pp.audit(o)
    assert not res["errors"], res["errors"]
    return res


# ---- heading order ----
def test_heading_order_exact_set(load):
    page = load("heading-order")
    assert page.pp.refs("a11y.heading-order") == bad_ids("heading-order")


def test_heading_order_notes(load):
    page = load("heading-order")
    res = findings(page, "a11y.heading-order")
    f = {x["anchor"]["ref"]: x for x in res["findings"]}
    assert "h2 to h4" in f["bad-1"]["note"] and f["bad-1"]["sev"] == "low"
    assert "h3 to h5" in f["bad-2"]["note"]
    assert "empty" in f["bad-3"]["note"]
    assert "more than one h1" in f["bad-4"]["note"].lower()


def test_heading_no_h1_anchors_first_heading(blank):
    page = blank('<html lang=en><head><title>t</title></head><body><h2 id="bad-1">a</h2><h3>b</h3></body></html>')
    res = findings(page, "a11y.heading-order")
    assert len(res["findings"]) == 1
    assert res["findings"][0]["anchor"]["ref"] == "bad-1" and "no h1" in res["findings"][0]["note"]


def test_heading_none_anchors_body(blank):
    page = blank('<html lang=en><head><title>t</title></head><body><p>no headings</p></body></html>')
    res = findings(page, "a11y.heading-order")
    assert [f["anchor"]["tag"] for f in res["findings"]] == ["body"]


def test_heading_ok_page_clean(blank):
    page = blank('<html lang=en><head><title>t</title></head><body><h1>a</h1><h2>b</h2><h3>c</h3><h2>d</h2></body></html>')
    assert findings(page, "a11y.heading-order")["findings"] == []


# ---- focus indicator ----
def test_focus_exact_set(load):
    page = load("focus")
    assert page.pp.refs("a11y.focus-indicator") == bad_ids("focus")


def test_focus_flags_are_heuristic_and_never_calls_focus(load):
    page = load("focus")
    page.evaluate("window.__focusCalls = 0; document.addEventListener('focusin', () => window.__focusCalls++, true)")
    res = findings(page, "a11y.focus-indicator")
    assert page.evaluate("window.__focusCalls") == 0
    assert res["findings"] and all(f["heuristic"] is True and f["confidence"] == "medium" and f["wcag"] == "2.4.7" for f in res["findings"])
    assert all(f["sev"] == "medium" for f in res["findings"])


def test_focus_cross_origin_sheet_limit(browser):
    ctx = browser.new_context()
    page = ctx.new_page()
    page.route("https://cdn.example/x.css", lambda r: r.fulfill(status=200, content_type="text/css", body="a{outline:none}"))
    page.route("https://site.example/", lambda r: r.fulfill(status=200, content_type="text/html", body=(
        '<html lang=en><head><title>t</title><link rel=stylesheet href="https://cdn.example/x.css"></head>'
        '<body><a id="a1" href="#x">link</a></body></html>')))
    page.goto("https://site.example/")
    from conftest import inject_js
    page.evaluate(inject_js())
    res = page.evaluate("window.__pinpoint.audit({rules:['a11y.focus-indicator']})")
    ctx.close()
    assert res["errors"] == []
    assert any("cross-origin stylesheets not scanned: 1" in l for l in res["limits"])


# ---- page level ----
def test_lang_missing_and_blank_and_present(blank):
    for html, n in [("<html><head><title>t</title></head><body>x</body></html>", 1),
                    ('<html lang=" "><head><title>t</title></head><body>x</body></html>', 1),
                    ('<html lang="pt-BR"><head><title>t</title></head><body>x</body></html>', 0)]:
        page = blank(html)
        res = findings(page, "a11y.lang")
        assert len(res["findings"]) == n
        if n:
            f = res["findings"][0]
            assert f["sev"] == "medium" and f["wcag"] == "3.1.1" and f["anchor"]["tag"] == "html" and f["selector"] == "html"


def test_page_title(blank):
    for html, n in [("<html lang=en><head></head><body>x</body></html>", 1),
                    ("<html lang=en><head><title>  </title></head><body>x</body></html>", 1),
                    ("<html lang=en><head><title>Hello</title></head><body>x</body></html>", 0)]:
        page = blank(html)
        res = findings(page, "a11y.page-title")
        assert len(res["findings"]) == n
        if n:
            assert res["findings"][0]["sev"] == "low" and res["findings"][0]["wcag"] == "2.4.2"


@pytest.mark.parametrize("content,n", [
    ("width=device-width, initial-scale=1", 0),
    ("width=device-width, user-scalable=no", 1),
    ("width=device-width, user-scalable=0", 1),
    ("width=device-width, maximum-scale=1", 1),
    ("width=device-width, maximum-scale=1.5", 1),
    ("width=device-width, maximum-scale=2", 0),
    ("width=device-width, maximum-scale=5, user-scalable=yes", 0),
])
def test_viewport_zoom(blank, content, n):
    page = blank(f'<html lang=en><head><title>t</title><meta name="viewport" content="{content}"></head><body>x</body></html>')
    res = findings(page, "a11y.viewport-zoom")
    assert len(res["findings"]) == n
    if n:
        assert res["findings"][0]["sev"] == "medium" and res["findings"][0]["wcag"] == "1.4.4"
        assert res["findings"][0]["selector"] == 'meta[name="viewport"]'


# ---- horizontal overflow ----
def test_h_overflow_exact_set_and_order(load):
    page = load("overflow", viewport=(800, 600))
    res = findings(page, "layout.h-overflow")
    refs = [f["anchor"]["ref"] for f in res["findings"]]
    assert set(refs) == bad_ids("overflow")
    assert refs[0] == "bad-1"  # sorted by overflow px desc
    f = res["findings"][0]
    assert f["measured"] == {"over": 400, "vw": 800} and f["sev"] == "medium" and f["wcag"] == "1.4.10"


def test_h_overflow_none_when_fits(blank):
    page = blank('<html lang=en><head><title>t</title></head><body><div style="width:300px">x</div></body></html>')
    assert findings(page, "layout.h-overflow")["findings"] == []


def test_h_overflow_hidden_root_not_reported(blank):
    page = blank('<html lang=en style="overflow-x:hidden"><head><title>t</title></head><body style="margin:0"><div style="width:1500px;height:5px"></div></body></html>')
    res = findings(page, "layout.h-overflow")
    assert res["findings"] == [] and any("hidden by overflow-x" in l for l in res["limits"])


def test_h_overflow_fallback_to_root(blank):
    page = blank('<html lang=en><head><title>t</title><style>body::after{content:"";display:block;width:1400px;height:1px}</style></head><body style="margin:0">x</body></html>')
    res = findings(page, "layout.h-overflow")
    assert len(res["findings"]) == 1
    f = res["findings"][0]
    assert f["anchor"]["tag"] == "html" and f["confidence"] == "medium"


def test_h_overflow_max_five(blank):
    items = "".join(f'<div id="bad-{i}" style="width:{1000 + i * 10}px;height:5px"></div>' for i in range(8))
    page = blank(f'<html lang=en><head><title>t</title></head><body style="margin:0">{items}</body></html>')
    assert len(findings(page, "layout.h-overflow")["findings"]) == 5


# ---- typography ----
def test_text_small_exact_set(load):
    page = load("text-small")
    assert page.pp.refs("type.text-small") == bad_ids("text-small")


def test_text_small_severity(load):
    page = load("text-small")
    res = findings(page, "type.text-small")
    f = {x["anchor"]["ref"]: x for x in res["findings"]}
    assert f["bad-1"]["sev"] == "medium" and f["bad-1"]["measured"] == {"px": 9}
    assert f["bad-2"]["sev"] == "low" and f["bad-3"]["sev"] == "low"
    assert f["bad-4"]["sev"] == "medium" and f["bad-4"]["measured"] == {"px": 9.5}


def test_line_height_exact_set(load):
    page = load("line-height")
    assert page.pp.refs("type.line-height") == bad_ids("line-height")


def test_line_height_measured(load):
    page = load("line-height")
    res = findings(page, "type.line-height")
    f = {x["anchor"]["ref"]: x for x in res["findings"]}
    assert f["bad-1"]["measured"]["lineHeight"] == 16 and f["bad-1"]["measured"]["fontSize"] == 16
    assert f["bad-1"]["measured"]["lines"] >= 2 and f["bad-1"]["sev"] == "low"


# ---- tight targets ----
def test_tight_exact_set(load):
    page = load("tight")
    assert page.pp.refs("spacing.tight-targets") == bad_ids("tight")


def test_tight_gap_measured_and_second_anchored(load):
    page = load("tight")
    res = findings(page, "spacing.tight-targets")
    f = {x["anchor"]["ref"]: x for x in res["findings"]}
    assert f["bad-1"]["measured"] == {"gap": 6} and f["bad-3"]["measured"] == {"gap": 0}
    assert f["bad-4"]["measured"] == {"gap": 4}
    assert "ok-1" not in f  # first of the pair is not flagged (pair reported once)


def test_all_rules_run_together_without_errors(load):
    page = load("tap")
    res = page.pp.audit()
    assert res["errors"] == []
    assert set(res["stats"]["checked"]) == {
        "a11y.contrast", "a11y.tap-target", "a11y.img-alt", "a11y.form-label", "a11y.control-name",
        "a11y.heading-order", "a11y.focus-indicator", "a11y.lang", "a11y.page-title", "a11y.viewport-zoom",
        "layout.h-overflow", "type.text-small", "type.line-height", "spacing.tight-targets"}
