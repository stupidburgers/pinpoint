"""H1 rendezvous-binding regressions (threat contract invariant table).

Lifecycle: pending -> claimed -> single completed -> expired/cleaned.
A result requires a prior exclusive claim, the server-minted receipt, and the
claimed session/window. Publication is atomic and no-clobber. The receipt must
never appear in /pending, broadcast events, the stored result file or logs.
"""
import importlib.util
import json
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
P = "/api/plugins/pinpoint"


@pytest.fixture
def api(host):
    name = "hermes_dashboard_plugin_pinpoint_h1"
    spec = importlib.util.spec_from_file_location(name, ROOT / "dashboard" / "plugin_api.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    app = FastAPI()
    app.include_router(mod.router, prefix=P)
    yield TestClient(app)
    sys.modules.pop(name, None)


def make_req(core, rid, session="sessA", age=0.0):
    d = core.rv_dir()
    (d / f"{rid}.req.json").write_text(json.dumps(
        {"request_id": rid, "args": {}, "session_id": session, "pv": core.PROTOCOL,
         "t": time.time() - age}))


def acked(core, rid, session="sessA", window="wA"):
    make_req(core, rid, session)
    out = core.claim_ack(rid, window, session)
    assert out["claimed"] is True
    return out["receipt"]


_UNSET = object()


def v2_result(rid, receipt, session="sessA", window="wA", ok=True, result=_UNSET, code=None, message=None):
    body = {"request_id": rid, "pv": 2, "receipt": receipt, "session_id": session, "window": window, "ok": ok}
    if ok:
        body["result"] = {"score": 42, "findings": []} if result is _UNSET else result
    else:
        body["code"] = code or "engine_error"
        body["message"] = message or "m"
    return body


# ---------------------------------------------------------------------------
# Claim precedes result
# ---------------------------------------------------------------------------
def test_result_before_ack_rejected_no_state(core, host):
    make_req(core, "noack1")
    out = core.post_result("noack1", v2_result("noack1", "x" * 43))
    assert out["posted"] is False and out["reason"] == "no_ack"
    assert not (host.rv / "noack1.res.json").exists()


def test_result_before_ack_route_rejected(api, core, host):
    make_req(core, "noack2")
    r = api.post(P + "/result", json=v2_result("noack2", "x" * 43))
    assert r.status_code == 409 and r.json()["code"] == "no_ack"
    assert not (host.rv / "noack2.res.json").exists()


def test_normal_ack_result_still_completes(core, host):
    receipt = acked(core, "ok1")
    out = core.post_result("ok1", v2_result("ok1", receipt))
    assert out["posted"] is True
    saved = json.loads((host.rv / "ok1.res.json").read_text("utf-8"))
    assert saved["ok"] is True and saved["result"]["score"] == 42


# ---------------------------------------------------------------------------
# Completion belongs to the winning claim
# ---------------------------------------------------------------------------
def test_wrong_receipt_cannot_complete(core, host):
    acked(core, "wr1")
    out = core.post_result("wr1", v2_result("wr1", "y" * 43))
    assert out["posted"] is False and out["reason"] == "mismatch"
    assert not (host.rv / "wr1.res.json").exists()


def test_missing_receipt_is_protocol_mismatch(core, host):
    acked(core, "wr2")
    body = v2_result("wr2", "")
    del body["receipt"]
    out = core.post_result("wr2", body)
    assert out["posted"] is False and out["reason"] == "protocol"
    assert not (host.rv / "wr2.res.json").exists()


def test_losing_claimant_cannot_complete(core, host):
    make_req(core, "wr3")
    win = core.claim_ack("wr3", "wA", "sessA")
    assert win["claimed"] is True
    lose = core.claim_ack("wr3", "wB", "sessA")
    assert lose["claimed"] is False
    forged = {"request_id": "wr3", "pv": 2, "session_id": "sessA", "window": "wB", "ok": True,
              "result": {"score": 100, "findings": []}}
    out = core.post_result("wr3", forged)  # loser has no receipt
    assert out["posted"] is False and out["reason"] == "protocol"


def test_cross_session_result_rejected(core, host):
    receipt = acked(core, "wr4", session="sessA")
    out = core.post_result("wr4", v2_result("wr4", receipt, session="sessB"))
    assert out["posted"] is False and out["reason"] == "mismatch"


def test_wrong_window_result_rejected(core, host):
    receipt = acked(core, "wr5", window="wA")
    out = core.post_result("wr5", v2_result("wr5", receipt, window="wB"))
    assert out["posted"] is False and out["reason"] == "mismatch"


def test_ack_for_other_session_rejected(core, host):
    make_req(core, "wr6", session="sessA")
    out = core.claim_ack("wr6", "wB", "sessB")
    assert out["claimed"] is False and out["reason"] == "session_mismatch"
    assert not (host.rv / "wr6.ack.json").exists()


def test_route_ack_cross_session_403(api, core):
    make_req(core, "wr7", session="sessA")
    r = api.post(P + "/ack/wr7", json={"window": "wB", "session_id": "sessB", "pv": 2})
    assert r.status_code == 403 and r.json()["claimed"] is False


def test_receipt_only_in_ack_response(api, core, host):
    make_req(core, "sec1", session="sessA")
    pend = api.get(P + "/pending").json()["pending"]
    assert pend and "receipt" not in json.dumps(pend).lower()
    r = api.post(P + "/ack/sec1", json={"window": "wA", "session_id": "sessA", "pv": 2})
    receipt = r.json()["receipt"]
    assert r.status_code == 200 and isinstance(receipt, str) and len(receipt) >= 32
    # the ack file persists the claim, but the result must not echo the receipt anywhere readable
    body = v2_result("sec1", receipt)
    assert api.post(P + "/result", json=body).status_code == 200
    saved = (host.rv / "sec1.res.json").read_text("utf-8")
    assert receipt not in saved
    # a second pending glance can never disclose it either
    assert receipt not in json.dumps(api.get(P + "/pending").json())


def test_event_payload_has_no_receipt(core, host):
    assert host.events == []
    t = threading.Thread(target=lambda: core.request({}, "sessZ", ack_timeout=0.2, audit_timeout=0.2))
    t.start()
    t.join(3)
    for _, _, payload in host.events:
        assert "receipt" not in json.dumps(payload).lower()


# ---------------------------------------------------------------------------
# Exactly one completion; atomic no-clobber publication
# ---------------------------------------------------------------------------
def test_second_completion_rejected_first_wins(core, host):
    receipt = acked(core, "dup1")
    first = core.post_result("dup1", v2_result("dup1", receipt, result={"score": 10, "findings": []}))
    second = core.post_result("dup1", v2_result("dup1", receipt, result={"score": 99, "findings": []}))
    assert first["posted"] is True
    assert second["posted"] is False and second["reason"] == "duplicate"
    saved = json.loads((host.rv / "dup1.res.json").read_text("utf-8"))
    assert saved["result"]["score"] == 10


def test_concurrent_completions_single_winner(core, host):
    receipt = acked(core, "race1")
    outcomes = []

    def go(score):
        outcomes.append(core.post_result(
            "race1", v2_result("race1", receipt, result={"score": score, "findings": []}))["posted"])

    threads = [threading.Thread(target=go, args=(s,)) for s in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(5)
    assert outcomes.count(True) == 1 and outcomes.count(False) == 19
    saved = json.loads((host.rv / "race1.res.json").read_text("utf-8"))
    assert isinstance(saved["result"]["score"], int)


_CHILD = r'''
import importlib.util, json, sys, types
root, data_root, rid, receipt, score = sys.argv[1:6]
storage = types.ModuleType("plugins.plugin_storage")
def plugin_data_dir(name):
    d = __import__("pathlib").Path(data_root) / name
    d.mkdir(parents=True, exist_ok=True)
    return d
storage.plugin_data_dir = plugin_data_dir
pkg = types.ModuleType("plugins"); pkg.__path__ = []; pkg.plugin_storage = storage
sys.modules["plugins"] = pkg; sys.modules["plugins.plugin_storage"] = storage
spec = importlib.util.spec_from_file_location("h1_core_child", root + "/_core.py")
core = importlib.util.module_from_spec(spec); spec.loader.exec_module(core)
out = core.post_result(rid, {"request_id": rid, "pv": core.PROTOCOL, "receipt": receipt,
                             "session_id": "sessA", "window": "wA", "ok": True,
                             "result": {"score": int(score), "findings": []}})
print("POSTED" if out["posted"] else "REJECTED:" + out["reason"])
'''


def test_cross_process_completions_single_winner(core, host):
    receipt = acked(core, "proc1")
    data_root = str(host.data_root)
    procs = [
        subprocess.Popen(
            [sys.executable, "-c", _CHILD, str(ROOT), data_root, "proc1", receipt, str(i)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        for i in range(6)
    ]
    outs = [p.communicate(timeout=60)[0].strip() for p in procs]
    assert all(p.returncode == 0 for p in procs), outs
    winners = [o for o in outs if o == "POSTED"]
    assert len(winners) == 1, outs
    assert json.loads((host.rv / "proc1.res.json").read_text("utf-8"))["ok"] is True


def test_concurrent_acks_single_receipt(core, host):
    make_req(core, "ackrace")
    receipts = []

    def go(w):
        out = core.claim_ack("ackrace", w, "sessA")
        if out["claimed"]:
            receipts.append(out["receipt"])

    threads = [threading.Thread(target=go, args=(f"w{i}",)) for i in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(5)
    assert len(receipts) == 1


# ---------------------------------------------------------------------------
# Lifetime: expiry, cleanup, no resurrection
# ---------------------------------------------------------------------------
def test_expired_request_cannot_be_claimed(core, host):
    make_req(core, "old1", age=core.CLAIM_MAX_AGE + 10)
    out = core.claim_ack("old1", "wA", "sessA")
    assert out["claimed"] is False and out["reason"] == "expired"
    assert not (host.rv / "old1.ack.json").exists()


def test_late_writer_after_cleanup_cannot_recreate(core, host):
    receipt = acked(core, "gone1")
    core._cleanup("gone1")  # waiter finished/timed out and removed everything
    out = core.post_result("gone1", v2_result("gone1", receipt))
    assert out["posted"] is False and out["reason"] == "unknown"
    assert not list(host.rv.glob("gone1.*"))


def test_sweep_removes_expired_claim_artifacts(core, host):
    import os
    acked(core, "sweepme")
    for f in host.rv.glob("sweepme.*"):
        os.utime(f, (time.time() - 700, time.time() - 700))
    assert core.sweep(600) >= 2
    assert not list(host.rv.glob("sweepme.*"))


# ---------------------------------------------------------------------------
# Bounded, validated envelope
# ---------------------------------------------------------------------------
def test_core_oversize_result_rejected(core, host):
    receipt = acked(core, "big1")
    fat = {"score": 1, "findings": [], "blob": "x" * core.RESULT_MAX_BYTES}
    out = core.post_result("big1", v2_result("big1", receipt, result=fat))
    assert out["posted"] is False and out["reason"] == "oversize"
    assert not (host.rv / "big1.res.json").exists()


def test_core_boundary_size_accepted_next_byte_rejected(core, host):
    receipt = acked(core, "big2")
    base = v2_result("big2", receipt, result={"score": 1, "findings": [], "pad": ""})
    # pad so the persisted res JSON lands exactly at the byte budget
    overhead = len(json.dumps({"request_id": "big2", "ok": True,
                               "result": {"score": 1, "findings": [], "pad": ""}}, ensure_ascii=False).encode("utf-8"))
    base["result"]["pad"] = "y" * (core.RESULT_MAX_BYTES - overhead)
    assert core.post_result("big2", base)["posted"] is True
    receipt2 = acked(core, "big3")
    over = v2_result("big3", receipt2, result={"score": 1, "findings": [], "pad": ""})
    overhead2 = len(json.dumps({"request_id": "big3", "ok": True,
                                "result": {"score": 1, "findings": [], "pad": ""}}, ensure_ascii=False).encode("utf-8"))
    over["result"]["pad"] = "y" * (core.RESULT_MAX_BYTES - overhead2 + 1)
    assert core.post_result("big3", over)["reason"] == "oversize"


def test_route_oversize_rejected_before_parse_chunked(api, core, host):
    # chunked body WITHOUT a trustworthy Content-Length must still be refused
    receipt = acked(core, "big4") if False else None  # route rejects before any state lookup matters
    make_req(core, "big4")
    payload = json.dumps(v2_result("big4", "z" * 43, result={"blob": "x" * (256 * 1024)})).encode("utf-8")
    assert len(payload) > 256 * 1024

    def gen():
        mid = len(payload) // 2
        yield payload[:mid]
        yield payload[mid:]
    r = api.post(P + "/result", content=gen(),
                 headers={"content-type": "application/json"})
    assert r.status_code == 413
    assert not (host.rv / "big4.res.json").exists()


def test_route_declared_oversize_rejected_without_body(api, core, host):
    make_req(core, "big5")
    r = api.post(P + "/result", content=b"{}",
                 headers={"content-type": "application/json",
                          "content-length": str(300 * 1024)})
    assert r.status_code in (400, 413)  # refused; never parsed as JSON
    assert not (host.rv / "big5.res.json").exists()


def test_route_malformed_json_rejected(api, core, host):
    make_req(core, "bad1")
    r = api.post(P + "/result", content=b'{"request_id": "bad1", ',  # truncated JSON
                 headers={"content-type": "application/json"})
    assert r.status_code == 400
    assert not (host.rv / "bad1.res.json").exists()


def test_route_non_utf8_rejected(api, core, host):
    make_req(core, "bad2")
    r = api.post(P + "/result", content=b'\xff\xfe{"request_id": "bad2"}',
                 headers={"content-type": "application/json"})
    assert r.status_code == 400
    assert not (host.rv / "bad2.res.json").exists()


def test_success_result_must_be_object(core, host):
    receipt = acked(core, "shape1")
    for bad in ([1, 2], "text", 7, None):
        out = core.post_result("shape1", v2_result("shape1", receipt, result=bad))
        assert out["posted"] is False and out["reason"] == "invalid", bad
    assert not (host.rv / "shape1.res.json").exists()


def test_error_shape_validated_and_bounded(core, host):
    receipt = acked(core, "shape2")
    ok = core.post_result("shape2", v2_result("shape2", receipt, ok=False, code="consent_denied", message="no"))
    assert ok["posted"] is True
    saved = json.loads((host.rv / "shape2.res.json").read_text("utf-8"))
    assert saved["code"] == "consent_denied"

    for rid, code, msg in (("shape3", "Not A Code!!", "m"), ("shape4", "engine_error", "x" * 501)):
        r = acked(core, rid)
        out = core.post_result(rid, v2_result(rid, r, ok=False, code=code, message=msg))
        assert out["posted"] is False and out["reason"] == "invalid"
        assert not (host.rv / f"{rid}.res.json").exists()


# ---------------------------------------------------------------------------
# Protocol versioning: old halves fail visibly
# ---------------------------------------------------------------------------
def test_old_ack_without_pv_fails_visibly(api, core, host):
    make_req(core, "oldp1")
    r = api.post(P + "/ack/oldp1", json={"window": "wA", "session_id": "sessA"})
    assert r.status_code == 400 and r.json()["code"] == "protocol_mismatch"
    assert not (host.rv / "oldp1.ack.json").exists()


def test_old_result_without_pv_fails_visibly(api, core, host):
    receipt = acked(core, "oldp2")
    body = v2_result("oldp2", receipt)
    del body["pv"]
    r = api.post(P + "/result", json=body)
    assert r.status_code == 400 and r.json()["code"] == "protocol_mismatch"
    assert not (host.rv / "oldp2.res.json").exists()


def test_legacy_req_file_unclaimable(core, host):
    d = core.rv_dir()
    (d / "legacy1.req.json").write_text(json.dumps({"request_id": "legacy1", "args": {}, "t": time.time()}))
    out = core.claim_ack("legacy1", "wA", "")
    assert out["claimed"] is False and out["reason"] == "protocol"


# ---------------------------------------------------------------------------
# Recovery: pending -> ack receipt -> result still works (lost event path)
# ---------------------------------------------------------------------------
def test_pending_only_recovery_roundtrip(api, core, host):
    make_req(core, "rec1", session="sessA")
    pend = api.get(P + "/pending").json()["pending"]
    assert [p["request_id"] for p in pend] == ["rec1"]
    assert pend[0]["session_id"] == "sessA"
    a = api.post(P + "/ack/rec1", json={"window": "wA", "session_id": "sessA", "pv": 2})
    assert a.status_code == 200
    receipt = a.json()["receipt"]
    r = api.post(P + "/result", json=v2_result("rec1", receipt, result={"score": 5, "findings": []}))
    assert r.status_code == 200
    saved = json.loads((host.rv / "rec1.res.json").read_text("utf-8"))
    assert saved["result"]["score"] == 5


def test_duplicate_route_completion_409(api, core, host):
    receipt = acked(core, "rec2")
    body = v2_result("rec2", receipt)
    assert api.post(P + "/result", json=body).status_code == 200
    again = api.post(P + "/result", json=body)
    assert again.status_code == 409 and again.json()["code"] == "duplicate_completion"


def test_wrong_receipt_route_403(api, core, host):
    acked(core, "rec3")
    r = api.post(P + "/result", json=v2_result("rec3", "q" * 43))
    assert r.status_code == 403


def test_unknown_request_route_still_404(api):
    r = api.post(P + "/result", json=v2_result("nope", "q" * 43))
    assert r.status_code == 404 and r.json()["message"] == "unknown or expired request"
