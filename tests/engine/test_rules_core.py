import re
from pathlib import Path

import pytest

HERE = Path(__file__).parent


def bad_ids(name):
    """ids named bad-* in a fixture (ground truth)."""
    html = (HERE / "fixtures" / (name + ".html")).read_text(encoding="utf-8")
    return set(re.findall(r'id="(bad-[\w-]+)"', html))


def ok_ids(name):
    html = (HERE / "fixtures" / (name + ".html")).read_text(encoding="utf-8")
    return set(re.findall(r'id="(ok-[\w-]+)"', html))


def test_contrast_exact_set(load):
    page = load("contrast")
    assert page.pp.refs("a11y.contrast") == bad_ids("contrast")


def test_contrast_no_findings_on_ok(load):
    page = load("contrast")
    assert not (page.pp.refs("a11y.contrast") & ok_ids("contrast"))


def test_contrast_measured_values(load):
    page = load("contrast")
    res = page.pp.audit({"rules": ["a11y.contrast"]})
    f = {x["anchor"]["ref"]: x for x in res["findings"]}
    b1 = f["bad-1"]
    assert b1["measured"]["ratio"] == pytest.approx(2.32, abs=0.01)
    assert b1["measured"]["need"] == 4.5
    assert b1["measured"]["fg"] == "#aaaaaa" and b1["measured"]["bg"] == "#ffffff"
    assert b1["sev"] == "high" and b1["wcag"] == "1.4.3"
    assert f["bad-8"]["sev"] == "medium"  # 3.54 >= 3
    assert "#" in b1["fix"] and "Darken" in b1["fix"]
    # alpha text composited over white: black @0.3 -> #b3b3b3
    assert f["bad-2"]["measured"]["fg"] == "#b3b3b3"
    # translucent stack: bg composited to #bfbfbf
    assert f["bad-4"]["measured"]["bg"] == "#bfbfbf"
    # opacity ancestor: #333 at 0.4 over white = #adadad
    assert f["bad-3"]["measured"]["fg"] == "#adadad"
    # bold 18px is not large: need 4.5; large text elsewhere needs 3
    assert f["bad-7"]["measured"]["need"] == 4.5


def test_contrast_fix_hint_reaches_target(load):
    page = load("contrast")
    res = page.pp.audit({"rules": ["a11y.contrast"]})
    for f in res["findings"]:
        m = re.search(r"to (#[0-9a-f]{6}) or", f["fix"])
        assert m, f["fix"]
        ratio = page.evaluate(
            """([fg,bg]) => { const t = (h)=>[1,3,5].map(i=>parseInt(h.slice(i,i+2),16));
            const l=(c)=>{const x=c.map(v=>{v/=255;return v<=0.04045?v/12.92:Math.pow((v+0.055)/1.055,2.4)});return 0.2126*x[0]+0.7152*x[1]+0.0722*x[2]};
            const a=l(t(fg)),b=l(t(bg));return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)}""",
            [m.group(1), f["measured"]["bg"]],
        )
        assert ratio >= f["measured"]["need"], (f["anchor"]["ref"], ratio)


def test_contrast_gradient_and_image_skipped_with_limits(load):
    page = load("contrast")
    res = page.pp.audit({"rules": ["a11y.contrast"]})
    assert "ok-grad" not in {f["anchor"]["ref"] for f in res["findings"]}
    assert any("contrast" in l and "skipped" in l for l in res["limits"])
    assert res["stats"]["skipped"]["a11y.contrast"]["image"] >= 2
    assert res["stats"]["skipped"]["a11y.contrast"]["overlap"] >= 1


def test_contrast_aaa_adds_findings(load):
    page = load("contrast")
    aaa = page.pp.refs("a11y.contrast", {"contrast": "AAA"})
    assert "aaa-1" in aaa and "ok-1" not in aaa
    assert bad_ids("contrast") <= aaa
    res = page.pp.audit({"rules": ["a11y.contrast"], "contrast": "AAA"})
    assert res["findings"][0]["wcag"] == "1.4.6"
    assert "aaa-1" not in page.pp.refs("a11y.contrast")


