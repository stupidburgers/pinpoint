"""Rendezvous between the Python tool handler and the Desktop half (SPEC 4.2).

All shared state is files under plugin_data_dir('pinpoint')/rv/<id>.{req,ack,res}.json so the tool
handler, the dashboard router (loaded as a separate module) and sweeps need no shared memory.

Lifecycle (H1 correction): pending -> claimed -> single completed -> expired/cleaned.
A result requires a prior exclusive claim (ack) carrying a server-minted receipt; only the
claim's exact receipt/session/window may complete it, exactly once. Publication of both the
claim and the result is atomic and no-clobber: content is written in full to a private temp
file, then linked into place, so a reader never observes a partially-written claim or result
and a second writer can never silently overwrite the first. The receipt is minted only here,
returned solely in the ack response, and is never written into the request/pending file,
broadcast events, or logs.
"""
import json
import os
import re
import secrets
import time
import uuid

PLUGIN_ID = "pinpoint"
VERSION = "0.1.0"
PROTOCOL = 2
RESULT_MAX_BYTES = 256 * 1024
PENDING_MAX_AGE = 120.0
CLAIM_MAX_AGE = 120.0
SWEEP_MAX_AGE = 600.0
POLL = 0.05
HINT = ("Tell the user: open the page in the Browser pane (Ctrl+Shift+L), enable Pinpoint under "
        "Capabilities > Plugins, press Audit.")
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_CODE_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


def rv_dir():
    from plugins.plugin_storage import plugin_data_dir
    d = plugin_data_dir(PLUGIN_ID) / "rv"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _p(rid, kind):
    return rv_dir() / f"{rid}.{kind}.json"


def _write_atomic(path, obj):
    """Overwrite-ok atomic publish: full content lands at `path` or not at all."""
    tmp = path.with_name(path.name + f".{uuid.uuid4().hex[:6]}.tmp")
    tmp.write_text(json.dumps(obj), encoding="utf-8")
    os.replace(tmp, path)


def _write_exclusive_atomic(path, text):
    """No-clobber atomic publish: `text` lands whole at `path`, or the write loses to an
    existing writer and the caller's content is never visible to anyone. Writes a private
    temp file first, then links it into place, so a reader can never observe a partial or
    truncated `path`."""
    tmp = path.with_name(path.name + f".{uuid.uuid4().hex[:8]}.tmp")
    tmp.write_text(text, encoding="utf-8")
    try:
        try:
            os.link(tmp, path)
        except (AttributeError, NotImplementedError):
            # Hardlinks unsupported on this filesystem: fall back to a plain exclusive
            # create. Content is still written in one shot, so there is no window with
            # a truncated file.
            with open(path, "x", encoding="utf-8") as f:
                f.write(text)
        return True
    except OSError:
        return False
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


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
        _write_atomic(_p(rid, "req"), {"request_id": rid, "args": args,
                                        "session_id": session_id or "", "pv": PROTOCOL, "t": time.time()})
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


def _load_req(rid):
    """Returns (req_dict, age_seconds) or (None, None) if unreadable/missing."""
    try:
        req = json.loads(_p(rid, "req").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None, None
    if not isinstance(req, dict):
        return None, None
    return req, time.time() - float(req.get("t") or 0)


def claim_ack(rid, window="", session_id=""):
    """Exclusive claim of a request. The first valid, in-protocol, correct-session caller
    wins and receives a freshly minted receipt; every other caller is told why it lost."""
    if not isinstance(rid, str) or not _ID_RE.match(rid) or not _p(rid, "req").exists():
        return {"claimed": False, "reason": "unknown"}
    req, age = _load_req(rid)
    if req is None:
        return {"claimed": False, "reason": "unknown"}
    if req.get("pv") != PROTOCOL:
        return {"claimed": False, "reason": "protocol"}
    if age is None or age > CLAIM_MAX_AGE:
        return {"claimed": False, "reason": "expired"}
    if str(req.get("session_id", "")) != str(session_id or ""):
        return {"claimed": False, "reason": "session_mismatch"}
    receipt = secrets.token_urlsafe(32)
    payload = json.dumps({"window": str(window or "")[:80], "session_id": str(session_id or ""),
                           "receipt": receipt, "t": time.time()})
    if _write_exclusive_atomic(_p(rid, "ack"), payload):
        return {"claimed": True, "receipt": receipt}
    return {"claimed": False, "reason": "claimed"}


def post_result(rid, payload):
    """Complete a claimed request exactly once. `payload` must carry the winning receipt,
    session and window; anything else is rejected without creating or mutating any file."""
    if not isinstance(rid, str) or not _ID_RE.match(rid):
        return {"posted": False, "reason": "unknown"}
    if not _p(rid, "req").exists():
        return {"posted": False, "reason": "unknown"}
    if not isinstance(payload, dict):
        return {"posted": False, "reason": "invalid"}
    if payload.get("pv") != PROTOCOL:
        return {"posted": False, "reason": "protocol"}
    receipt = payload.get("receipt")
    if not isinstance(receipt, str) or not receipt:
        return {"posted": False, "reason": "protocol"}
    try:
        ack = json.loads(_p(rid, "ack").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"posted": False, "reason": "no_ack"}
    if not isinstance(ack, dict):
        return {"posted": False, "reason": "no_ack"}
    if (ack.get("receipt") != receipt
            or str(ack.get("session_id", "")) != str(payload.get("session_id", ""))
            or str(ack.get("window", "")) != str(payload.get("window", ""))):
        return {"posted": False, "reason": "mismatch"}

    ok = payload.get("ok")
    if ok is True:
        result = payload.get("result")
        if not isinstance(result, dict):
            return {"posted": False, "reason": "invalid"}
        body = {"request_id": rid, "ok": True, "result": result}
    elif ok is False:
        code = payload.get("code")
        message = payload.get("message")
        if not isinstance(code, str) or not _CODE_RE.match(code):
            return {"posted": False, "reason": "invalid"}
        if not isinstance(message, str) or len(message) > 500:
            return {"posted": False, "reason": "invalid"}
        body = {"request_id": rid, "ok": False, "code": code, "message": message}
    else:
        return {"posted": False, "reason": "invalid"}

    data = json.dumps(body, ensure_ascii=False)
    if len(data.encode("utf-8")) > RESULT_MAX_BYTES:
        return {"posted": False, "reason": "oversize"}
    if not _p(rid, "req").exists():  # cleaned up/expired while we were validating
        return {"posted": False, "reason": "unknown"}
    if _write_exclusive_atomic(_p(rid, "res"), data):
        return {"posted": True}
    return {"posted": False, "reason": "duplicate"}


def pending():
    """Unacked, unanswered requests younger than CLAIM_MAX_AGE. Never includes a receipt
    (none exists until a claim succeeds, and successfully-claimed requests drop out here)."""
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
