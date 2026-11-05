"""Full-tree validator/doctor tests against the real shipped repository.

Design notes (release task R1a):

- The validator scans whatever tree it is pointed at, so the repository is
  validated IN PLACE: no copy step. The pre-R1a test copied the repo into
  ``tmp_path`` while EXCLUDING docs/demo/tests/tools, which (a) never proved
  the shipped tree an installer actually scans and (b) exploded with an
  unbounded recursive copy whenever pytest's basetemp (or a venv) lived
  inside the checkout (``shutil`` copies the destination into itself until
  the path-length limit errors out). Nothing here copies the repository.
  The harness explicitly rejects basetemp/HERMES_HOME inside the checkout;
  virtual environments must also remain outside, so neither their installed
  dependencies nor synthetic control files contaminate the raw-tree scan.
- ``HERMES_HOME`` is redirected into ``tmp_path`` for hermetic validator
  state. The plugin tree is read-only to the validator, which the first test
  proves with a before/after content digest.
- Control tests feed the CLI tiny synthetic trees (every byte created by the
  test itself under ``tmp_path`` — bounded and trusted) that MUST fail.
  They prove the harness can go red on a known-bad manifest, dangerous
  source, and a syntax error, so a green run of the real tree is not
  vacuous. No xfails and no scanner suppressions anywhere.
"""
import hashlib
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
HERMES = os.environ.get("PINPOINT_HERMES") or shutil.which("hermes")
TIMEOUT_S = 180

requires_hermes = pytest.mark.skipif(HERMES is None, reason="hermes CLI not installed")

FAIL = "✗"
PASS_LINE = "Validation passed."


def _run_hermes(args, tmp_path, home_name="home"):
    """Run the hermes CLI hermetically; a timeout is a RED result (124), not an error."""
    if tmp_path.resolve().is_relative_to(ROOT.resolve()):
        raise ValueError("validator basetemp/HERMES_HOME must be outside the checkout")
    # A source CLI must not inherit a different install's sealed Windows runtime.
    env = {k: v for k, v in os.environ.items() if k not in {"PYTHONPATH", "HERMES_RUNTIME_DIR"}}
    env["HERMES_HOME"] = str(tmp_path / home_name)
    env["PYTHONIOENCODING"] = "utf-8"
    argv = [HERMES, *[str(a).replace("\\", "/") for a in args]]
    try:
        p = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", env=env, timeout=TIMEOUT_S)
        return p.returncode, p.stdout + p.stderr
    except subprocess.TimeoutExpired as exc:
        out = (exc.stdout or "") if isinstance(exc.stdout, str) else ""
        err = (exc.stderr or "") if isinstance(exc.stderr, str) else ""
        return 124, out + err + f"\nTIMEOUT after {TIMEOUT_S}s: {argv}"


def _tree_digest(root):
    """sha256 over (relpath, size, content) for the whole tree minus .git."""
    h = hashlib.sha256()
    for p in sorted(root.rglob("*")):
        rel = p.relative_to(root)
        if ".git" in rel.parts or not p.is_file():
            continue
        h.update(str(rel).replace("\\", "/").encode())
        h.update(str(p.stat().st_size).encode())
        h.update(p.read_bytes())
    return h.hexdigest()


def _write_min_plugin(dst, init_src):
    dst.mkdir(parents=True)
    (dst / "plugin.yaml").write_text(
        f'name: {dst.name}\nversion: "0.1.0"\ndescription: "synthetic validator control"\n',
        encoding="utf-8")
    if init_src is not None:
        (dst / "__init__.py").write_text(init_src, encoding="utf-8")
    return dst


@requires_hermes
def test_validate_full_tree_passes_and_leaves_tree_untouched(tmp_path):
    """The exact shipped tree — docs, demo, tests and all — must validate clean."""
    before = _tree_digest(ROOT)
    code, out = _run_hermes(["plugins", "validate", ROOT, "--install-deps"], tmp_path)
    assert "dependency preparation failed:" not in out, out
    assert FAIL not in out, out                       # zero failed checks, not zero checked files
    assert PASS_LINE in out, out
    assert code == 0, out
    assert "capability probe" in out and "register() ran in isolation" in out
    assert "declared tools — matches registrations" in out
    assert "security scan — safe" in out              # no findings at all (caution would warn)
    assert "tui_gateway" not in out                   # no private-import warning
    assert _tree_digest(ROOT) == before               # validator never writes into the tree