def test_contrast_dark_color_scheme(load):
    page = load("contrast-dark")
    assert page.pp.refs("a11y.contrast") == bad_ids("contrast-dark")
    res = page.pp.audit({"rules": ["a11y.contrast"]})
    assert all(f["measured"]["bg"] == "#121212" for f in res["findings"])


def test_dark_canvas_colour_matches_real_render(load, tmp_path):
    """The assumed dark canvas (#121212) must equal what Chromium paints."""
    page = load("contrast-dark")
    import base64
    png = page.screenshot(clip={"x": 700, "y": 500, "width": 4, "height": 4})
    px = page.evaluate(
        """async (b64) => { const i = new Image(); i.src = 'data:image/png;base64,' + b64; await i.decode();
        const c = document.createElement('canvas'); c.width = c.height = 4; const x = c.getContext('2d');
        x.drawImage(i, 0, 0); return [...x.getImageData(1, 1, 1, 1).data]; }""",
        base64.b64encode(png).decode(),
    )
    assert px[:3] == [18, 18, 18]


# ---------------- tap targets ----------------

def test_tap_exact_set_default_advisory(load):
    page = load("tap")
    got = page.pp.refs("a11y.tap-target")
    assert got == bad_ids("tap") | {"low-1", "low-2"}


def test_tap_advisory_off(load):
    page = load("tap")
    assert page.pp.refs("a11y.tap-target", {"tapAdvisory": 0}) == bad_ids("tap")


def test_tap_severity_and_measured(load):
    page = load("tap")
    res = page.pp.audit({"rules": ["a11y.tap-target"]})
    f = {x["anchor"]["ref"]: x for x in res["findings"]}
    assert f["bad-1"]["sev"] == "medium" and f["bad-1"]["wcag"] == "2.5.8"
    assert f["bad-1"]["measured"] == {"w": 18, "h": 18, "min": 24}
    assert f["low-1"]["sev"] == "low" and f["low-1"]["wcag"] == "2.5.5"
    assert f["low-2"]["measured"]["w"] == 24


def test_tap_ok_never_flagged(load):
    page = load("tap")
    assert not (page.pp.refs("a11y.tap-target") & ok_ids("tap"))


def test_tap_min_option(load):
    page = load("tap")
    # with tapMin 30 the 24x24 low-2 button becomes undersized (and its neighbour is ok-1... isolated -> exempt)
    got = page.pp.refs("a11y.tap-target", {"tapMin": 30, "tapAdvisory": 0})
    assert bad_ids("tap") <= got


# ---------------- images ----------------

def test_img_alt_exact_set(load):
    page = load("img-alt")
    assert page.pp.refs("a11y.img-alt") == bad_ids("img-alt")


def test_img_alt_messages(load):
    page = load("img-alt")
    res = page.pp.audit({"rules": ["a11y.img-alt"]})
    f = {x["anchor"]["ref"]: x for x in res["findings"]}
    assert f["bad-1"]["sev"] == "high" and f["bad-1"]["wcag"] == "1.1.1"
    assert "no alt" in f["bad-1"]["note"]
    assert "file name" in f["bad-2"]["note"]


# ---------------- form labels ----------------

def test_form_label_exact_set(load):
    page = load("form-label")
    assert page.pp.refs("a11y.form-label") == bad_ids("form-label")


def test_form_label_placeholder_note(load):
    page = load("form-label")
    res = page.pp.audit({"rules": ["a11y.form-label"]})
    f = {x["anchor"]["ref"]: x for x in res["findings"]}
    assert "placeholder" in f["bad-2"]["note"]
    assert f["bad-1"]["wcag"] == "1.3.1" and f["bad-1"]["sev"] == "high"


# ---------------- control names ----------------

def test_control_name_exact_set(load):
    page = load("control-name")
    assert page.pp.refs("a11y.control-name") == bad_ids("control-name")


def test_control_name_fields(load):
    page = load("control-name")
    res = page.pp.audit({"rules": ["a11y.control-name"]})
    assert all(f["sev"] == "high" and f["wcag"] == "4.1.2" for f in res["findings"])
