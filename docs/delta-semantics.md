# Audit delta semantics

One definition, implemented identically in `_store.py` (Python store, REST `/audit`, agent tool) and `desktop/src/bridge.js` `localDelta` (Desktop-only mode). Both are driven by the shared cases in `tests/shared/delta_cases.json`.

## What the words mean

- **fixed**: an earlier open pin is no longer reported, the later audit is comparable, and an element with the pin's signature is still on the page exactly once. This is evidence from this limited engine. Pinpoint does **not** re-measure that element (the engine has no per-target recheck), so fixed does not prove the element now passes; skipped elements are guarded only at rule level (see below).
- **gone**: comparable audit, complete element inventory, and the pin's signature is absent. Removal, rename and move look the same, so gone is never a fix claim.
- **not rechecked**: Pinpoint cannot establish either verdict. The pin stays `open`; its id is listed in `delta.not_rechecked` (alias `delta.unresolved`). It is an audit outcome, not a stored status.
- **can't locate** (Desktop pane tag): the overlay could not find the element again. It is independent of the verdict and never changes it.
- **new / remaining**: new = first time seen on this page; remaining = earlier open pins reported again. Dismissed pins stay dismissed.

## Decision order (first match wins), per earlier open pin that the new audit does not report

| # | Evidence | Outcome |
|---|---|---|
| 0 | Report invalid: findings not a list, or a finding without a non-blank string `id` | Rejected; nothing changes, no delta |
| 1 | Pin was dismissed | Stays dismissed |
| 2 | Pin id is reported again | Open (a fixed/gone pin that returns is reopened) |
| 3 | Rule coverage missing/malformed (`rules_covered` or legacy `stats.checked`), rule not covered, or rule has an error | not rechecked |
| 4 | Engine error, truncation, or any non-empty `limits`; malformed `errors`/`limits` | not rechecked |
| 5 | Audit options (`audit_options`: contrast level, tap advisory) missing or different from those of the earlier finding | not rechecked |
| 6 | `presentAnchors` missing, malformed, or `presentComplete` not `true` (an inventory over 2500 elements is incomplete) | not rechecked |
| 7 | Pin has no signature, or its signature occurs more than once | not rechecked |
| 8 | Signature count 0 | **gone** |
| 9 | Signature count 1 and the rule reports skipped elements (`stats.skipped[rule]`), or `stats.skipped` is malformed | not rechecked |
| 10 | Signature count 1 | **fixed** |

Requested `rules` and the rules of returned findings never count as coverage. An explicitly supplied invalid `rules_covered` is not repaired by falling back to `stats.checked`. Old rows need no migration: a pin's rule comes from the finding or from its id prefix; pins stored before `audit_options` existed are never closed.

## Limits you should know

- Fixed/gone are this engine's observations, not WCAG certification and not a guarantee about your page.
- Signatures are tag + stable attributes + ancestor path; a changed signature looks like gone, two identical elements look ambiguous.
- Skips are guarded per rule, not per element.
- Retention is bounded: 20 pages, 200 pins and 50 audits per page, 7 days. Expiry removes history; it is never reported as fixed or gone.
- Tool responses are sliced after persistence; engine truncation happens before it and blocks absence-based verdicts.
- Desktop-only state keeps not-rechecked pins in memory, local storage, overlay input and the open list. They are kept separate from the latest result's findings, so the score and counts describe only what actually ran.
