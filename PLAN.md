# Pinpoint - implementation plan

Read `SPEC.md` first (contracts in its section 4 are frozen). Workspace: `C:/Users/<user>/projects/hermes-plugin-hackathon/plugin/pinpoint/` (= repo root).
Shell: git-bash. Python: `env -u PYTHONPATH python` (3.11.9; has pytest 9.1.1, playwright, pydantic, httpx; **no fastapi**). Git: `PATH="/c/Program Files/Git/cmd:$PATH"`. Node 24 at `/c/Program Files/nodejs`. Hermes CLI: `env -u PYTHONPATH hermes` (v0.22.7).
SAFETY (all packages): the maintainer's real Hermes is running. Never edit `C:/Users/<user>/AppData/Local/hermes/config.yaml`, never restart his gateway (pid file under his home), never type into his windows, never `hermes plugins enable/disable` without `HERMES_HOME` pointing at a rig. Any Desktop/gateway test uses the rig (section 11). Kill only pids you started.

Parallel layout: A, B, C, D, E touch disjoint paths. Shared files are read-only to others: `SPEC.md`, `PLAN.md`. Integration phase I after A-D are green.

```
plugin.yaml  __init__.py  _core.py  _tools.py  _sanitize.py  _store.py        <- A
dashboard/manifest.json  dashboard/plugin_api.py                              <- A
tests/py/**                                                                   <- A
engine/pinpoint-engine.js  tests/engine/**                                    <- B
desktop/src/app.js  desktop/plugin.js (generated)  scripts/build-desktop.mjs  <- C
tests/build/**                                                                <- C
demo/site/**  demo/fixes/**  demo/rig/**  tests/e2e/**                        <- D
README.md  docs/**  plugin-catalog/pinpoint.yaml  .github/workflows/ci.yml  .gitignore  LICENSE   <- E
tools/q5-rig/** (Q5 probe, evidence)                                          <- already present, read-only
```

## Package A - Python half + manifest (1 implementer)
**A0 (15 min, do first): loader facts.** Create `plugin.yaml` + minimal `__init__.py` that does `from . import _core` and registers nothing; run
`HERMES_HOME=$TMP/h env -u PYTHONPATH hermes plugins validate C:/Users/<user>/projects/hermes-plugin-hackathon/plugin/pinpoint`
Expected: `✓ capability probe — register() ran in isolation`. If relative imports fail in the probe or in the real loader (check by copying into a rig `home/plugins/pinpoint/` and running `hermes plugins doctor`), inline `_core/_tools/_sanitize/_store` into `__init__.py` and note it in `docs/DECISIONS.md`. Unverified assumption either way.
**A1 `_sanitize.py`** (TDD `tests/py/test_sanitize.py`): `clean_text(s, cap)`, `clean_selector(s)`, `cap_result(obj, limit=12000)` implementing the drop order in SPEC 4.4. Tests first: controls/bidi stripped, caps, prompt-injection string truncated to 40 chars inside label, drop order. `cd plugin/pinpoint && env -u PYTHONPATH python -m pytest tests/py/test_sanitize.py -q` -> `N passed`.
**A2 `_store.py`** (`tests/py/test_store.py`, `conftest.py` fake `plugins.plugin_storage` using `tmp_path`): schema 4.3, `url_key()` table (>= 12 cases: case, trailing slash, utm, hash route, port, query sort), `record_audit(result, source)`, `delta()`, `set_status()`, LRU prune, dismissed suppression. Expected `N passed`.
**A3 `_core.py` rendezvous** (`tests/py/test_rendezvous.py`): `request(args, session_id) -> dict` writes `rv/<id>.req.json`, broadcasts via `hermes_cli.plugin_events.broadcast_plugin_event` (import inside function, wrapped in try/except -> `desktop_unavailable`), polls 50 ms; `claim_ack(id, window)` exclusive create (`open(..,'x')`); `post_result`; `pending()`; sweep. Tests: no-ack timeout (0.2 s) -> `code:desktop_unavailable`; thread-desktop round trip returns findings; 2nd ack -> `claimed:false`; result timeout -> `code:timeout`; files cleaned.
**A4 `_tools.py`** (`tests/py/test_tools.py`): `audit_handler(args, **kw)`, `pins_handler(args, **kw)` per SPEC 6 schemas verbatim; arg validation -> `bad_args`; `expect_url` mismatch -> `page_mismatch`; `min_severity`, `max_findings` (config default via closure over `ctx.get_config`); `delta` embedded; results via `cap_result`; ALWAYS `json.dumps` string, never raise (fuzz 50 random dict/None/str inputs).
**A5 `dashboard/plugin_api.py`** (thin: only parse + call `_core/_store`; import them via `importlib` from the plugin dir, since the router module is loaded by path [M: probe loaded standalone and only shared state through files]; **if relative import is impossible there, duplicate nothing: put the logic behind files/SQLite only**). Routes per SPEC 4.2. `tests/py/test_api.py` with `pytest.importorskip('fastapi')` + `from fastapi.testclient import TestClient`; run with `uv run --with fastapi --with httpx --with pytest pytest tests/py/test_api.py` (uv at `C:/Users/<user>/.local/bin/uv.exe`) because the default python lacks fastapi.
**A6 `__init__.py` register(ctx)**: `ctx.register_tool` x2 (`toolset="pinpoint"`, emoji), `ctx.register_system_prompt_section("pinpoint.guide", text<=450 chars, position="after_memory")` guarded `if hasattr(ctx,'register_system_prompt_section')`; sweep rv files; no hooks. `tests/py/test_register.py`: stub ctx records calls; assert tool names == `plugin.yaml provides_tools`.
**A7 manifest + validate**: `plugin.yaml` exactly SPEC 7. `tests/py/test_validate.py` runs the CLI (skip if absent). Expected final lines: `✓ declared tools — matches registrations` ... `Validation passed.`
Done when: `env -u PYTHONPATH python -m pytest tests/py -q` all pass (api test via uv), validate passes, no import of `tui_gateway`.

