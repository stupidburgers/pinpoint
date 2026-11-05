"""Pinpoint dashboard router. Thin: parse requests, call the plugin's _core/_store.

Hermes loads this file standalone by path (no parent package), so the plugin package is imported
under a private name from the parent directory. All shared state lives in files / SQLite.
"""
import importlib.util
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


class ResultBody(BaseModel):
    request_id: str
    claim_token: Optional[str] = None
    ok: bool = True
    result: Optional[Any] = None
    code: Optional[str] = None
    message: Optional[str] = None


class AuditBody(BaseModel):
    result: dict
    source: str = "user"


class PinsBody(BaseModel):
    action: str
    url_key: str
    ids: Optional[list] = None
    reason: Optional[str] = None


@router.get("/health")
async def health():
    core, _ = _mods()
    return {"ok": True, "version": core.VERSION, "pid": os.getpid()}


@router.get("/pending")
async def pending():
    core, _ = _mods()
    return {"pending": core.pending()}


@router.post("/ack/{request_id}")
async def ack(request_id: str, body: Optional[AckBody] = None):
    core, _ = _mods()
    token = core.claim(request_id, body.window if body else "")
    if token:
        return {"claimed": True, "claim_token": token}
    return JSONResponse({"claimed": False}, status_code=409)


_STATUS = {"unknown": 404, "no_ack": 409, "bad_token": 403, "duplicate": 409, "too_large": 413, "bad": 400}


@router.post("/result")
async def result(request: Request):
    core, _ = _mods()
    raw = b""
    async for chunk in request.stream():  # bounded BEFORE parsing; Content-Length is not trusted
        raw += chunk
        if len(raw) > core.MAX_RESULT_BYTES + 4096:
            return JSONResponse({"ok": False, "message": "result too large"}, status_code=413)
    try:
        body = ResultBody.model_validate_json(raw) if hasattr(ResultBody, "model_validate_json") else ResultBody.parse_raw(raw)
    except Exception:
        return JSONResponse({"ok": False, "message": "malformed result"}, status_code=400)
    payload = {"request_id": body.request_id, "ok": body.ok}
    if body.ok:
        payload["result"] = body.result if isinstance(body.result, dict) else {}
    else:
        payload["code"] = body.code or "engine_error"
        payload["message"] = body.message or ""
    st = core.post_result_status(body.request_id, payload, body.claim_token, strict=True)
    if st == "ok":
        return {"ok": True}
    return JSONResponse({"ok": False, "message": st}, status_code=_STATUS.get(st, 400))


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
