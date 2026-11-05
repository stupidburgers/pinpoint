# Decisions log

## D3 - Browser pane + preview consent in the isolated rig (measured 2026-11-04, Hermes Desktop 2026.7363.3271.0)

Result: **automatable end to end over CDP**, no seeding of a grant store needed. Implemented in `demo/rig/rig.py` (`open-site`, `consent`).

| Step | Method (all against the rig's own window on port 9444) | Evidence |
|---|---|---|
| Open the Browser pane | `Input.dispatchKeyEvent` Ctrl+Shift+L (palette entry "Toggle browser"). Ctrl+L alone does nothing on the empty session. | pane with `input[aria-label=Address]` and a `<webview>` appeared |
| First-run dialog "Stay signed in to your sites" | click the button whose text is `Don't show again`. NEVER `Use my profile` (copies the user's cookies into the rig). | dialog gone |
| Navigate | focus + select `input[aria-label=Address]`, `Input.insertText` the URL, Enter. `http://127.0.0.1:8765/` loads with no private-URL block. | Lumen rendered in the pane |
| Consent | the first `ctx.preview.executeJavaScript` opens an ordinary DOM dialog `[data-testid="plugin-preview-consent"]` ("Let Pinpoint run scripts on this page?", buttons `Don't allow` / `Allow on this site`); click `Allow on this site`. | `desktop.log`: `[pinpoint] audit ok {"source":"user","score":100,"findings":0,...}` right after the click |

Notes and limits (honest):
* The Browser pane is narrow in the default layout (about 420 CSS px), so the page renders in its mobile layout: `.nav` is hidden below 880 px and flaw 12 (focus indicator on `.nav a`) is not rendered there. For the video widen the pane or hide the sidebars; `flaws.json` ground truth is for a 1280 px viewport (the playwright truth test).
* Grant persistence across rig restarts was not measured; the E2E fixture re-clicks the dialog when it appears.
* The first measurement ran against Package C's work-in-progress desktop half with a skeleton engine, so "findings 0" says nothing about the final engine.
* Not measured: whether the dialog text/testid is stable in other Desktop builds.