## Package B - Audit engine (1 implementer; the highest-risk code, start now)
Files: `engine/pinpoint-engine.js` (single function `pinpointEngine(config)`, zero deps, nested helpers only), `tests/engine/conftest.py`, `tests/engine/fixtures/*.html`, `tests/engine/labeled/*.html`, tests.
Harness (`tests/engine/conftest.py`): session-scoped `sync_playwright().chromium.launch()`; fixture `load(name, viewport=(800,600))` opens `file://.../fixtures/<name>.html`, injects `'(' + src.strip().rstrip(';') + ')({})'` via `page.evaluate`, returns page with `page.pp.audit(opts)` helper. Measured: headless chromium launches here (`156.0.8078.4`). Fixture hygiene: buttons need `padding:0;border:0` to get small sizes (a default 10x10 button measured 16x10).
TDD order, each = write fixture + failing test, run, implement, run green; commit per step:
- B1 skeleton + `probe()`, idempotent install, forbidden-string lint test (`tests/engine/test_source_lint.py` greps engine source for: `eval(`, `new Function`, `<script`, `import(`, `<<`, `data-testid`, `data-slot`, `document.body` next to `MutationObserver`). Expected `3 passed` then grows.
- B2 util layer: colour parser (table incl. oklch/color-mix via canvas fallback), luminance/ratio, HSL fix-suggestion, selector generator + fingerprint/id (`tests/engine/test_util.py` via `page.evaluate` on exposed `api.__test`, removed? keep `__test` exposed only when `config.test===true`).
- B3 rules 1-5 (contrast, tap-target, img-alt, form-label, control-name) one fixture each with `bad-*`/`ok-*` ids; contrast fixtures must include alpha text, opacity ancestor, translucent bg stack, dark mode `color-scheme`, gradient bg (expect NO finding + `limits`), disabled control (no finding).
- B4 rules 6-14 likewise (focus-indicator fixtures: `outline:none` no replacement = bad; `:focus-visible{box-shadow}` = ok; cross-origin sheet -> limit note).
- B5 `audit()` aggregate: score table test (hand-computed), determinism, `suppress`, `maxFindings`, `rules` filter, perf test (5 000-element page < 400 ms; otherwise viewport mode + limit).
- B6 `render()`/pin layout: shadow root overlay, status colours, collision-split (12 findings / 3 elements -> min distance >= 24), leader line, clamping, off-screen no-pin, `lost` handling, events queue (`pin-click`, `fix`, `dismiss` via real `page.click` on shadow pins), `focusPin`.
- B7 live tracking: banner insert (120 px) -> pins within 100 ms; scroll; `page.set_viewport_size`; re-render (replace node by clone) -> re-resolved; navigation-like `dirty` event after DOM quiet; observers use `documentElement` only; overlay excluded from audit; overlay passes its own audit (tap 24 px, names, contrast).
- B8 labeled corpus (>= 120 labeled elements across rules) -> `tests/engine/test_metrics.py` prints precision/recall per rule and writes `docs/metrics.md`; acceptance: each rule precision >= 0.95, recall >= 0.9 on the set (the set is ours: say so in README).
- B9 optional cross-check: `npm i --prefix tests/engine/.axe axe-core` (dev only, not shipped) and compare contrast results on the demo site; report agreement, do not gate on it.
Command: `cd plugin/pinpoint && env -u PYTHONPATH python -m pytest tests/engine -q` -> all pass; `--durations=5` to watch speed.
Done when all above plus: engine source < 60 KB, no forbidden strings, `docs/metrics.md` present.

