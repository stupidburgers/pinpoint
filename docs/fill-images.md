# Placeholders to replace before freeze

Nothing in the README is allowed to be invented. Until the real files exist, the README links to missing images and carries `<!-- FILL:... -->` markers. `scripts/freeze.sh` refuses to run while any marker remains or any file below is missing at the pinned commit.

| Marker in README | File to add | Spec | Source |
|---|---|---|---|
| `FILL:banner` | `docs/banner.png` | 1200x600 (2:1), PNG, < 500 KB | Composite of the demo site with pins, from Package D capture |
| `FILL:screenshots` | `docs/screenshots/01-pins.png` | Lumen demo page in the Browser pane, pins visible | Package D / real Desktop |
| | `docs/screenshots/02-pin-card.png` | pin card open: rule, measured values, Fix with Hermes | Package D |
| | `docs/screenshots/03-after-fix.png` | same page after the fix: green pins, score delta chip | Package D |
| `FILL:metrics` | paste table from `docs/metrics.md` | only numbers that file contains | Package B (`tests/engine/labeled`) |
| `FILL:not-verified` | edit the "Not verified yet" list | remove items that e2e/manual runs actually verified; add new ones | Package I results, `docs/DEMO.md` |

Steps

1. Drop the PNGs in place (real captures only, no mock-ups). Keep the names: `plugin-catalog/pinpoint.yaml` already points at them.
2. Delete each `<!-- FILL:... -->` comment line once its content is real.
3. If you add or rename a screenshot, update both README and the `screenshots:` list in `plugin-catalog/pinpoint.yaml` (max 6, GitHub-hosted).
4. Commit and push, then run `bash scripts/freeze.sh`.
