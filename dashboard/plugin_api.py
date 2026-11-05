"""Pinpoint dashboard router. Thin: parse requests, call the plugin's _core/_store.

Hermes loads this file standalone by path (no parent package), so the plugin package is imported
under a private name from the parent directory. All shared state lives in files / SQLite.
"""
import importlib.util
import json
import os
import sys
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

_PLUGIN_DIR = Path(__file__).resolve().parent.parent
_PKG = "_pinpoint_dashboard_pkg"


def _pkg():
    mod = sys.modules.get(_PKG)
    if mod is None:
        spec = importlib.util.spec_from_file_location(
            _PKG, _PLUGIN_DIR / "__init__.py", submodule_search_locations=[str(_PLUGIN_DIR)])
        mod = importlib.util.module_from_spec(spec)
        sys.modules[_PKG] = mod
        try:
            spec.loader.exec_module(mod)
        except BaseException:
            sys.modules.pop(_PKG, None)
            raise
    return mod


def _mods():
    _pkg()
    return importlib.import_module(_PKG + "._core"), importlib.import_module(_PKG + "._store")


router = APIRouter()


class AckBody(BaseModel):
    window: str = ""
    session_id: str = ""
    pv: Optional[int] = None


class AuditBody(BaseModel):
    result: dict
    source: str = "user"


class PinsBody(BaseModel):
    action: str
    url_key: str
    ids: Optional[list] = None
    reason: Optional[str] = None


# Rejected before any JSON parsing; a result body never trusts a declared Content-Length alone.
_PROTOCOL_MISMATCH = {"ok": False, "code": "protocol_mismatch", "message": "unsupported protocol version"}


@router.get("/health")
async def health():
    core, _ = _mods()
    return {"ok": True, "version": core.VERSION, "pid": os.getpid()}


@router.get("/pending")
async def pending():
    core, _ = _mods()
    return {"pending": core.pending()}


@router.post("/ack/{request_id}")
async def ack(request_id: str, body: AckBody):
    core, _ = _mods()
    if body.pv != core.PROTOCOL:
        return JSONResponse({"claimed": False, "code": "protocol_mismatch",
                              "message": "unsupported protocol version"}, status_code=400)
    out = core.claim_ack(request_id, body.window, body.session_id)
    if out.get("claimed"):
        return {"claimed": True, "receipt": out["receipt"]}
    reason = out.get("reason") or "unavailable"
    if reason == "session_mismatch":
        return JSONResponse({"claimed": False, "code": "session_mismatch"}, status_code=403)
    if reason == "protocol":
        return JSONResponse({"claimed": False, "code": "protocol_mismatch"}, status_code=400)
    return JSONResponse({"claimed": False, "code": reason}, status_code=409)


@router.post("/result")
async def result(request: Request):
    core, _ = _mods()

    # Bounded ingress BEFORE any JSON parsing. A declared Content-Length is advisory only
    # (never trusted as proof of actual size) and is checked first purely to short-circuit
    # obviously oversized requests without reading their body.
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            if int(declared) > core.RESULT_MAX_BYTES:
                return JSONResponse({"ok": False, "code": "oversize", "message": "payload too large"},
                                     status_code=413)
        except ValueError:
            pass

    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > core.RESULT_MAX_BYTES:
            return JSONResponse({"ok": False, "code": "oversize", "message": "payload too large"},
                                 status_code=413)

    try:
        text = bytes(body).decode("utf-8")
    except UnicodeDecodeError:
        return JSONResponse({"ok": False, "code": "bad_request", "message": "body is not valid UTF-8"},
                             status_code=400)
    try:
        payload = json.loads(text)
    except ValueError:
        return JSONResponse({"ok": False, "code": "bad_request", "message": "malformed JSON"},
                             status_code=400)
    if not isinstance(payload, dict):
        return JSONResponse({"ok": False, "code": "bad_request", "message": "body must be a JSON object"},
                             status_code=400)

    if payload.get("pv") != core.PROTOCOL:
        return JSONResponse(_PROTOCOL_MISMATCH, status_code=400)

    rid = payload.get("request_id")
    if not isinstance(rid, str) or not rid:
        return JSONResponse({"ok": False, "code": "bad_request", "message": "missing request_id"},
                             status_code=400)

    out = core.post_result(rid, payload)
    if out.get("posted"):
        return {"ok": True}
    reason = out.get("reason") or "unknown"
    if reason == "unknown":
        return JSONResponse({"ok": False, "message": "unknown or expired request"}, status_code=404)
    if reason == "no_ack":
        return JSONResponse({"ok": False, "code": "no_ack", "message": "request has not been acked"},
                             status_code=409)
    if reason == "mismatch":
        return JSONResponse({"ok": False, "code": "mismatch", "message": "receipt/session/window mismatch"},
                             status_code=403)
    if reason == "protocol":
        return JSONResponse(_PROTOCOL_MISMATCH, status_code=400)
    if reason == "duplicate":
        return JSONResponse({"ok": False, "code": "duplicate_completion", "message": "already completed"},
                             status_code=409)
    if reason == "oversize":
        return JSONResponse({"ok": False, "code": "oversize", "message": "result exceeds the size budget"},
                             status_code=413)
    return JSONResponse({"ok": False, "code": "invalid", "message": "malformed result"}, status_code=400)


@router.post("/audit")
async def audit(body: AuditBody):
    _, store = _mods()
    out = store.record_audit(body.result, body.source if body.source in ("user", "auto") else "user")
    if out.get("audit_id") is None:
        return JSONResponse({"ok": False, "message": "result has no usable url"}, status_code=400)
    return {"audit_id": out["audit_id"], "delta": out["delta"]}


@router.get("/store")
async def get_store(url_key: str = ""):
    _, store = _mods()
    return store.get_store(url_key)


@router.post("/pins")
async def pins(body: PinsBody):
    core, store = _mods()
    if body.action not in ("dismiss", "reopen", "clear"):
        return JSONResponse({"ok": False, "message": "bad action"}, status_code=400)
    key = store.url_key(body.url_key) or body.url_key
    if body.action == "dismiss":
        changed = store.set_status(key, [str(i) for i in body.ids or []], "dismissed", body.reason or "dismissed in pane")
    elif body.action == "reopen":
        changed = store.set_status(key, [str(i) for i in body.ids or []], "open")
    else:
        changed = store.clear(key)
    return {"ok": True, "changed": changed}