@requires_hermes
def test_doctor_full_tree_ci_passes(tmp_path):
    code, out = _run_hermes(["plugins", "doctor", ROOT, "--ci"], tmp_path, "home-doctor")
    assert code == 0, out
    assert FAIL not in out
    assert "OK:" in out


@requires_hermes
def test_control_bad_manifest_goes_red(tmp_path):
    """A plugin missing a required manifest field MUST fail validation."""
    target = _write_min_plugin(tmp_path / "bad-manifest", None)
    (target / "plugin.yaml").write_text('name: bad-manifest\nversion: "0.1.0"\n', encoding="utf-8")
    code, out = _run_hermes(["plugins", "validate", target, "--install-deps"], tmp_path, "home-bad")
    assert code != 0, out
    assert FAIL in out and "manifest fields" in out, out
    assert PASS_LINE not in out


@requires_hermes
def test_control_dangerous_source_goes_red(tmp_path):
    """Dangerous source (critical scanner finding) MUST fail the security scan."""
    # Phrase assembled split so THIS test file (a scanned test tree) holds no literal
    # attack string; the written synthetic file contains the contiguous critical phrase.
    payload = "ignore all previous instruc" + "tions"
    init = f'PAYLOAD = "{payload}"\n\ndef register(ctx):\n    pass\n'
    target = _write_min_plugin(tmp_path / "dangerous-ctrl", init)
    code, out = _run_hermes(["plugins", "validate", target, "--install-deps"], tmp_path, "home-danger")
    assert code != 0, out
    scan_failed = [l for l in out.splitlines() if FAIL in l and "security scan" in l]
    assert scan_failed, out


@requires_hermes
def test_control_syntax_error_goes_red(tmp_path):
    """Unparseable plugin source MUST fail validation."""
    target = _write_min_plugin(tmp_path / "syntax-ctrl", "def broken(:\n    pass\n")
    code, out = _run_hermes(["plugins", "validate", target, "--install-deps"], tmp_path, "home-syntax")
    assert code != 0, out
    assert FAIL in out and "import failed" in out, out
    assert PASS_LINE not in out


def test_harness_rejects_basetemp_inside_checkout(monkeypatch):
    monkeypatch.setattr(os, "environ", {})
    def no_spawn(*args, **kwargs):
        pytest.fail("must reject an internal basetemp before invoking the CLI")
    monkeypatch.setattr(subprocess, "run", no_spawn)
    with pytest.raises(ValueError, match="outside the checkout"):
        _run_hermes(["plugins", "validate", ROOT], ROOT / "nested-pytest")


def test_harness_in_place_no_copy_and_isolated_environment(tmp_path, monkeypatch):
    monkeypatch.setattr(os, "environ", {})
    def no_copy(*args, **kwargs):
        pytest.fail("validation must not recursively copy the checkout")
    monkeypatch.setattr(shutil, "copytree", no_copy)
    monkeypatch.setenv("PYTHONPATH", "untrusted-import-path")
    monkeypatch.setenv("HERMES_RUNTIME_DIR", "unrelated-store-runtime")
    monkeypatch.setitem(_run_hermes.__globals__, "HERMES", "hermes")
    def run(argv, **kwargs):
        assert argv == ["hermes", "plugins", "validate", ROOT.as_posix(), "--install-deps"]
        assert "PYTHONPATH" not in kwargs["env"]
        assert "HERMES_RUNTIME_DIR" not in kwargs["env"]
        assert kwargs["env"]["HERMES_HOME"] == str(tmp_path / "home")
        return subprocess.CompletedProcess(argv, 0, "control output", "")
    monkeypatch.setattr(subprocess, "run", run)
    assert _run_hermes(["plugins", "validate", ROOT, "--install-deps"], tmp_path) == (0, "control output")
