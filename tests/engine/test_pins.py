"""Overlay / pins: render, layout, statuses, events, focus, clear (SPEC 4.1, 8.1)."""
import time


def shadow(page, expr):
    return page.evaluate(f"() => {{ const sr = document.querySelector('[data-pp-root]').shadowRoot; return {expr}; }}")


def render_full(page, opts=None):
    o = opts or {}
    res = page.pp.audit(o)
    return page.pp.call("render", res["findings"], o), res


def pins_state(page):
    return shadow(page, "[...sr.querySelectorAll('.pin')].map(p => ({n: +p.getAttribute('aria-label').split(':')[0].replace('Pinpoint ', ''), "
                        "l: p.getAttribute('aria-label'), c: p.className, txt: p.textContent, hidden: p.hidden, t: p.style.transform}))")


def test_render_attaches_open_shadow_overlay(load):
    page = load("pins")
    r, res = render_full(page)
    assert page.evaluate("!!document.querySelector('[data-pp-root]').shadowRoot")
    style = page.evaluate("document.querySelector('[data-pp-root]').style.cssText")
    assert "z-index: 2147483647" in style and "pointer-events: none" in style
    offscreen = sum(1 for f in res["findings"] if f["rect"]["y"] > 1500)
    assert offscreen >= 2
    assert r["pinned"] == len(res["findings"]) - offscreen
    assert r["lost"] == []
    assert len(pins_state(page)) == len(res["findings"])


def test_pins_have_names_sev_class_and_match_finding_numbers(load):
    page = load("pins")
    _, res = render_full(page)
    pins = {p["n"]: p for p in pins_state(page)}
    for f in res["findings"]:
        p = pins[f["pin"]]
        assert f["rule"].split(".")[1] in p["l"]
        assert f["sev"] in p["c"]
        assert p["txt"] == str(f["pin"])


def test_collision_min_pairwise_distance_and_leaders(load):
    page = load("pins")
    render_full(page, {"tapAdvisory": 0})
    pos = shadow(page, "[...sr.querySelectorAll('.pin')].map(p => { const m = /translate\\(([-0-9.]+)px,\\s*([-0-9.]+)px\\)/.exec(p.style.transform); return p.hidden ? null : {x: +m[1] + 12, y: +m[2] + 12}; })")
    pos = [p for p in pos if p]
    assert len(pos) >= 12
    worst = min(((p1["x"] - p2["x"]) ** 2 + (p1["y"] - p2["y"]) ** 2) ** 0.5
                for i, p1 in enumerate(pos) for p2 in pos[i + 1:])
    assert worst >= 24, worst
    assert shadow(page, "[...sr.querySelectorAll('.lines line')].filter(l => l.style.display !== 'none').length") >= 2


def test_offscreen_no_pin_and_edge_clamped(load):
    page = load("pins")
    _, res = render_full(page)
    pins = {p["n"]: p for p in pins_state(page)}
    for f in res["findings"]:
        assert pins[f["pin"]]["hidden"] == (f["rect"]["y"] > 1500)
    vis = shadow(page, "[...sr.querySelectorAll('.pin')].filter(p=>!p.hidden).map(p => { const m = /translate\\(([-0-9.]+)px,\\s*([-0-9.]+)px\\)/.exec(p.style.transform); return {x: +m[1], y: +m[2]}; })")
    assert vis and all(0 < p["x"] < 790 and 0 < p["y"] < 590 for p in vis)


def test_lost_findings_returned_and_not_pinned(load):
    page = load("pins")
    _, res = render_full(page)
    ghost = {"id": "a11y.contrast@00000000", "rule": "a11y.contrast", "sev": "high", "selector": "#ghost",
             "label": "ghost", "note": "n", "fix": "f", "measured": {}, "rect": {"x": 5, "y": 5, "w": 10, "h": 10},
             "anchor": {"tag": "div", "role": "", "name": "", "textHash": "deadbeef", "ref": "ghost", "path": "div", "nameAttr": ""}}
    r = page.pp.call("render", res["findings"] + [ghost], {})
    assert r["lost"] == ["a11y.contrast@00000000"]
    assert r["pinned"] == shadow(page, "[...sr.querySelectorAll('.pin')].filter(p=>!p.hidden).length")


def test_render_replaces_previous_render(load):
    page = load("pins")
    render_full(page)
    r2, _ = render_full(page, {"rules": ["a11y.control-name"]})
    assert page.pp.call("probe")["pins"] == r2["pinned"]


def test_statuses_fixed_green_then_fades_and_dismissed(load):
    page = load("pins", config={"fadeMs": 120})
    _, res = render_full(page)
    ids = [f["id"] for f in res["findings"][:2]]
    page.pp.call("setStatuses", {ids[0]: "fixed", ids[1]: "dismissed"})
    st = shadow(page, "[...sr.querySelectorAll('.pin')].map(p => [p.className, p.textContent, p.hidden])")
    assert any(c[0].endswith("fixed") and c[1] == "✓" for c in st), st
    assert any("dismissed" in c[0] for c in st)
    offscreen = sum(1 for f in res["findings"] if f["rect"]["y"] > 1500)
    time.sleep(0.45)
    assert sum(1 for c in shadow(page, "[...sr.querySelectorAll('.pin')].map(p=>p.hidden)") if c) == offscreen + 1


