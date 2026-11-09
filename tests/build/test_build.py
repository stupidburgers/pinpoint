"""Build tests for the desktop half (C1). Run: env -u PYTHONPATH python -m pytest tests/build -q"""
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
NODE = os.environ.get("NODE") or shutil.which("node")
STUB = ROOT / "tests" / "build" / "stub-engine.js"
BUILD = ROOT / "scripts" / "build-desktop.mjs"

pytestmark = pytest.mark.skipif(not NODE or (not Path(NODE).exists() and not shutil.which(NODE)), reason="node not installed")

FORBIDDEN = ["eval(", "new Function", "<script", "import(", "data-testid", "data-slot", "<<", "querySelector('webview')", 'querySelector("webview")']


def run(*args, cwd=ROOT):
    return subprocess.run([NODE, str(BUILD), *args], cwd=cwd, capture_output=True, text=True)


def make_tree(tmp_path, engine=STUB):
    """Copy of the repo parts the build reads, so tests never touch the real desktop/plugin.js."""
    (tmp_path / "desktop" / "src").mkdir(parents=True)
    (tmp_path / "engine").mkdir()
    for n in ("app.js", "bridge.js"):
        shutil.copy(ROOT / "desktop" / "src" / n, tmp_path / "desktop" / "src" / n)
    shutil.copy(engine, tmp_path / "engine" / "pinpoint-engine.js")
    return tmp_path


def test_build_inlines_engine_and_bridge(tmp_path):
    t = make_tree(tmp_path)
    r = run("--root", str(t))
    assert r.returncode == 0, r.stderr
    out = (t / "desktop" / "plugin.js").read_text(encoding="utf8")
    assert out.startswith("// GENERATED - do not edit")
    assert "function pinpointEngine(config)" in out
    assert "function mapExecError(" in out and "export function" not in out
    assert "/*@@" not in out
    assert "capabilities: ['preview.executeJavaScript']" in out
    assert "id: ID," in out and "const ID = 'pinpoint'" in out


def test_generated_file_parses_as_esm(tmp_path):
    t = make_tree(tmp_path)
    assert run("--root", str(t)).returncode == 0
    mjs = t / "desktop" / "plugin.mjs"
    shutil.copy(t / "desktop" / "plugin.js", mjs)
    r = subprocess.run([NODE, "--check", str(mjs)], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


def test_only_allowed_imports(tmp_path):
    t = make_tree(tmp_path)
    run("--root", str(t))
    out = (t / "desktop" / "plugin.js").read_text(encoding="utf8")
    specs = set(re.findall(r"^import .* from '([^']+)'", out, re.M))
    assert specs <= {"@hermes/plugin-sdk", "react", "react/jsx-runtime"}, specs


def test_check_detects_drift(tmp_path):
    t = make_tree(tmp_path)
    assert run("--check", "--root", str(t)).returncode == 1          # missing output counts as drift
    assert run("--root", str(t)).returncode == 0
    assert run("--check", "--root", str(t)).returncode == 0
    p = t / "desktop" / "plugin.js"
    p.write_text(p.read_text(encoding="utf8") + "\n// hand edit\n", encoding="utf8")
    assert run("--check", "--root", str(t)).returncode == 1


def test_engine_must_declare_factory(tmp_path):
    t = make_tree(tmp_path)
    (t / "engine" / "pinpoint-engine.js").write_text("const x = 1", encoding="utf8")
    assert run("--root", str(t)).returncode == 2


def test_no_forbidden_strings_in_desktop_sources():
    for f in (ROOT / "desktop" / "src" / "app.js", ROOT / "desktop" / "src" / "bridge.js"):
        txt = f.read_text(encoding="utf8")
        for bad in FORBIDDEN:
            assert bad not in txt, f"{bad!r} in {f.name}"


def test_repo_plugin_js_is_current():
    """desktop/plugin.js committed in the repo must equal a fresh build from engine/pinpoint-engine.js."""
    if not (ROOT / "engine" / "pinpoint-engine.js").exists():
        pytest.skip("engine not present")
    r = run("--check")
    assert r.returncode == 0, r.stderr


def test_bridge_unit_tests_pass():
    r = subprocess.run([NODE, "--test", str(ROOT / "tests" / "build" / "bridge.test.mjs")], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout[-2000:] + r.stderr[-500:]
