# Full-tree package validation

Run against the **whole checkout**, including demo, tests, and documentation.
Do not copy a source-only subset. Keep virtual environments, pytest basetemp,
synthetic control plugins and `HERMES_HOME` **outside** that checkout.

CI installs Hermes from tag `v0.22.7`, verified at
`b200f5bc60e31588ba2cb60e288029c4a54ba5fa`, using that release's own
`uv sync --locked`. Its source and environment live under `RUNNER_TEMP`,
not inside Pinpoint. The dedicated Linux validation job runs the two CLI
commands below and all validator tests, including known-bad manifest,
security and syntax controls. The Linux/Windows test matrix runs Python,
headless Chromium engine tests, Node bridge tests, build freshness and hygiene.
No gateway or Desktop application is started by these checks.

Example Git Bash/POSIX shell, with the pinned CLI already installed:

```bash
# Activate a test venv OUTSIDE this checkout, with the deps pinned in ci.yml.
# On Windows, set TMPDIR to a native C:/... scratch path outside the checkout.
WORK=$(mktemp -d "${TMPDIR:-/tmp}/pinpoint-check.XXXXXX")
if command -v cygpath >/dev/null 2>&1; then WORK=$(cygpath -m "$WORK"); fi
# A source CLI must not inherit a different Windows Store install's tool root.
unset HERMES_RUNTIME_DIR
export PINPOINT_HERMES="$(command -v hermes)"
env -u PYTHONPATH python -m pytest tests/py tests/engine -q --basetemp="$WORK/pytest"
node --test tests/build/bridge.test.mjs
node scripts/build-desktop.mjs --check
bash scripts/hygiene.sh
HERMES_HOME="$WORK/validate" env -u PYTHONPATH hermes plugins validate . --install-deps
HERMES_HOME="$WORK/doctor" env -u PYTHONPATH hermes plugins doctor . --ci
```

Use a native `C:/.../hermes.exe` for `PINPOINT_HERMES` when running the
Python harness on Windows, not an MSYS `/c/...` path. A missing CLI skips
only integration tests in the general test matrix; the dedicated validator
job installs it explicitly and cannot rely on that skip.

The floor CLI can print `Validation passed.` even after a dependency
preparation error. That is **not** clean install proof: the harness and freeze
script also reject dependency preparation failures. A clean source installation
with `HERMES_RUNTIME_DIR` unset was exercised on Windows. This changes only
the child shell environment, never user settings or the running gateway.

The original full-tree scanner findings were a quoted injection example in
SPEC.md and character-code-based CRLF normalization in demo/fixes/build.py.
The documentation now describes the fixture instead of quoting it; the demo
helper uses equivalent literal newline escapes. No executable file is excluded,
no scanner configuration is weakened, and dangerous synthetic controls still
must fail. This validates package admission, not real-model/Desktop integration.

`freeze.sh` additionally checks a clean main-aligned tree and release assets,
then rewrites the catalog pin. It is a release action, not a harmless test;
do not run its pin-writing stage on a feature branch.
