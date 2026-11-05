import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
HERMES = shutil.which("hermes")

pytestmark = pytest.mark.skipif(HERMES is None, reason="hermes CLI not installed")


def run_validate(tmp_path, target=ROOT):
    env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
    env["HERMES_HOME"] = str(tmp_path / "home")
    env["PYTHONIOENCODING"] = "utf-8"
    p = subprocess.run([HERMES, "plugins", "validate", str(target).replace("\\", "/")],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", env=env, timeout=120)
    return p.returncode, p.stdout + p.stderr


def test_validate_passes(tmp_path):
    # validate a clean copy of the shipped python half (what an installer would see: no tests/docs/.git)
    dst = tmp_path / "pinpoint"
    shutil.copytree(ROOT, dst, ignore=shutil.ignore_patterns(
        ".git", "__pycache__", "tests", "tools", "evidence", "demo", "docs", ".pytest_cache", "node_modules",
        "SPEC.md", "PLAN.md"))
    code, out = run_validate(tmp_path, dst)
    assert "\u2717" not in out, out
    assert "capability probe" in out and "register() ran in isolation" in out
    assert "declared tools \u2014 matches registrations" in out
    assert "Validation passed." in out, out
    assert code == 0
    assert "tui_gateway" not in out  # no private-import warning


def test_validate_repo_root_reports_only_known_doc_hit(tmp_path):
    """Informational: validating the repo root also scans SPEC.md/PLAN.md (docs quote attack strings)."""
    code, out = run_validate(tmp_path)
    failures = [l for l in out.splitlines() if "\u2717" in l]
    assert all("security scan" in l for l in failures), out
