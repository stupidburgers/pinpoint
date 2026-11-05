# Desktop half: rig facts measured by Package C (Hermes Desktop 2026.7363.3271.0, agent 0.22.7, Windows 11)

Rig: `RIG=C:/Users/Lucas/AppData/Local/pinpoint-rig-c`, CDP port 9445, fake LLM on 8798, static site on 8791.
Helpers: `tests/build/rig_cdp.py` (`eval`, `shot`, `prepare`, `send`, `palette`, `browse`, `click_text`). Screenshots: `tests/build/evidence-c/`.

| Fact | Evidence |
|---|---|
| Desktop plugin loads from `home/desktop-plugins/pinpoint/plugin.js` (Electron copies it from `home/plugins/pinpoint/desktop/` at start). A renderer `location.reload()` re-reads it. | register log lines |
| The four palette commands appear under Ctrl+K "Pinpoint". | screenshot in session |
| **Opening the pane:** the `PANES_AREA` pane is NOT shown by default and the layout editor only lists it in "Advanced" mode. The top-right button `aria-label="Show right sidebar"` opens the right zone and shows the Pinpoint pane. | `01-pane-pins-desktop-only.png` |
| Browser pane: Ctrl+Shift+L; first use shows "Stay signed in to your sites" (never click "Use my profile"; click "Don't show again"). Address input: `input[placeholder="Enter address"]`; type + Enter navigates (also acts as reload). | `rig_cdp.browse` |
| First `executeJavaScript` on an origin raises the host dialog "Let Pinpoint run scripts on this page?" with `Don't allow` / `Allow on this site`; while it is open the awaited call stays pending (the pane shows the spinner). | `02-consent-dialog-expected.png` |
| **Deny path (new in this build):** after `Don't allow` the next call rejects, the pane shows "Permission denied" (`consent_denied`). | `05-consent-denied.png` |
| Host rejection text for non-web pages is `Preview scripts run only on a web page (http or https).` -> `origin_blocked`. | desktop.log `adopt failed ...` |
| A poll tick on a NEW origin (user navigated 127.0.0.1 -> localhost while pins were active) raises the consent dialog on its own. Page origin cannot be known without executing script, so this is unavoidable with polling; denial stops polling. | `05` + log |
| `ctx.rest('/health')` on a missing python half rejects with `404: {"detail":"Plugin not found"}`; a half-broken plugin gives `500`. Both -> desktop-only mode. | desktop.log |
| Agent round trip: `audit.request` -> ack -> audit -> `/result` -> tool result in the model's context; "Pinpoint Audit 7 items" shows in the transcript. | `04-agent-round-trip.png`, fake-LLM jsonl |
| Pin click inside the page (real mouse click via CDP) -> next poll -> `host.composer.submit` -> the fake LLM received the prompt. | log `fix pin` |
| Reload of the page: engine missing -> re-inject -> wait ready + 600 ms quiet -> auto re-audit -> delta +8, green pin, toast. | `03-reaudit-delta-green-pin-toast.png` |
| Hot reload (renderer reload with pins on the page): `adopt: engine present` -> re-audit re-draws pins. | desktop.log |
| Rig gotcha: `taskkill //PID` does not work from this git-bash (MSYS conversion disabled): use `taskkill /PID` or PowerShell `Stop-Process`. Python tools need a gateway restart; the desktop JS only needs a renderer reload. | |

Run the unit tests: `node --test tests/build/bridge.test.mjs`; the build tests: `python -m pytest tests/build -q`.
Build for the rig with the stand-in engine: `node scripts/build-desktop.mjs --engine tests/build/stub-engine.js --out $RIG/home/desktop-plugins/pinpoint/plugin.js`.
