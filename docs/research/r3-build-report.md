# R3-2b build report: fail-closed fixed / gone / not-rechecked

Everything below was produced by commands run in this clone (a fresh clone, branch `release/catalog-r3`). Nothing was pushed. `pytest.ini` in the clone is untracked and intentionally not committed. The Python venv of the sibling checkout was used read-only (the `.venv` of the sibling pinpoint-release checkout, Python 3.11.17, Node v26.12.1, Hermes Agent v0.23.0).

Note: this report is committed after the code, so the SHA below is the code head that the logs below were produced on (the report commit sits on top of it); `git rev-parse HEAD` after the report commit is quoted in the kanban completion.

## Git evidence (code head, before the report commit)

```
$ git rev-parse HEAD
1444acc412b15d6a4ca1ddf8f65f22deef3df3b7

$ git log --oneline e3652bd..HEAD
1444acc feat(desktop): same fail-closed fixed/gone/not_rechecked classifier in localDelta; gone rows and independent can't-locate tag; tool descriptions; regenerate plugin.js
9f80201 feat(store): fail-closed fixed/gone/not_rechecked classifier; shared delta truth-table fixture; drop legacy presence exception
f41a678 docs: replace same-element fixed claim with conservative fixed/gone/not-rechecked definitions and precise data disclosure
8392cd3 test: share the root-package import guard via tests/conftest.py so tests/engine runs from any checkout dir
e56d80a test(py): make tests/py runnable from any checkout directory name (skip pytest's own import of root __init__.py)
22cea74 feat(desktop): port prompt-breakout delimiter defense to the Desktop prompt path; CI runs every build test
45a00f4 chore(hygiene): drop captured logs and local paths from tracked files; scan all tracked text in hygiene.sh; run all build tests in freeze
69ae9fa security: page-originated drain events may only select; never send chat, change status, or set the instruction

$ git diff --stat e3652bd HEAD
.github/workflows/ci.yml                |    2 +-
 .gitignore                              |    1 +
 PLAN.md                                 |  157 +-
 README.md                               |    6 +-
 SPEC.md                                 |   18 +-
 _store.py                               |  130 +-
 _tools.py                               |   11 +-
 demo/rig/rig.py                         |   11 +-
 desktop/plugin.js                       |  212 +-
 desktop/src/app.js                      |   58 +-
 desktop/src/bridge.js                   |  154 +-
 docs/delta-semantics.md                 |   42 +-
 evidence/q5-agent-log.txt               |    5 -
 evidence/q5-desktop-log.txt             |   63 -
 evidence/q5-fakellm-requests.jsonl      |   10 -
 plugin-catalog/pinpoint.yaml            |    2 +-
 plugin.yaml                             |    2 +-
 scripts/freeze.sh                       |    6 +-
 scripts/hygiene.sh                      |    5 +-
 scripts/privacy-check.py                |   59 +
 tests/build/RIG-NOTES.md                |    4 +-
 tests/build/audit-state.test.mjs        |   54 +-
 tests/build/bridge.test.mjs             |   76 +-
 tests/build/delta-cases.test.mjs        |   39 +
 tests/build/fix-event-security.test.mjs |  210 ++
 tests/build/test_build.py               |    5 +-
 tests/build/test_privacy_check.py       |   71 +
 tests/conftest.py                       |   35 +
 tests/py/conftest.py                    |    3 +
 tests/py/test_api.py                    |   15 +-
 tests/py/test_coverage.py               |    9 +-
 tests/py/test_delta_cases.py            |   62 +
 tests/py/test_desktop_delta.py          |    5 +-
 tests/py/test_gone_vs_fixed.py          |   61 +-
 tests/py/test_result_boundary.py        |    5 +-
 tests/py/test_store.py                  |   26 +-
 tests/py/test_tools.py                  |   27 +-
 tests/shared/delta_cases.json           | 3421 +++++++++++++++++++++++++++++++
 tests/shared/url_key_cases.json         |    2 +-
 39 files changed, 4589 insertions(+), 495 deletions(-)
```

## Test and gate output (tails, run on the code head)

```
$ node --test tests/build/*.mjs
✔ page-forged design/dismiss/inspect events never submit, draft, or set the instruction (0.6663ms)
ℹ tests 155
ℹ suites 0
ℹ pass 155
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 283.2194

$ python -m pytest tests/py -q
-- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html
293 passed, 1 warning in 51.99s

$ python -m pytest tests/engine -q      # real Chromium via playwright, engine unchanged in this card
..........................                                               [100%]
170 passed in 37.27s

$ node scripts/build-desktop.mjs --check
build-desktop: up to date (135100 bytes)

$ bash scripts/hygiene.sh
privacy ok (133 tracked text files; binary images not reviewed)
hygiene ok

$ hermes plugins validate .
  · dashboard backend API is served through the plugin host (buffered
responses)

Validation passed.
```

Not run: `tests/e2e` (fake-model rendezvous scenarios), `hermes plugins doctor --ci`, any real Hermes Desktop session. No UI claim below is backed by a real Desktop observation.

## Python test harness

`pytest tests/py` failed at setup in this clone because the plugin root has an `__init__.py` full of relative imports; in a checkout directory whose name is not a valid identifier, pytest imported it as a top-level `__init__` and died. `tests/conftest.py` (shared by `tests/py` and `tests/engine`) now skips pytest's own import of the root `__init__.py` only; `tests/py/conftest.py` still loads the plugin as a proper package. Commits `e56d80a` and `8392cd3`. Both suites run from this directory name (`pp-r3`).

## What was implemented

One classifier in two languages, driven by one fixture:

