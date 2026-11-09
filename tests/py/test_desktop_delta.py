"""Run Desktop delta/orchestration regressions in the normal safe CI suite."""
from pathlib import Path
import shutil
import subprocess


def test_desktop_delta_and_retained_state():
    root = Path(__file__).resolve().parents[2]
    node = shutil.which("node")
    assert node, "Node is required to test the shipped Desktop half"
    result = subprocess.run(
        [node, "--test", "tests/build/bridge.test.mjs", "tests/build/audit-state.test.mjs",
         "tests/build/delta-cases.test.mjs"],
        cwd=root, capture_output=True, text=True, encoding="utf-8", timeout=60,
    )
    assert result.returncode == 0, result.stdout + result.stderr
