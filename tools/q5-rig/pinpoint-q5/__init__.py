import json, os, time, uuid

SCHEMA = {
    "name": "pinpoint_probe",
    "description": "Q5 probe: ask the desktop half to run something and return its answer synchronously.",
    "parameters": {"type": "object", "properties": {"label": {"type": "string"}, "n": {"type": "integer"}}, "required": ["label"]},
}

def _data():
    from plugins.plugin_storage import plugin_data_dir
    d = plugin_data_dir("pinpoint-q5") / "results"
    d.mkdir(parents=True, exist_ok=True)
    return d

def _handler(args, **kw):
    t0 = time.time()
    rid = uuid.uuid4().hex[:8]
    info = {"pid": os.getpid(), "request_id": rid, "kw_keys": sorted(kw.keys()), "session_id": kw.get("session_id")}
    try:
        from hermes_cli.plugin_events import broadcast_plugin_event
        broadcast_plugin_event("pinpoint-q5", "audit.request", {"request_id": rid, "n": int(args.get("n") or 3)})
    except Exception as e:
        return json.dumps({"ok": False, "error": f"broadcast failed: {e!r}"})
    f = _data() / f"{rid}.json"
    ack = _data() / f"{rid}.ack"
    deadline = t0 + 30
    while time.time() < deadline:
        if f.exists():
            body = json.loads(f.read_text(encoding="utf-8"))
            info.update(ok=True, roundtrip_s=round(time.time() - t0, 3), ack=ack.exists(), got=len(body.get("findings", [])), findings=body.get("findings"))
            return json.dumps(info)
        time.sleep(0.05)
    info.update(ok=False, error="desktop did not answer", ack=ack.exists())
    return json.dumps(info)

def register(ctx):
    ctx.register_tool(name="pinpoint_probe", toolset="pinpoint", schema=SCHEMA, handler=_handler,
                      description=SCHEMA["description"], emoji="📍")