def test_pin_click_card_events_and_dismiss(load):
    page = load("pins")
    render_full(page)
    page.pp.call("drain")
    page.click("[data-pp-root] .pin >> nth=0")
    evs = page.pp.call("drain")
    assert evs[-1]["type"] == "pin-click" and "@" in evs[-1]["id"]
    assert shadow(page, "sr.querySelector('.card').hidden") is False
    txt = shadow(page, "sr.querySelector('.card').textContent")
    assert "Fix:" in txt and "#1" in txt
    page.click("[data-pp-root] .card button.go")
    evs = page.pp.call("drain")
    assert evs[-1]["type"] == "fix"
    page.click('[data-pp-root] .card button:text-is("Dismiss")')
    evs = page.pp.call("drain")
    assert evs[-1]["type"] == "dismiss"
    assert shadow(page, "sr.querySelector('.card').hidden") is True
    assert any("dismissed" in c for c in shadow(page, "[...sr.querySelectorAll('.pin')].map(p=>p.className)"))


def test_escape_and_outside_click_close_card(load):
    page = load("pins")
    render_full(page)
    page.click("[data-pp-root] .pin >> nth=0")
    assert shadow(page, "sr.querySelector('.card').hidden") is False
    page.keyboard.press("Escape")
    assert shadow(page, "sr.querySelector('.card').hidden") is True
    page.click("[data-pp-root] .pin >> nth=1")
    page.mouse.click(400, 300)
    assert shadow(page, "sr.querySelector('.card').hidden") is True


def test_hover_shows_outline_on_target(load):
    page = load("pins")
    render_full(page)
    page.evaluate("document.querySelector('[data-pp-root]').shadowRoot.querySelector('.pin').dispatchEvent(new MouseEvent('mouseenter', {bubbles: false}))")
    assert shadow(page, "sr.querySelector('.hover').hidden") is False
    assert shadow(page, "sr.querySelector('.tip').hidden") is False
    page.evaluate("document.querySelector('[data-pp-root]').shadowRoot.querySelector('.pin').dispatchEvent(new MouseEvent('mouseleave', {bubbles: false}))")
    assert shadow(page, "sr.querySelector('.hover').hidden") is True


def test_focus_pin_scrolls_flashes_and_unknown(load):
    page = load("pins")
    _, res = render_full(page)
    fid = res["findings"][0]["id"]
    assert page.pp.call("focusPin", fid) is True
    assert shadow(page, "sr.querySelector('.hover').hidden") is False
    assert shadow(page, "getComputedStyle(sr.querySelector('.hover')).animationName") == "pp-f"
    assert page.pp.call("focusPin", "a11y.contrast@ffffffff") is False
    time.sleep(1.6)
    assert shadow(page, "sr.querySelector('.hover').hidden") is True


def test_clear_removes_overlay_keeps_dirty_detection(load):
    page = load("pins")
    render_full(page)
    assert page.pp.call("probe")["pins"] > 0
    page.pp.call("clear")
    assert page.evaluate("!!document.querySelector('[data-pp-root]')") is False
    assert page.pp.call("probe")["pins"] == 0
    page.evaluate("document.querySelector('body').appendChild(Object.assign(document.createElement('div'), {textContent: 'x'}))")
    assert page.pp.call("probe")["dirty"] is True
    evs = [e for e in page.pp.call("drain") if e["type"] == "dirty"]
    assert evs and evs[-1]["reason"] == "mutation"


def test_audit_excludes_overlay_but_self_passes(load):
    page = load("pins")
    before = page.pp.audit()["counts"]
    render_full(page)
    after = page.pp.audit()["counts"]
    assert after == before, f"overlay leaked into audit: {before} vs {after}"
    r2 = page.pp.audit({"_overlay": True, "rules": ["a11y.tap-target", "a11y.control-name", "a11y.contrast",
                                                    "a11y.form-label", "a11y.img-alt", "type.text-small",
                                                    "a11y.focus-indicator"], "tapAdvisory": 0})
    hits = [f for f in r2["findings"] if f["label"].startswith("button.pin")]
    assert hits == [], hits[:2]


def test_layout_budget(load):
    page = load("pins", config={"test": True})
    render_full(page, {"tapAdvisory": 0, "maxFindings": 60})
    ms = page.evaluate("""() => { const api = window.__pinpoint;
      const t0 = performance.now(); for (let i = 0; i < 10; i++) api.__test.layout(); return (performance.now() - t0) / 10; }""")
    assert ms < 2.0, ms
