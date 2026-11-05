import hashlib
import pathlib
import shutil
import subprocess

import pytest

HERE = pathlib.Path(__file__).parent
SRC = HERE / "pinpoint-engine.full.js"
OUT = HERE.parent.parent / "engine" / "pinpoint-engine.js"


def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def test_shipped_engine_matches_full_source(tmp_path):
    """engine/pinpoint-engine.js must be testable output of compact.py (no hand edits)."""
    npx = shutil.which("npx") or shutil.which("npx.cmd")
    if not npx:
        pytest.skip("npx not available")
    tmp = tmp_path / "regen.js"
    cmd = [npx, "--yes", "terser@5", str(SRC), "-c", "pure_funcs=[]", "-m",
           "reserved=['window','document']", "--keep_fnames", "-o", str(tmp)]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if r.returncode:
        pytest.skip(f"terser unavailable: {r.stderr[-200:]}")
    assert digest(tmp) == digest(OUT), "engine/pinpoint-engine.js is stale; run tests/engine/compact.py"