- `_store.py` `classify_absent` / `_extract_coverage` / `record_audit`, `desktop/src/bridge.js` `localDelta` / `auditCoverage`, and the shared cases `tests/shared/delta_cases.json` (51 cases, generated once by a throwaway script, hand-written expectations) consumed by `tests/py/test_delta_cases.py` and `tests/build/delta-cases.test.mjs`. Both pass on all 51 cases plus 2 receipt-text cases.
- Removed the legacy "presence exception" (absent + covered + no presence data = fixed) and the `stats.checked` coverage fallback. Any non-empty `limits` now blocks absence-based verdicts (before, only truncation did).
- New host-owned `audit_options` ({contrast, tapAdvisory}) stamped by the Desktop on the result and on each finding (`audit_sig`, e.g. `AA|44`); a page-supplied stamp is overwritten (tests). A later audit with other options never closes a pin.
- Rule-level skip guard for fixed: a pin is not fixed if the rule reported skipped elements (`stats.skipped[rule]`; the contrast rule skips blend/overlap/image cases). Gone is still allowed in that case (a missing signature needs no measurement).
- Desktop: `Row` takes the verdict (`open|fixed|gone|dismissed`) plus an independent `notRechecked` tag and an independent `lost` ("can't locate") tag; new Gone section; summary line shows fixed / gone / not rechecked counts from the same delta that feeds the receipt; receipt comes from `delta.receipt` (identical Python/JS text). `formatFixReceipt` (a third, divergent formatter) was deleted.
- `_tools.py` descriptions name fixed / gone / not_rechecked and the limits; `pinpoint_pins` lists `gone` pins.
- Docs: README, SPEC, `docs/delta-semantics.md` (replaced, one definition), `plugin.yaml`, `plugin-catalog/pinpoint.yaml` (description + precise disclosure). The "same element was measured again and now passes" claim is deleted everywhere.

## Truth table as implemented (first match wins; from docs/delta-semantics.md)

| # | Evidence | Outcome |
|---|---|---|
| 0 | Report invalid: findings not a list, or a finding without a non-blank string `id` | Rejected; nothing changes, no delta |
| 1 | Pin was dismissed | Stays dismissed |
| 2 | Pin id is reported again | Open (a fixed/gone pin that returns is reopened) |
| 3 | Rule coverage missing/malformed (only the engine's `rules_covered` counts), rule not covered, or rule has an error | not rechecked |
| 4 | Engine error, truncation, or any non-empty `limits`; malformed `errors`/`limits` | not rechecked |
| 5 | Audit options (`audit_options`: contrast level, tap advisory) missing or different from those of the earlier finding | not rechecked |
| 6 | `presentAnchors` missing, malformed, or `presentComplete` not `true` (an inventory over 2500 elements is incomplete) | not rechecked |
| 7 | Pin has no signature, or its signature occurs more than once | not rechecked |
| 8 | Signature count 0 | **gone** |
| 9 | Signature count 1 and the rule reports skipped elements (`stats.skipped[rule]`), or `stats.skipped` is malformed | not rechecked |
| 10 | Signature count 1 | **fixed** |

## Deviation from the R3 spec (read this)

Spec 4.2 asked for per-target re-measurement (`recheckTargets` / `recheckedAnchors`). That was not built (card instruction). The engine does ship a complete presence inventory (`presentAnchors`, `presentComplete`, up to 2500 elements), so `fixed` is granted on: rule covered + no engine error / truncation / limit + same audit options + signature present exactly once + no skips reported for that rule. That is presence-plus-coverage evidence, not a measurement of the old element. The docs and receipts say so ("NOT re-measured"); nothing claims "same element measured again". If the coordinator wants the strict spec reading (no `fixed` at all without recheck evidence), flip row 10 to `not_rechecked` in `classify_absent` and `classifyAbsent` and regenerate the fixture expectations; the machinery is otherwise unchanged.

## Known limitations

- `fixed` can still be wrong in cases the engine does not report as skips (an element hidden or not applicable to a rule, a changed state that stops the check from applying). Skips are guarded per rule, not per element.
- Page inventories over 2500 elements are incomplete, so nothing on such pages becomes fixed or gone.
- Signatures are tag + stable attribute + ancestor path; a renamed or moved element shows as gone, identical siblings as not rechecked.
- Pins stored before this change carry no `audit_sig`; they stay open (not rechecked) until they are reported again.
- Audit option comparison covers contrast level and tap advisory only.
- Fixed and gone rows are shown for the latest re-audit only; durable history is the stored pin status (`pinpoint_pins`), not a pane list. Retention is bounded (20 pages, 200 pins, 50 audits, 7 days) and expiry is not a verdict.
- The shared fixture runs through the Python store and `localDelta`. REST `/audit` and the agent tool are covered by existing and updated pytest cases (`test_api.py`, `test_tools.py`), not by every fixture row. The rendered pane is covered by a `vm` harness that walks the real `resultView` element tree (`audit-state.test.mjs`), not a real Desktop. Not covered by the fixture: page or route change (a different URL key is a separate history, so it has no delta), reopening a fixed/gone pin, retention expiry.
- `test_validate.py::test_validate_full_tree_passes_and_leaves_tree_untouched` failed once in a full run right after `_tools.py` was edited (tree digest changed during the run, most likely a `__pycache__` write by the validator process) and passed on re-run; the final run above is green.
- Only Windows 11 / Hermes 0.22.7 behaviour was ever observed; macOS and Linux are untested. fixed/gone are this engine's limited evidence, not WCAG certification.
- Out of scope here and unchanged: the security gate items of spec section 5 beyond the already-committed forged-event fix, hygiene beyond `scripts/hygiene.sh`, and the catalog pin/image SHA (`717ad0a`), which the coordinator must replace after QA.
