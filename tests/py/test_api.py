import importlib.util
import json
import sys
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
URL = "http://localhost:5173/"


def F(n, sev="high"):
    return {"id": f"a11y.contrast@{n:08x}", "pin": n, "rule": "a11y.contrast", "sev": sev, "selector": f"#e{n}",
            "label": "b", "note": "n", "fix": "f", "measured": {"ratio": 1.9}}


def AR(ns, score=50):
    fs = [F(n) for n in ns]
    return {"url": URL, "score": score, "counts": {"high": len(fs), "medium": 0, "low": 0}, "findings": fs, "rules_covered": ["a11y.contrast"]}


@pytest.fixture
def client(host):
    # load exactly like Hermes does: by path, standalone module, no parent package
    name = "hermes_dashboard_plugin_pinpoint"
    spec = importlib.util.spec_from_file_location(name, ROOT / "dashboard" / "plugin_api.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    app = FastAPI()
    app.include_router(mod.router, prefix="/api/plugins/pinpoint")
    yield TestClient(app)
    sys.modules.pop(name, None)


P = "/api/plugins/pinpoint"


def test_manifest_json():
    m = json.loads((ROOT / "dashboard" / "manifest.json").read_text("utf-8"))
    assert m["name"] == "pinpoint" and m["api"] == "plugin_api.py"


def test_health(client):
    r = client.get(P + "/health")
    assert r.status_code == 200
    j = r.json()
    assert j["ok"] is True and j["version"] == "0.1.0" and isinstance(j["pid"], int)


def test_version_matches_plugin_yaml(client):
    import re
    txt = (ROOT / "plugin.yaml").read_text("utf-8")
    assert re.search(r'^version: "0.1.0"', txt, re.M)


def _req_file(core, rid, session="s"):
    import time
    d = core.rv_dir()
    (d / f"{rid}.req.json").write_text(json.dumps(
        {"request_id": rid, "args": {"pin": True}, "session_id": session, "pv": core.PROTOCOL, "t": time.time()}))


def _claim(client, rid, session="s", window="A"):
    r = client.post(P + f"/ack/{rid}", json={"window": window, "session_id": session, "pv": 2})
    assert r.status_code == 200, r.text
    return r.json()["receipt"]


def _wire(rid, receipt, session="s", window="A", ok=True, result=None, code=None, message=None):
    body = {"request_id": rid, "pv": 2, "receipt": receipt, "session_id": session, "window": window, "ok": ok}
    if ok:
        body["result"] = result
    else:
        body["code"] = code
        body["message"] = message
    return body


def test_ack_exclusive_and_pending(client, core):
    # a request file as the tool handler would create
    _req_file(core, "r1")
    p = client.get(P + "/pending").json()
    assert [x["request_id"] for x in p["pending"]] == ["r1"]
    r = client.post(P + "/ack/r1", json={"window": "A", "session_id": "s", "pv": 2})
    assert r.status_code == 200 and r.json()["claimed"] is True and r.json()["receipt"]
    r = client.post(P + "/ack/r1", json={"window": "B", "session_id": "s", "pv": 2})
    assert r.status_code == 409 and r.json()["claimed"] is False
    assert client.get(P + "/pending").json()["pending"] == []
    assert client.post(P + "/ack/unknown", json={"pv": 2}).status_code == 409


def test_result_roundtrip_files(client, core):
    _req_file(core, "r2", session="")
    receipt = _claim(client, "r2", session="")
    d = core.rv_dir()
    body = _wire("r2", receipt, session="", result=AR([1]))
    assert client.post(P + "/result", json=body).status_code == 200
    saved = json.loads((d / "r2.res.json").read_text("utf-8"))
    assert saved["ok"] is True and saved["result"]["score"] == 50
    assert client.post(P + "/result", json=_wire("nope", "q" * 43, ok=False, code="no_preview", message="m")).status_code == 404


def test_result_error_form(client, core):
    _req_file(core, "r3", session="")
    receipt = _claim(client, "r3", session="")
    d = core.rv_dir()
    r = client.post(P + "/result", json=_wire("r3", receipt, session="", ok=False, code="consent_denied", message="x"))
    assert r.status_code == 200
    assert json.loads((d / "r3.res.json").read_text("utf-8"))["code"] == "consent_denied"


def test_result_large_300_findings_fits_envelope(client, core):
    _req_file(core, "r4", session="")
    receipt = _claim(client, "r4", session="")
    # 300 findings (the previous stress case) must stay well inside the 256 KiB envelope
    import json as _json
    assert len(_json.dumps({"request_id": "r4", "ok": True, "result": AR(range(300))}).encode("utf-8")) < core.RESULT_MAX_BYTES // 2
    r = client.post(P + "/result", json=_wire("r4", receipt, session="", result=AR(range(300))))
    assert r.status_code == 200


def test_audit_store_and_delta(client):
    r = client.post(P + "/audit", json={"result": AR([1, 2, 3], 40), "source": "user"})
    assert r.status_code == 200 and r.json()["audit_id"] == 1 and r.json()["delta"] is None
    r = client.post(P + "/audit", json={"result": AR([3], 80), "source": "auto"})
    d = r.json()["delta"]
    assert d["prev_score"] == 40 and len(d["fixed"]) == 2 and d["remaining"] == 1
    s = client.get(P + "/store", params={"url_key": "http://localhost:5173"}).json()
    assert s["last"]["score"] == 80 and {p["status"] for p in s["pins"]} == {"open", "fixed"}
    # url (not just key) also accepted, normalised
    assert client.get(P + "/store", params={"url_key": URL}).json()["last"]["score"] == 80


def test_audit_bad_body(client):
    assert client.post(P + "/audit", json={"source": "user"}).status_code == 422
    r = client.post(P + "/audit", json={"result": {"url": "nonsense"}, "source": "user"})
    assert r.status_code == 400


RESULT_CASES = json.loads((ROOT / "tests" / "shared" / "audit_result_cases.json").read_text("utf-8"))


@pytest.mark.parametrize("case", RESULT_CASES, ids=lambda c: c["name"])
def test_raw_result_boundary_through_rest(client, case):
    f = {"id": "a11y.control-name@412214a1", "rule": "a11y.control-name", "sev": "high"}
    base = {"url": URL, "score": 100, "findings": [], "rules_covered": [f["rule"]]}
    assert client.post(P + "/audit", json={"result": {**base, "findings": [f]}}).status_code == 200
    before = client.get(P + "/store", params={"url_key": URL}).json()
    incoming = {**base, **case["patch"]}
    for field in case.get("omit", []):
        incoming.pop(field, None)
    response = client.post(P + "/audit", json={"result": incoming})
    saved = client.get(P + "/store", params={"url_key": URL}).json()
    if case["fixed"]:
        assert response.status_code == 200
        assert response.json()["delta"]["fixed"] == [f["id"]]
        assert saved["pins"][0]["status"] == "fixed"
    else:
        assert response.status_code in (200, 400)
        if response.status_code == 200:
            assert response.json()["delta"]["fixed"] == []
            assert response.json()["delta"]["not_rechecked"] == [f["id"]]
        else:
            assert saved == before, "rejected results must not mutate persistence"
        assert saved["pins"][0]["status"] == "open"
        repaired = client.post(P + "/audit", json={"result": base})
        assert repaired.json()["delta"]["fixed"] == [f["id"]]


def test_store_empty(client):
    assert client.get(P + "/store", params={"url_key": "http://nowhere.test"}).json() == {"pins": [], "last": None}


def test_pins_actions_and_event(client, host):
    client.post(P + "/audit", json={"result": AR([1, 2]), "source": "user"})
    key = "http://localhost:5173"
    r = client.post(P + "/pins", json={"action": "dismiss", "url_key": key, "ids": [F(1)["id"]], "reason": "ok"})
    assert r.status_code == 200 and r.json()["changed"] == 1
    st = {p["id"]: p["status"] for p in client.get(P + "/store", params={"url_key": key}).json()["pins"]}
    assert st[F(1)["id"]] == "dismissed"
    assert client.post(P + "/pins", json={"action": "reopen", "url_key": key, "ids": [F(1)["id"]]}).json()["changed"] == 1
    assert client.post(P + "/pins", json={"action": "clear", "url_key": key}).status_code == 200
    assert client.get(P + "/store", params={"url_key": key}).json()["pins"] == []
    assert client.post(P + "/pins", json={"action": "explode", "url_key": key}).status_code == 400


def test_python_modules_not_shared_state(client, core):
    # the router must use files/SQLite only: a request made via the plugin-package module is visible
    import time
    core_req = core.rv_dir() / "r9.req.json"
    core_req.write_text(json.dumps({"request_id": "r9", "args": {}, "t": time.time()}))
    assert client.get(P + "/pending").json()["pending"][0]["request_id"] == "r9"
