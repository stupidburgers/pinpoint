# Submission checklist

Deadline: **2026-11-11 17:00 EST (19:00 BRT)**. Freeze: **Nov 10**. Do the steps in order.

## 1. Freeze (Nov 10)
- [ ] All packages merged to `main`; CI green on ubuntu and windows.
- [ ] `docs/fill-images.md` done: real banner, 3 screenshots, metrics pasted, "Not verified yet" list reflects the real runs.
- [ ] `bash scripts/freeze.sh` exits 0. It checks: clean tree equal to `origin/main`, no `FILL:` markers, image files exist at the SHA, hygiene scan, pytest, `build-desktop.mjs --check`, `hermes plugins validate` prints `Validation passed.`, then rewrites `plugin-catalog/pinpoint.yaml` (sha, version, image URLs).
- [ ] Commit and push the rewritten yaml (the pinned SHA is the commit before it).
- [ ] Fresh clone check at the pinned SHA, with an isolated `HERMES_HOME`:
  `git clone https://github.com/stupidburgers/pinpoint && cd pinpoint && git checkout <SHA> && hermes plugins validate .` -> `Validation passed.`, zero `✗`, no private-import warning.
- [ ] Open the three raw image URLs from the yaml in a browser (they only resolve once the commit is pushed).

## 2. Rules self-check (catalog rules 1-18)
- [ ] 2 exact 40-hex SHA, 3 no self-updater, 6 capabilities match registrations (tools `pinpoint_audit`, `pinpoint_pins`; no hooks), 8 desktop SDK only (validate `desktop surface` clean), 9 no core override, 12 timeouts under cron (`desktop_unavailable`), 13 disclosure in PR and README, 14 `requires_hermes: ">=0.22.7"` SemVer, matches `plugin.yaml`, 17 no bytecode/binaries.
- [ ] Rule 5: submitter is the repo owner (stupidburgers).
- [ ] Rule 10: no `python_dependencies`; nothing to quarantine.

## 3. Catalog PR to NousResearch/hermes-agent
- [x] PR opened: https://github.com/NousResearch/hermes-agent/pull/149426
- [x] Fork, branch `catalog/pinpoint`, add only `plugin-catalog/pinpoint.yaml`.
- [ ] PR title: `Add pinpoint to the plugin catalog`.
- [ ] PR body: one paragraph on what it does, the SHA and version, the **Disclosure** paragraph verbatim from the README, the validate output, link to the README at the SHA.
- [ ] First comment titled "What is not verified": paste the README's "Not verified yet" list as it stands at the SHA. Do not claim more than it says.
- [ ] Reviewer warnings (`caution` scan findings) are answered in the thread, not ignored.

## 4. Announce and enter
- [ ] X post, video under 90 s (demo: audit, pins, Fix with Hermes, green pins and score delta), tag @NousResearch, link the repo.
- [ ] Typeform: https://form.typeform.com/to/FwJLvOln (repo, PR link, X post link, short description).
- [ ] Do not push to `main` after the pin without a new freeze (a changed SHA means a new catalog yaml).
