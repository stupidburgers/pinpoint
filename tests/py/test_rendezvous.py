import threading
import time

HINT = ("Tell the user: open the page in the Browser pane (Ctrl+Shift+L), enable Pinpoint under "
        "Capabilities > Plugins, press Audit.")


def _desktop(core, host, ack=True, result=None, delay=0.0, window="w1"):
    """Thread acting as the Desktop half."""
    out = {}

    def run():
        end = time.time() + 3
        while time.time() < end:
            pend = core.pending()
            if pend:
                rid = pend[0]["request_id"]
                out["req"] = pend[0]
                if ack:
                    out["claimed"] = core.claim_ack(rid, window)
                time.sleep(delay)
                if result is not None:
                    out["posted"] = core.post_result(rid, result)
                return
            time.sleep(0.01)

    t = threading.Thread(target=run, daemon=True)
    t.start()
    out["thread"] = t
    return out


def test_no_ack_times_out_desktop_unavailable(core, host):
    t0 = time.time()
    r = core.request({"pin": True}, "sess", ack_timeout=0.2, audit_timeout=5)
    assert time.time() - t0 < 1.5
    assert r["ok"] is False and r["code"] == "desktop_unavailable"
    assert "hint" in r and "message" in r
    assert len(host.events) == 1
    pid, ev, payload = host.events[0]
    assert (pid, ev) == ("pinpoint", "audit.request")
    assert payload["args"] == {"pin": True} and payload["session_id"] == "sess" and payload["request_id"]
    assert not list(host.rv.glob("*"))  # cleaned


def test_broadcast_failure_is_desktop_unavailable(core, host):
    host.state["broadcast_raises"] = RuntimeError("boom")
    r = core.request({}, "s", ack_timeout=5, audit_timeout=5)
    assert r["ok"] is False and r["code"] == "desktop_unavailable"
    assert not list(host.rv.glob("*"))


def test_broadcast_import_failure(core, host, monkeypatch):
    import sys
    monkeypatch.setitem(sys.modules, "hermes_cli.plugin_events", None)  # import raises ImportError
    r = core.request({}, "s", ack_timeout=5, audit_timeout=5)
    assert r["code"] == "desktop_unavailable"


def test_round_trip(core, host):
    result = {"request_id": "ignored", "ok": True, "result": {"score": 61, "findings": [{"id": "a@1"}]}}
    d = _desktop(core, host, result=result, delay=0.05)
    r = core.request({}, "s", ack_timeout=2, audit_timeout=3)
    d["thread"].join(2)
    assert r["ok"] is True and r["result"]["findings"] == [{"id": "a@1"}]
    assert d["claimed"] is True and d["posted"] is True
    assert not list(host.rv.glob("*"))


def test_error_result_passthrough(core, host):
    d = _desktop(core, host, result={"ok": False, "code": "consent_denied", "message": "no"})
    r = core.request({}, "s", ack_timeout=2, audit_timeout=3)
    d["thread"].join(2)
    assert r["ok"] is False and r["code"] == "consent_denied" and r["message"] == "no"


def test_second_ack_not_claimed(core, host):
    core_req = {}

    def go():
        core_req["r"] = core.request({}, "s", ack_timeout=2, audit_timeout=0.4)

    t = threading.Thread(target=go)
    t.start()
    for _ in range(100):
        p = core.pending()
        if p:
            break
        time.sleep(0.01)
    rid = p[0]["request_id"]
    assert core.claim_ack(rid, "A") is True
    assert core.claim_ack(rid, "B") is False
    assert core.pending() == []  # acked requests are no longer pending
    t.join(3)


def test_result_timeout(core, host):
    d = _desktop(core, host, result=None)
    r = core.request({}, "s", ack_timeout=1, audit_timeout=0.3)
    d["thread"].join(2)
    assert r["ok"] is False and r["code"] == "timeout"
    assert not list(host.rv.glob("*"))


def test_claim_unknown_or_malicious_id(core, host):
    assert core.claim_ack("nope", "w") is False
    assert core.claim_ack("../../etc", "w") is False
    assert core.post_result("../x", {"ok": True}) is False
    assert core.post_result("nope", {"ok": True}) is False


def test_pending_filters_old(core, host):
    import json
    host.rv.mkdir(parents=True, exist_ok=True)
    (host.rv / "old1.req.json").write_text(json.dumps({"request_id": "old1", "args": {}, "t": time.time() - 500}))
    (host.rv / "new1.req.json").write_text(json.dumps({"request_id": "new1", "args": {}, "t": time.time()}))
    assert [p["request_id"] for p in core.pending()] == ["new1"]


def test_sweep(core, host):
    import os
    host.rv.mkdir(parents=True, exist_ok=True)
    old = host.rv / "x.req.json"
    old.write_text("{}")
    os.utime(old, (time.time() - 700, time.time() - 700))
    fresh = host.rv / "y.req.json"
    fresh.write_text("{}")
    assert core.sweep(600) == 1
    assert not old.exists() and fresh.exists()


def test_sweep_never_raises_without_dir(core, host):
    assert core.sweep() == 0
