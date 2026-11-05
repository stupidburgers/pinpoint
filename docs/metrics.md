# Pinpoint engine - labeled-set metrics

Corpus: `tests/engine/labeled/` (16 HTML pages, **130 labeled elements**), Chromium 156.0.8078.4.
Labels are hand-written (`bad-*` = must be flagged, `ok-*` = must not) for each rule; the rule set is ours.
Run: `env -u PYTHONPATH python -m pytest tests/engine/test_metrics.py` regenerates this file.
Audit options: defaults except `tapAdvisory: 0` (advisory sizes off).

| rule | TP | FP | TN | FN | precision | recall |
|---|---|---|---|---|---|---|
| a11y.contrast | 8 | 0 | 9 | 0 | 1.00 | 1.00 |
| a11y.control-name | 7 | 0 | 6 | 0 | 1.00 | 1.00 |
| a11y.focus-indicator | 4 | 0 | 4 | 0 | 1.00 | 1.00 |
| a11y.form-label | 6 | 0 | 5 | 0 | 1.00 | 1.00 |
| a11y.heading-order | 4 | 0 | 20 | 0 | 1.00 | 1.00 |
| a11y.img-alt | 2 | 0 | 1 | 0 | 1.00 | 1.00 |
| a11y.lang | 1 | 0 | 1 | 0 | 1.00 | 1.00 |
| a11y.page-title | 1 | 0 | 1 | 0 | 1.00 | 1.00 |
| a11y.tap-target | 7 | 0 | 14 | 0 | 1.00 | 1.00 |
| a11y.viewport-zoom | 1 | 0 | 1 | 0 | 1.00 | 1.00 |
| layout.h-overflow | 4 | 0 | 4 | 0 | 1.00 | 1.00 |
| spacing.tight-targets | 2 | 0 | 2 | 0 | 1.00 | 1.00 |
| type.line-height | 3 | 0 | 3 | 0 | 1.00 | 1.00 |
| type.text-small | 5 | 0 | 4 | 0 | 1.00 | 1.00 |
| **all** | 55 | 0 | 75 | 0 | 1.00 | 1.00 |

Notes:
- Contrast skips (background images/gradients/pages with overlapping layers) are reported in `limits`, never guessed: those elements are labeled `ok` so they must stay silent.
- `a11y.focus-indicator` is a static CSSOM heuristic (confidence medium) - it cannot see runtime focus handlers by design.
- Page-level rules (lang/title/viewport) have one labeled element per tiny page.
- Acceptance gates: precision >= 0.95 and recall >= 0.90 per rule on this set.
