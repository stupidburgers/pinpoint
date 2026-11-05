"""B7: live tracking - banner shifts, scroll, resize, re-render re-resolution, dirty events."""
import re


def render_full(page, opts=None):
    res = page.pp.audit(opts or {})
    return page.pp.call("render", res["findings"], opts or {}), res


def pins(page):
    return page.evaluate(
        "() => [...document.querySelector('[data-pp-root]').shadowRoot.querySelectorAll('.pin')]"
        ".map(p => ({l: p.getAttribute('aria-label'), hidden: p.hidden, t: p.style.transform}))")


def pin_xy(pin):
    m = re.search(r"translate\(([-0-9.]+)px,\s*([-0-9.]+)px\)", pin["t"])
    return float(m.group(1)), float(m.group(2))


def idx_of(res, ref, rule):
    for f in res["findings"]:
        if f["anchor"]["ref"] == ref and f["rule"] == rule:
            return f["pin"] - 1
    raise AssertionError(f"no finding {ref}/{rule}")


def test_banner_insert_120px_followed_within_100ms(load):
    page = load("pins")
    _, res = render_full(page)
    i = idx_of(res, "gone", "a11y.control-name")
    t0 = pin_xy(pins(page)[i])
    ms = page.evaluate(
        f"""async () => {{ const pins = [...document.querySelector('[data-pp-root]').shadowRoot.querySelectorAll('.pin')];
        const pin = pins[{i}]; const t0 = performance.now(); const before = pin.style.transform;
        const b = document.createElement('div'); b.style.cssText = 'height:120px;background:#eee';
        document.body.prepend(b);
        while (performance.now() - t0 < 500) {{
          await new Promise(r => requestAnimationFrame(r));
          if (pin.style.transform !== before) break;
        }}
        return performance.now() - t0; }}""")
    assert ms < 100, ms
    t1 = pin_xy(pins(page)[i])
    # pin centre (transform + 12) is now anchored at the shifted target's top
    assert abs(t1[1] + 12 - 120) < 2, (t0, t1)


def test_scroll_toggles_hidden_for_clamped_targets(load):
    page = load("pins")
    _, res = render_full(page)
    i = idx_of(res, "t1", "a11y.control-name")
    assert pins(page)[i]["hidden"] is False
    page.evaluate("window.scrollTo(0, 400)")
    page.wait_for_timeout(150)
    assert pins(page)[i]["hidden"] is True
    page.evaluate("window.scrollTo(0, 0)")
    page.wait_for_timeout(150)
    assert pins(page)[i]["hidden"] is False


def test_scroll_to_bottom_shows_lower_pins(load):
    page = load("pins")
    _, res = render_full(page, {"maxFindings": 80})
    hb = sum(1 for p in pins(page) if p["hidden"])
    assert hb >= 2
    i = idx_of(res, "f1", "a11y.control-name")
    assert pins(page)[i]["hidden"] is True
    page.evaluate("window.scrollTo(0, 2500)")
    page.wait_for_timeout(200)
    assert pins(page)[i]["hidden"] is False


def test_resize_repositions_and_marks_dirty(load):
    page = load("pins")
    _, res = render_full(page)
    i1 = idx_of(res, "v1", "a11y.control-name")
    page.pp.call("drain")
    before = pin_xy(pins(page)[i1])
    assert before[0] > 600 and pins(page)[i1]["hidden"] is False
    # partially visible target: its pin clamps into the new viewport
    page.set_viewport_size({"width": 770, "height": 600})
    page.wait_for_timeout(150)
    st = pins(page)[i1]
    assert st["hidden"] is False and pin_xy(st)[0] <= 770 - 14 - 12 + 1, st
    # fully outside target: no pin until scrolled to it (SPEC 8.1)
    page.set_viewport_size({"width": 500, "height": 600})
    page.wait_for_timeout(150)
    assert pins(page)[i1]["hidden"] is True
    evs = [e for e in page.pp.call("drain") if e["type"] == "dirty"]
    assert evs and evs[-1]["reason"] == "resize"


def test_rerender_clone_reresolved_by_selector(load):
    page = load("pins")
    _, res = render_full(page)
    i = idx_of(res, "t1", "a11y.control-name")
    assert pins(page)[i]["hidden"] is False
    page.evaluate("() => { const o = document.getElementById('t1'); o.replaceWith(o.cloneNode(true)); }")
    page.wait_for_timeout(150)
    assert pins(page)[i]["hidden"] is False
    page.evaluate("document.getElementById('t1').style.left = '400px'")
    page.wait_for_timeout(150)
    st3 = pins(page)[i]
    assert st3["hidden"] is False and pin_xy(st3)[0] > 300, st3


def test_navigation_marks_dirty_with_url_key_updated(load):
    page = load("pins", config={"test": True})
    page.pp.call("drain")
    k0 = page.evaluate("window.__pinpoint.__test.urlKey(location.href)")
    v0 = page.pp.call("probe")["docVersion"]
    page.evaluate("history.pushState(null, '', '#/deeper')")
    assert page.evaluate("window.__pinpoint.__test.urlKey(location.href)") == k0 + "#/deeper"
    p = page.pp.call("probe")
    assert p["dirty"] is True and p["docVersion"] > v0
    evs = [e for e in page.pp.call("drain") if e["type"] == "dirty"]
    assert evs and evs[-1]["reason"] == "navigation"


