import os
import re
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def manifest_list(key):
    txt = (ROOT / "plugin.yaml").read_text("utf-8")
    m = re.search(rf"^{key}: \[(.*?)\]", txt, re.M)
    return [x.strip() for x in m.group(1).split(",") if x.strip()]


class Ctx:
    def __init__(self, with_section=True, config=None):
        self.tools, self.sections, self.other = [], [], []
        self._cfg = config or {}
        if with_section:
            self.register_system_prompt_section = self._section

    def register_tool(self, name, toolset, schema, handler, **kw):
        self.tools.append({"name": name, "toolset": toolset, "schema": schema, "handler": handler, **kw})

    def _section(self, id, content, **kw):
        self.sections.append({"id": id, "content": content, **kw})

    def get_config(self, key, default=None):
        return self._cfg.get(key, default)

    def __getattr__(self, name):  # any other registration (hooks, commands, ...) is recorded as a violation
        if name.startswith("register_") or name in ("on", "emit"):
            def rec(*a, **k):
                self.other.append(name)
            return rec
        raise AttributeError(name)


def test_register_matches_manifest(pkg):
    ctx = Ctx()
    pkg.register(ctx)
    assert sorted(t["name"] for t in ctx.tools) == sorted(manifest_list("provides_tools"))
    assert manifest_list("provides_hooks") == [] and manifest_list("provides_middleware") == []
    assert ctx.other == []  # no hooks, commands, middleware


def test_tool_details(pkg):
    ctx = Ctx()
    pkg.register(ctx)
    for t in ctx.tools:
        assert t["toolset"] == "pinpoint"
        assert t["emoji"]
        assert t["schema"]["name"] == t["name"]
        assert t["description"] == t["schema"]["description"]
        assert callable(t["handler"])


def test_system_prompt_section(pkg):
    ctx = Ctx()
    pkg.register(ctx)
    assert len(ctx.sections) == 1
    s = ctx.sections[0]
    assert s["id"] == "pinpoint.guide" and s["position"] == "after_memory"
    assert len(s["content"]) <= 450
    assert "pinpoint_audit" in s["content"] and "pinpoint_pins" in s["content"]


def test_old_ctx_without_section_api(pkg):
    ctx = Ctx(with_section=False)
    pkg.register(ctx)
    assert len(ctx.tools) == 2 and ctx.sections == []


def test_section_registration_failure_is_not_fatal(pkg):
    ctx = Ctx()

    def boom(*a, **k):
        raise ValueError("dup")
    ctx.register_system_prompt_section = boom
    pkg.register(ctx)
    assert len(ctx.tools) == 2


def test_handler_uses_ctx_config(pkg, host, monkeypatch):
    import json
    import sys
    ctx = Ctx(config={"ack_timeout_s": 0.2})
    pkg.register(ctx)
    audit = next(t for t in ctx.tools if t["name"] == "pinpoint_audit")["handler"]
    t0 = time.time()
    out = json.loads(audit({}, session_id="s"))
    assert out["code"] == "desktop_unavailable" and time.time() - t0 < 2


def test_register_sweeps_old_rv_files(pkg, host):
    rv = host.rv
    rv.mkdir(parents=True, exist_ok=True)
    old = rv / "old.req.json"
    old.write_text("{}")
    os.utime(old, (time.time() - 3600, time.time() - 3600))
    fresh = rv / "fresh.req.json"
    fresh.write_text("{}")
    pkg.register(Ctx())
    assert not old.exists() and fresh.exists()


def test_register_survives_sweep_failure(pkg, host, monkeypatch):
    import sys
    monkeypatch.setitem(sys.modules, "plugins.plugin_storage", None)
    ctx = Ctx()
    pkg.register(ctx)
    assert len(ctx.tools) == 2


def test_no_tui_gateway_import():
    for f in ROOT.glob("*.py"):
        assert "tui_gateway" not in f.read_text("utf-8"), f
    assert "tui_gateway" not in (ROOT / "dashboard" / "plugin_api.py").read_text("utf-8")
