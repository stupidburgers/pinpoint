# Pinpoint contributor checks

Read `SPEC.md` for the product contracts. Run commands from the repository root.
Historical private work assignments and machine-specific setup are not release material.

## Safety

- Never edit the live user's Hermes configuration, restart their gateway, or
  automate their Desktop windows. Kill only processes started by the test rig.
- Use an explicit independent `RIG` directory outside the live Hermes home.
  Set `HERMES_HOME` for every validation, doctor or plugin-management command.
- Do not reuse a browser profile or select the Desktop's "Use my profile" action.
- Keep raw transcripts, logs, session identities and unreviewed captures outside
  the repository. The privacy gate scans all tracked text, not image contents.

## Contributor checks

Use Python 3.11+ with pytest, Playwright, FastAPI, httpx and PyYAML, Node 24,
Git and the supported Hermes CLI on PATH. Install Playwright's Chromium first.

```sh
env -u PYTHONPATH python -m unittest discover -s tests/build -p test_privacy_check.py -v
env -u PYTHONPATH python -m pytest tests/py tests/engine tests/build -q
node --test tests/build/*.mjs
node scripts/build-desktop.mjs --check
bash scripts/hygiene.sh
git diff --check
```

Keep dependency environments and pytest temporary directories outside the plugin
checkout. Full-tree validation must not hide docs, demo or evidence subfolders.
For example, with an independently created scratch directory `$CHECK_HOME`:

```sh
HERMES_HOME="$CHECK_HOME/validate" hermes plugins validate . --install-deps
HERMES_HOME="$CHECK_HOME/doctor" hermes plugins doctor . --ci
```

## 11. Isolated rig recipe

Set `RIG` to an explicit disposable directory outside the live Hermes home.
`HERMES_EXE` may select the Desktop executable; otherwise the Windows rig queries
its installed Store package dynamically. Do not hardcode a Store package build.

```sh
export RIG="$ISOLATED_TEST_ROOT/pinpoint-rig"
python demo/rig/rig.py start
python demo/rig/rig.py status
python demo/rig/rig.py open-site
python demo/rig/rig.py stop --delete
```

This driver is Windows-specific. Its default service ports are CDP 9444, site
8765 and fake model 8799; override `PORT`, `SITE_PORT`, `LLM_PORT` when needed.
The scripted fake model is test instrumentation, not evidence of live-model
quality. Record actual results and limitations rather than expected output.