def test_overlay_mutation_is_ignored_by_own_observer(load):
    page = load("pins")
    page.pp.audit()
    page.pp.call("drain")
    render_full(page)
    page.wait_for_timeout(60)
    evs = [e for e in page.pp.call("drain") if e["type"] == "dirty"]
    assert evs == [], evs[:2]


def test_watchdog_rect_checksum_repositions(load):
    page = load("pins")
    _, res = render_full(page)
    i = idx_of(res, "gone", "a11y.control-name")
    t0 = pin_xy(pins(page)[i])
    assert abs(t0[1] + 12 - 14) < 2  # started clamped at the 14px margin
    page.evaluate("document.getElementById('gone-holder').style.marginTop = '260px'")
    page.wait_for_timeout(1400)
    t1 = pin_xy(pins(page)[i])
    assert abs(t1[1] + 12 - 260) < 2, (t0, t1)


def test_inspect_and_audit_inspect_selector_and_present_anchors(blank):
    page = blank("""
      <main id="app" style="display:flex;gap:12px;padding:16px">
        <button id="cta" style="padding:8px 16px;margin:4px;font-size:16px;font-weight:600;color:#111111;background:#ffffff">Launch</button>
        <button id="secondary">Cancel</button>
      </main>
    """)
    res = page.pp.call("audit", {"inspectSelector": "#cta"})
    assert isinstance(res.get("presentAnchors"), list) and len(res["presentAnchors"]) >= 3
    assert any(a.startswith("button|#cta|") for a in res["presentAnchors"])
    insp = res.get("inspected")
    assert insp is not None
    assert insp["selector"] == "#cta" and insp["tag"] == "button" and insp["role"] == "button"
    assert insp["name"] == "Launch" and "Launch" in insp["label"]
    assert set(insp["rect"]) == {"x", "y", "w", "h"} and insp["rect"]["w"] > 0
    assert insp["boxModel"]["padding"] == "8px 16px" and insp["boxModel"]["margin"] == "4px"
    assert insp["typography"]["fontSize"] == "16px" and insp["typography"]["fontWeight"] == "600"
    assert insp["colors"]["fg"] == "#111111" and insp["colors"]["bg"] == "#ffffff"
    assert insp["colors"]["contrastRatio"] > 15
    assert insp["parentSelector"] == "#app" and insp["childCount"] == 0
    el_insp = page.evaluate("window.__pinpoint.inspect(document.getElementById('cta'))")
    assert el_insp["selector"] == "#cta"


def test_design_mode_hover_click_keyboard_and_send_to_hermes(blank):
    page = blank("""
      <section id="wrap" style="padding:20px">
        <div id="first" style="width:120px;height:40px">First<span id="kid">Child</span></div>
        <div id="second" style="width:120px;height:40px">Second</div>
      </section>
    """)
    st = page.pp.call("setInspectMode", True)
    assert st["inspecting"] is True
    assert page.pp.call("probe")["inspecting"] is True

    # Hover #first -> HUD visible inside shadow root
    box = page.locator("#first").bounding_box()
    page.mouse.move(box["x"] + 10, box["y"] + 10)
    hud_hidden = page.evaluate("document.querySelector('[data-pp-root]').shadowRoot.querySelector('.ihud').hidden")
    assert hud_hidden is False

    # Click #first -> locks selection and opens in-page Design Card
    page.mouse.click(box["x"] + 10, box["y"] + 10)
    p = page.pp.call("probe")
    assert p["selected"]["selector"] == "#first"
    card_open = page.evaluate("document.querySelector('[data-pp-root]').shadowRoot.querySelector('.card.dcard') !== null")
    assert card_open is True

    # Keyboard navigation: ArrowDown -> #kid, ArrowUp -> #first, ArrowRight -> #second, ArrowLeft -> #first
    page.keyboard.press("ArrowDown")
    assert page.pp.call("probe")["selected"]["selector"] == "#kid"
    page.keyboard.press("ArrowUp")
    assert page.pp.call("probe")["selected"]["selector"] == "#first"
    page.keyboard.press("ArrowRight")
    assert page.pp.call("probe")["selected"]["selector"] == "#second"
    page.keyboard.press("ArrowLeft")
    assert page.pp.call("probe")["selected"]["selector"] == "#first"

    # Click Send to Hermes in shadow root Design Card -> pushes { type: 'design', target, note, t } to drain()
    page.evaluate("""() => {
      const sr = document.querySelector('[data-pp-root]').shadowRoot;
      sr.querySelector('.dchip').click();
      const btns = Array.from(sr.querySelectorAll('.card.dcard .go'));
      btns[0].click();
    }""")
    evs = page.pp.call("drain")
    design_evs = [e for e in evs if e.get("type") == "design"]
    assert len(design_evs) == 1
    assert design_evs[0]["target"]["selector"] == "#first"
    assert "Spacing" in design_evs[0]["note"]

    # Escape exits inspect mode
    page.keyboard.press("Escape")
    assert page.pp.call("probe")["inspecting"] is False
