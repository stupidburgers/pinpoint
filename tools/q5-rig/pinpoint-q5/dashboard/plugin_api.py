import json, os
from fastapi import APIRouter
from pydantic import BaseModel
from typing import Any
router = APIRouter()

def _dir():
    from plugins.plugin_storage import plugin_data_dir
    d = plugin_data_dir("pinpoint-q5") / "results"
    d.mkdir(parents=True, exist_ok=True)
    return d

class Res(BaseModel):
    request_id: str
    findings: list[Any] = []

@router.post("/ack/{rid}")
async def ack(rid: str):
    (_dir() / f"{rid}.ack").write_text("1")
    return {"ok": True}

@router.post("/result")
async def result(r: Res):
    (_dir() / f"{r.request_id}.json").write_text(json.dumps(r.model_dump()), encoding="utf-8")
    return {"ok": True, "pid": os.getpid(), "n": len(r.findings)}

@router.get("/state")
async def state():
    return {"api_pid": os.getpid()}
