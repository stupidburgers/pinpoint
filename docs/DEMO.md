# D6 - 90 s demo video shot list

Result depends on B8 (precision gate). **This file has the shot list and the exact rig commands; the video itself is pending until the finished pin/score UX (landing of engine stubs -> green pins, pinch) exists and Package E has screenshots.** Record two takes, pick the better. Fixture-based, offline (fake LLM + local site), no network calls. 90 s hard ceiling, captions burned in with the tool of your choice (ffmpeg -vf drawtext, or OBS text sources; e.g. `ffmpeg -i in.mp4 -vf "drawtext=text='...':x=40:y=H-120:fontsize=36:fontcolor=white:box=1:boxcolor=black@0.6"`).

The star of the video is the finished frame: **pins turn green and the score rises** — burn that caption in BEFORE recording the rest.

## Setup (one command)
```
python demo/rig/rig.py start          # fresh rig, fake LLM on 8799, Lumen site on 8765
python demo/rig/rig.py open-site      # Browser pane on http://127.0.0.1:8765/, answers the consent dialog when asked
```
Practice the flow once (sections below are spoken/acted, never typed live). For the wide-viewport look (bug 12: `.nav a` focus ring, needed by flaws 12): widen the Desktop window so the Browser pane is >= 920 px, or accept that pins for that rule don't appear (pin count 22 -> still rich).

## Shots

| # | T | Screen | Action | Burn-in caption |
|---|---|--------|--------|-----------------|
| 1 | 0:00-0:05 | The Lumen page with pins already drawn (post-intro audit you just ran) | hold still | `Pinpoint: pins on your live page` |
| 2 | 0:05-0:20 | Composer in the rig | type `audit my page` -> Enter (fake LLM calls `pinpoint_audit` via the real tool path; result returns; the Pinpoint pane fills) | `The agent measures the page itself` |
| 3 | 0:20-0:60 | Page with pins | click pin #1 -> the card -> "Fix with Hermes" -> the agent's patch lands -> SSE reload -> the pin turns green and fades; score caption from before/after audits (take the two values from `desktop.log` `audit ok` lines, e.g. `13 -> 33`) | `<score first audit> -> <score after fix>` |
| 4 | 0:60-0:80 | Chip in the status bar / palette "Pinpoint: validate" (or the same pane) | run validate; show the disclosure line from SPEC 10 (verbatim): | `Reads this page with your consent, says so out loud. Fix suggestions stay yours.` |
| 5 | 0:80-0:90 | README end card | end frame | `hermes plugins install pinpoint  @NousResearch` |

Disclosure frame text (use SPEC 10's block, verbatim - do not paraphrase).

## Rig commands handy while recording
```
python demo/rig/rig.py shot take1.png        # grab a frame (CDP screenshot of the app window)
python demo/rig/rig.py reset-site            # restore pristine Lumen between takes (the agent really patches the files!)
python demo/rig/rig.py stop                  # kills ONLY the rig's processes
```
Record with OBS/Clipchamp at 1080p windowed; the rig window is a separate visible window.

## Facts the captions must respect (measured, do not overclaim)
* Audit, pins, pin click -> composer text, scripted fix -> re-audit: all work end-to-end in the rig as of 2026-11-04 (tests/e2e/test_loop.py 6/6).
* The fix turns on AFTER the reload; the agent applies the patch through the regular `patch` tool, with the host's approval flow (the first patch call took about a minute in an unattended rig; on camera, pre-approve the rig's write approval or shoot the click).
* The tool result to the model is capped at 12 000 chars, so on Lumen (22 findings) the two last low-severity rows are what the page audit knows but the model reply saw 20 - do not claim the model counted all of them.
* Mobile/narrow panes skip the `.nav` focus-ring flaw (media query hides nav below 880 px).
