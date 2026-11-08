# Tracker

| Area | State | Evidence |
|---|---|---|
| Engine: cursor smoothing, idle hide, click effects | done | vitest |
| Engine: auto-zoom (clicks, typing), manual zoom, follow, smart framing | done | vitest + e2e |
| Engine: cuts, speed ranges, transcript edits, captions, SRT | done | vitest |
| Engine: camera layouts + transitions | done | vitest |
| Reference compositor (background, padding, radius, shadow, blur, ripple, captions, webcam) | done | e2e |
| Measurement harness + blind A/B | done | pytest e2e recovers engine settings |
| Bars from Screen Studio / FocuSee | not started | needs exports from licensed copies |
| Native capture macOS / Windows | not started | can't run in Linux CI |
| Tauri app shell + editor UI | not started | |
| GPU renderer (wgpu) | not started | |

Cursor smoothing default: engine uses 220 ms spring settle after a One Euro prefilter. The harness's
single-spring fit reads ~140 ms on our own output because the prefilter and lookahead are folded in;
the fitter is used only to compare Lens against a bar under the same model, not as a ground truth.

Known harness limit: the cursor tracker's blob anchor shifts ~3 px while a click ripple overlaps the
sprite (about 0.7 s after each click). Settled-frame median error is under 1 px; fix by masking the
ripple ring before blob extraction (todo).