## Package C - Desktop half (1 implementer; needs B's API only through SPEC 4.1 - code against a stub engine until B lands)
Files: `desktop/src/app.js`, `scripts/build-desktop.mjs`, generated `desktop/plugin.js`, `tests/build/test_build.py`.
- C1 build script first (TDD `tests/build`): `node scripts/build-desktop.mjs` reads `engine/pinpoint-engine.js` (strip trailing `;`), inserts it verbatim at the line `/*@@ENGINE@@*/` in `desktop/src/app.js`, writes `desktop/plugin.js` with a `// GENERATED - do not edit` header. `--check` exits 1 on drift. Expected: `node scripts/build-desktop.mjs --check; echo $?` -> `0`. Test also runs `hermes plugins validate` on a tmp package copy (needs the `desktop surface` check to stay ✓).
- C2 bridge: `register(ctx)`: `host.onEvent('plugin.pinpoint.audit.request')`, ack/result over `ctx.rest`, error-code mapping from `executeJavaScript` rejections, `ctx.preview.isAvailable()` gate, `GET /health` -> desktop-only mode, `GET /pending` on register and on window focus. Unit-test the pure parts with node (`tests/build/bridge.test.mjs` run by plain `node --test`): code mapping table, prompt template builder (<= 700 chars, finding with 500-char label stays within cap), rate limiter, url-key helper (must equal Python's table; share the table as `tests/shared/url_key_cases.json` produced by A2 - A owns, C consumes).
- C3 pane + chip + palette (no JSX): score ring, rows, states (empty/running/result/error/desktop-only/paused), first-run consent card. Verify visually in the rig (screenshot via CDP) - note: how to open a plugin pane programmatically is UNMEASURED; first measure it (palette navigation vs `host.navigate`), record in `docs/DECISIONS.md`.
- C4 loop: inject-if-missing, poll (500/1000 ms), re-audit debounce 800 ms, diff via `POST /audit` -> `setStatuses`, rate limits, toast, `composer.submit` -> `insertText` fallback. Log with `console.error('[pinpoint] ...')` (mirrored to `desktop.log` [M]) for E2E assertions.
- C5 hot-reload adoption: on `register` read engine state back from the page (`probe()`), resume (spike lesson [M]); on `dispose` clear intervals (use `ctx.setInterval`, tracked).
Done when: build check passes, validate passes, rig screenshot shows pane + pins on `demo/site`, and a manual palette audit works with Python half disabled (desktop-only mode).

## Package D - Demo site, rig, E2E (1 implementer)
- D1 `demo/site/*` per SPEC 12 (pretty first; open in Edge/Chromium and screenshot to `docs/img/demo-before.png`), `flaws.json`, `serve.py` (stdlib; `python demo/site/serve.py 8765`), `demo/site/fixed/*`, `demo/fixes/*.patch`. Acceptance test `tests/e2e/test_site_truth.py` (playwright, injects B's engine): audit result contains every `flaws.json` entry and no finding on `ok-*` ids. Until B lands, assert only that the page loads and flaws are present in DOM.
- D2 rig scripts `demo/rig/rig.py` (`start`, `stop`, `status`) productising `tools/q5-rig/`: creates `RIG=C:/Users/<user>/AppData/Local/pinpoint-rig` (OUTSIDE `%LOCALAPPDATA%/hermes`), writes `home/config.yaml` (`_config_version: 52`, custom provider -> fake LLM `http://127.0.0.1:8799/v1`, `plugins.enabled: [pinpoint]`), copies the repo to `home/plugins/pinpoint` (excluding tests/demo/.git), launches Desktop with `HERMES_HOME`, `--user-data-dir`, `--remote-debugging-port=9444`, `HERMES_DESKTOP_SKIP_PROTOCOL_REGISTRATION=1`, waits for `Hermes gateway is ready` in `home/logs/desktop.log`, sets `localStorage hermes.desktop.pluginDecisions.v2={"pinpoint":true}` over CDP and reloads. `stop` kills only the rig's Electron (cmdline match `pinpoint-rig`) and the gateway pid from `home/gateway.pid`, then optionally deletes the rig. Exact commands measured in `decisions/003-q5.md` and `tools/q5-rig/` (cdp.py, send.py need the `composer-rich-input` selector).
- D3 consent/preview in the rig (UNMEASURED): find out how to open the Browser pane on `http://127.0.0.1:8765/` and grant `pinpoint` consent for the rig profile (drive the app dialog over CDP/clicks or seed the grant store; record method + evidence in `docs/DECISIONS.md`). If it cannot be automated, E2E scenarios 1-4 become semi-manual and the engine+loop is still covered by B and the Python round trip by A.
- D4 fake LLM `demo/rig/fakellm.py` (from `tools/q5-rig/fakellm.py`) scripted per scenario by a `script.json` (turn matchers on last user/tool text -> tool_calls); supports `tool_call` bridge, `patch`/`write_file` calls for the scripted fix; logs requests to JSONL (assert on it).
- D5 `tests/e2e/test_loop.py` scenarios 1-6 of SPEC 11 via CDP (`Runtime.evaluate` for `window.__pinpoint` inside the page is not directly reachable; assert via `desktop.log` `[pinpoint]` lines, fake-LLM JSONL and screenshots). Expected: `6 passed` or documented skips with reasons.
- D6 `docs/DEMO.md`: 90 s shot list (0-5 s finished-frame caption; 5-20 s "audit my page"; 20-60 s pins appear -> click pin 1 -> agent patches CSS -> pins turn green, score 41 -> 78; 60-80 s `validate` + disclosure frame; 80-90 s install line + @NousResearch), captions burned in, two takes, fixture-based, no network.

## Package E - Docs, catalog, CI, hygiene (1 implementer)
- E1 `README.md`: problem, 30 s install (`hermes plugins install ...` then enable BOTH halves: Python via `hermes plugins enable pinpoint`, Desktop via Capabilities > Plugins), hero image, 3 screenshots (from D), how it works diagram (SPEC 2), the two tools, differentiation table (SPEC 1), consent explanation, limits (SPEC 9 + not-verified list), metrics table from `docs/metrics.md`, disclosure paragraph verbatim from SPEC 10.
- E2 `plugin-catalog/pinpoint.yaml` draft:
```yaml
name: pinpoint
repo: https://github.com/stupidburgers/pinpoint
sha: "<40 hex, filled at freeze>"
subdir: ""
description: "<SPEC 10 disclosure, one line>"
maintainer: stupidburgers
tier: community
category: desktop
requires_hermes: ">=0.22.7"
version: "0.1.0"
readme: true
image: <raw url pinned to sha>
screenshots: [<<=6 raw urls pinned to sha>]
platforms: [windows, macos, linux]
known_issues: ["<honest list: consent dialog is host-owned; pin clicks delivered by 0.5-1 s polling; focus-indicator is a CSSOM heuristic; cross-origin stylesheets/iframes not scanned; macOS/Linux not tested; both halves must be enabled>"]
capabilities: {provides_tools: [pinpoint_audit, pinpoint_pins], provides_hooks: [], provides_middleware: [], requires_env: []}
```
  Cross-check against `research/hermes-agent/plugin-catalog/redline.yaml` shape; version quoted; `capabilities` is a DICT here vs a list in plugin.yaml.
- E3 `.github/workflows/ci.yml`: matrix ubuntu/windows; steps: setup-python 3.11, `pip install pytest playwright fastapi httpx pyyaml`, `playwright install chromium`, `pytest tests/py tests/engine -q`, `node scripts/build-desktop.mjs --check`; validate step `hermes plugins validate .` only if CLI installable (document skip otherwise). `.gitignore`: `__pycache__/`, `*.pyc`, `.pytest_cache/`, `node_modules/`, `.axe/`. `LICENSE` MIT.
- E4 `docs/SUBMISSION.md` checklist: validate green on a clean clone at the pinned SHA; PR adds `plugin-catalog/pinpoint.yaml` to NousResearch/hermes-agent with disclosure + first comment "what is not verified"; X post <90 s video tagging @NousResearch; Typeform https://form.typeform.com/to/FwJLvOln; freeze Nov 10 (deadline 2026-11-11 17:00 EST = 19:00 BRT).
- E5 hygiene scan before freeze: no `__pycache__`/pyc committed (installer BLOCK seen in shader-forge [M]), no `h << 5`-style code, no `eval`/`new Function`/`<script`.

## Phase I - Integration (lead, after A-D green; Nov 6)
1. `node scripts/build-desktop.mjs` -> `hermes plugins validate .` (HERMES_HOME=rig) -> `Validation passed.`
2. `python demo/rig/rig.py start`; run `tests/e2e`; capture evidence into `evidence/`.
3. Fallback decision (decisions/002): Q5 is already resolved, so the Nov 6 12:00 BRT trigger can only fire if the engine+loop cannot be made to work in the rig; check then.
4. Record the 90 s video (D6), fill README images, freeze SHA Nov 10, PR Nov 10-11.

## Risks to watch (ordered)
1. Consent/Browser pane cannot be automated in the rig (D3) -> E2E partly manual. Mitigation: B + A tests carry most assurance; manual smoke by the maintainer.
2. Real model may ignore the deferred tool (unmeasured). Mitigation: system-prompt section; first-sentence description; the pin click sends an explicit prompt that names `pinpoint_audit`.
3. Engine heuristics (focus-indicator, contrast with images) -> false positives; mitigated by skip+`limits` and the precision gate (B8).
4. Polling latency/flicker on pins; mitigated by rAF reposition inside the page (B7).
5. Multi-window ack race (designed, unmeasured).

## 11. Rig recipe (measured in this session; full evidence `decisions/003-q5.md`)
```
RIG=C:/Users/<user>/AppData/Local/pinpoint-rig          # NOT under %LOCALAPPDATA%/hermes (else the gateway attaches to the maintainer's host gateway and exits 0)
mkdir -p $RIG/home/plugins $RIG/ud
cat > $RIG/home/config.yaml <<EOF
_config_version: 52
model: {provider: custom, default: fake-1, base_url: "http://127.0.0.1:8799/v1", api_key: fake}
plugins: {enabled: [pinpoint]}
EOF
cp -r <repo minus tests/demo/.git> $RIG/home/plugins/pinpoint
(env -u PYTHONPATH python demo/rig/fakellm.py 8799 $RIG/fakellm.jsonl &)
HERMES_HOME=$RIG/home HERMES_DESKTOP_SKIP_PROTOCOL_REGISTRATION=1 \
 "/c/Program Files/WindowsApps/NousResearchInc.HermesAgent_2026.7363.3271.0_x64__sznbd6dv1j3v4/app/Hermes Agent.exe" \
 --remote-debugging-port=9444 --user-data-dir=$RIG/ud            # run via terminal(background=true), not `&`
# ready when: grep "Hermes gateway is ready" $RIG/home/logs/desktop.log   (~12-35 s)
# enable desktop half: CDP eval  localStorage.setItem('hermes.desktop.pluginDecisions.v2', JSON.stringify({pinpoint:true})); location.reload()
# send a chat message: tools/q5-rig/send.py (selector [data-slot="composer-rich-input"], Input.insertText, Enter key)
# desktop plugin console.error lines land in $RIG/home/logs/desktop.log as "[renderer console:main] [pinpoint] ..."
# stop: kill electron by cmdline match 'pinpoint-rig', kill pid in $RIG/home/gateway.pid, kill fakellm, rm -rf $RIG
```
If you edit `desktop/plugin.js` in `home/desktop-plugins/pinpoint/` only a page reload is needed; Python changes need the rig gateway restarted (kill pid from `gateway.pid`, relaunch Desktop). `hermes plugins validate` accepts native `C:/...` paths only.

## Timeline (BRT)
Nov 5: A, B1-B5, C1-C2, D1-D2, E1 draft. Nov 6 AM: B6-B8, C3-C5, D3-D5; 12:00 fallback checkpoint; Nov 6 PM: Phase I. Nov 7-8: polish, metrics, video takes. Nov 9: dry-run PR in a fork. Nov 10: freeze SHA, final validate on clean clone, PR + X + Typeform. Nov 11 19:00 BRT: hard deadline.
