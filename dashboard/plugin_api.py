"""Pinpoint dashboard router. Thin: parse requests, call the plugin's _core/_store.

Hermes loads this file standalone by path (no parent package), so the plugin package is imported
under a private name from the parent directory. All shared state lives in files / SQLite.
"""
import importlib.util
import os
import sys
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter
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
    if core.claim_ack(request_id, body.window if body else ""):
        return {"claimed": True}
    return JSONResponse({"claimed": False}, status_code=409)


@router.post("/result")
async def result(body: ResultBody):
    core, _ = _mods()
    payload = {"request_id": body.request_id, "ok": body.ok}
    if body.ok:
        payload["result"] = body.result if isinstance(body.result, dict) else {}
    else:
        payload["code"] = body.code or "engine_error"
        payload["message"] = body.message or ""
    if core.post_result(body.request_id, payload):
        return {"ok": True}
    return JSONResponse({"ok": False, "message": "unknown or expired request"}, status_code=404)


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
