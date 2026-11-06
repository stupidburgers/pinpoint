"""Rendezvous between the Python tool handler and the Desktop half (SPEC 4.2).

All shared state is files under plugin_data_dir('pinpoint')/rv/<id>.{req,ack,res}.json so the tool
handler, the dashboard router (loaded as a separate module) and sweeps need no shared memory.
"""
import json
import os
import re
import time
import uuid

PLUGIN_ID = "pinpoint"
VERSION = "0.1.0"
PENDING_MAX_AGE = 120.0
SWEEP_MAX_AGE = 600.0
POLL = 0.05
HINT = ("Tell the user: open the page in the Browser pane (Ctrl+Shift+L), enable Pinpoint under "
        "Capabilities > Plugins, press Audit.")
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def rv_dir():
    from plugins.plugin_storage import plugin_data_dir
    d = plugin_data_dir(PLUGIN_ID) / "rv"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _p(rid, kind):
    return rv_dir() / f"{rid}.{kind}.json"


def _write_atomic(path, obj):
    tmp = path.with_name(path.name + f".{uuid.uuid4().hex[:6]}.tmp")
    tmp.write_text(json.dumps(obj), encoding="utf-8")
    os.replace(tmp, path)


def _err(code, message):
    return {"ok": False, "code": code, "message": message, "hint": HINT}


def _cleanup(rid):
    for kind in ("req", "ack", "res"):
        try:
            _p(rid, kind).unlink()
        except OSError:
            pass


def request(args, session_id, ack_timeout=4.0, audit_timeout=90.0, poll=POLL):
    """Ask the Desktop to audit; blocks. Always returns a dict (`ok` + result, or error `code`)."""
    rid = uuid.uuid4().hex[:12]
    try:
        _write_atomic(_p(rid, "req"), {"request_id": rid, "args": args, "session_id": session_id or "", "t": time.time()})
        try:
            from hermes_cli.plugin_events import broadcast_plugin_event
            broadcast_plugin_event(PLUGIN_ID, "audit.request",
                                   {"request_id": rid, "args": args, "session_id": session_id or ""})
        except Exception as e:  # no gateway / event bus: nobody can answer
            return _err("desktop_unavailable", f"Could not reach the Desktop app ({type(e).__name__}).")
        ack = _p(rid, "ack")
        res = _p(rid, "res")
        deadline = time.monotonic() + max(0.0, float(ack_timeout))
        while not ack.exists() and not res.exists():
            if time.monotonic() >= deadline:
                return _err("desktop_unavailable",
                            f"No Desktop window answered within {ack_timeout:g}s.")
            time.sleep(poll)
        deadline = time.monotonic() + max(0.0, float(audit_timeout))
        while not res.exists():
            if time.monotonic() >= deadline:
                return _err("timeout", f"The Desktop did not return a result within {audit_timeout:g}s.")
            time.sleep(poll)
        for _ in range(20):  # tolerate a reader seeing the file mid-replace
            try:
                data = json.loads(res.read_text(encoding="utf-8"))
                break
            except (OSError, ValueError):
                time.sleep(poll)
        else:
            return _err("engine_error", "Unreadable result from the Desktop.")
        if not isinstance(data, dict):
            return _err("engine_error", "Malformed result from the Desktop.")
        if data.get("ok") is False:
            return _err(str(data.get("code") or "engine_error"), str(data.get("message") or "Audit failed."))
        return {"ok": True, "result": data.get("result") if isinstance(data.get("result"), dict) else {}}
    except Exception as e:
        return _err("engine_error", f"Internal error ({type(e).__name__}).")
    finally:
        _cleanup(rid)


MAX_RESULT_BYTES = 256 * 1024
POST_OK, POST_UNKNOWN, POST_NO_ACK, POST_BAD_TOKEN, POST_DUPLICATE, POST_TOO_LARGE, POST_BAD = (
    "ok", "unknown", "no_ack", "bad_token", "duplicate", "too_large", "bad")


def claim(rid, window=""):
    """Exclusive claim of a request. Returns a server-minted claim token for the first caller, else None.

    The token exists only in the ack file and in this return value: never in pending(), events or logs.
    """
    if not isinstance(rid, str) or not _ID_RE.match(rid) or not _p(rid, "req").exists():
        return None
    token = uuid.uuid4().hex
    try:
        with open(_p(rid, "ack"), "x", encoding="utf-8") as f:
            json.dump({"window": str(window)[:80], "t": time.time(), "token": token}, f)
        return token
    except OSError:  # FileExistsError included
        return None


def claim_ack(rid, window=""):
    """Boolean form of claim() (kept for in-process callers)."""
    return claim(rid, window) is not None


def _ack_token(rid):
    try:
        data = json.loads(_p(rid, "ack").read_text(encoding="utf-8"))
        return data.get("token") if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def _publish_once(path, obj):
    """Write obj so that readers never see a partial file and a second writer cannot replace it."""
    tmp = path.with_name(path.name + f".{uuid.uuid4().hex[:6]}.tmp")
    tmp.write_text(json.dumps(obj), encoding="utf-8")
    try:
        os.link(tmp, path)  # atomic and fails if path exists
        return True
    except FileExistsError:
        return False
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def post_result_status(rid, payload, token=None, strict=True):
    """Complete a request once. strict=True (REST path) requires an ack and the matching claim token."""
    if not isinstance(rid, str) or not _ID_RE.match(rid) or not _p(rid, "req").exists():
        return POST_UNKNOWN
    if not isinstance(payload, dict):
        return POST_BAD
    try:
        if len(json.dumps(payload).encode("utf-8")) > MAX_RESULT_BYTES:
            return POST_TOO_LARGE
    except (TypeError, ValueError):
        return POST_BAD
    want = _ack_token(rid)
    if want is None:
        if strict or token is not None or _p(rid, "ack").exists():
            return POST_NO_ACK
    elif token is not None or strict:
        import hmac
        if not isinstance(token, str) or not hmac.compare_digest(token, want):
            return POST_BAD_TOKEN
    try:
        return POST_OK if _publish_once(_p(rid, "res"), payload) else POST_DUPLICATE
    except OSError:
        return POST_UNKNOWN


def post_result(rid, payload, token=None, strict=False):
    return post_result_status(rid, payload, token, strict) == POST_OK


def pending():
    """Unacked, unanswered requests younger than 120 s."""
    out = []
    now = time.time()
    try:
        files = sorted(rv_dir().glob("*.req.json"))
    except OSError:
        return out
    for f in files:
        rid = f.name[: -len(".req.json")]
        if _p(rid, "ack").exists() or _p(rid, "res").exists():
            continue
        try:
            req = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(req, dict) and now - float(req.get("t") or 0) < PENDING_MAX_AGE:
            out.append(req)
    return out


def sweep(max_age=SWEEP_MAX_AGE):
    """Delete rv files older than max_age seconds (by mtime). Returns the count removed."""
    n = 0
    try:
        files = list(rv_dir().iterdir())
    except OSError:
        return 0
    cutoff = time.time() - max_age
    for f in files:
        try:
            if f.is_file() and f.stat().st_mtime < cutoff:
                f.unlink()
                n += 1
        except OSError:
            pass
    return n
