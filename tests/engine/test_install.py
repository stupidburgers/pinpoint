import json


def test_probe_shape_and_size(load):
    page = load("blank")
    p = page.pp.call("probe")
    assert p["protocol"] == 1 and p["version"] == "0.1.0"
    assert set(p) == {"protocol", "version", "url", "key", "ready", "pins", "dirty", "vw", "vh", "docVersion", "inspecting", "selected"}
    assert p["ready"] is True and p["pins"] == 0 and p["dirty"] is False
    assert p["inspecting"] is False and p["selected"] is None
    assert p["vw"] == 800 and p["vh"] == 600
    assert len(json.dumps(p)) <= 300


def test_api_surface(load):
    page = load("blank")
    keys = page.evaluate("Object.keys(window.__pinpoint).sort()")
    assert keys == sorted(["protocol", "version", "audit", "render", "setStatuses", "focusPin",
                           "inspect", "setInspectMode", "inspectStep",
                           "clear", "drain", "probe", "destroy"])


def test_install_idempotent(load):
    page = load("blank")
    page.evaluate("window.__pinpoint.marker = 42")
    page.pp.inject()
    assert page.evaluate("window.__pinpoint.marker") == 42


def test_older_version_destroyed_first(load):
    page = load("blank", inject=False)
    page.evaluate("window.__old = 0; window.__pinpoint = {version: '0.0.1', destroy(){ window.__old++ }}")
    page.pp.inject()
    assert page.evaluate("window.__old") == 1
    assert page.evaluate("window.__pinpoint.version") == "0.1.0"


def test_destroy_removes_global_and_is_safe_twice(load):
    page = load("blank")
    page.evaluate("const api = window.__pinpoint; api.destroy(); api.destroy()")
    assert page.evaluate("typeof window.__pinpoint") == "undefined"


def test_probe_long_url_capped(load):
    page = load("blank")
    page.evaluate("history.replaceState(null, '', '?' + 'q'.repeat(600))")
    p = page.pp.call("probe")
    assert len(json.dumps(p)) <= 300


def test_test_hooks_only_with_config(load):
    page = load("blank")
    assert page.evaluate("typeof window.__pinpoint.__test") == "undefined"
    page2 = load("blank", config={"test": True})
    assert page2.evaluate("typeof window.__pinpoint.__test") == "object"


def test_audit_never_throws_on_empty_page(load):
    page = load("blank")
    r = page.pp.audit()
    assert r["protocol"] == 1 and r["score"] <= 100
