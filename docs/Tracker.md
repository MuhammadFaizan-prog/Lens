# Tracker

| Area | State | Evidence |
|---|---|---|
| Engine: cursor smoothing, idle hide, click effects | done | vitest |
| Engine: auto-zoom (clicks, typing), manual zoom, follow, smart framing | done | vitest + e2e |
| Engine: cuts, speed ranges, transcript edits, captions, SRT | done | vitest |
| Engine: camera layouts + transitions | done | vitest |
| Reference compositor (background, padding, radius, shadow, blur, ripple, captions, webcam) | done | e2e |
| Measurement harness + blind A/B | done | pytest e2e recovers engine settings |
| Audio in export: mic + system tracks (path, offset, volume, mute) muxed as AAC, following cuts (trim) and speed ranges (atempo), 3 ms fades at cuts (AUD-04/06) | done | vitest (plan pieces tile output); pytest `test_audio_mux_follows_cuts_and_speed`: beeps measured at expected output times ±1 frame, video/audio durations, muted track absent from spectrum |
| Audio cleanup: afftdn denoise (noise floor measured from quiet windows) + two-pass loudnorm, default -16 LUFS / -1.5 dBTP (AUD-01/03) | done | pytest: integrated loudness within ±1 LU of -16 and -23 targets (ebur128); noise floor drops >8 dB with speech level kept within 3 dB |
| Click sounds: procedural click (damped partials + noise transient, our own waveform), mixed at each surviving click's output time, volume (CUR-08) | done | vitest (times through cuts/speed); pytest: onsets at plan times ±1 frame, volume 0.5x measured as -6 dB ±1, deterministic synth |
| GIF export: palettegen (stats_mode=diff) + paletteuse (sierra2_4a), fps / width / loop (EXP-04) | done | pytest: frame count, 320x180, duration, NETSCAPE loop block present/absent |
| Crop: source crop rect; engine runs in cropped space (camera clamp, auto-zoom ignores clicks outside, cursor + click effects hidden outside), compositor slices before the camera (LOOK-14) | done | vitest (coordinate mapping, clamp, focus translation, aspect); pytest: rendered screen correlates >0.97 with the reference crop; cursor pixels vanish once it leaves the crop |
| Masks: timed spotlight / blur / pixelate rects in source px with feather + fade, mapped through the camera so they follow zooms (TXT-04/05) | done | vitest (fade, defaults, cropped coords); pytest: blur Laplacian variance <25% of baseline, pixelate block flatness, spotlight dims outside to 40% ±5% with inside untouched, mask grows and stays applied at 2x zoom, pixels outside unchanged |
| Webcam: mirror, crop rect, size multiplier while zoomed (spring-animated, corner anchored) (CAM-04/05/06) | done | vitest (shrink curve, anchoring, smoothness, split untouched); pytest: colour bands prove crop + mirror, zoomed area 36% ±6% of unzoomed, anchored bottom-right |
| Caption styling: font size, text/highlight colours, background pill, top/bottom/custom position, max words per line, word-by-word highlight from word timings (AI-03) | done | vitest (active word index at times, wrapping, edit-aware); pytest: highlight colour walks word to word and onto line 2, caption in top band, pill present, no highlight when off |
| Per-segment overrides: cursor hide / smoothing off / size, audio volume (CUR-01, EDT-05/06) | done | vitest (fade, raw path with blended edges, size ramp, validation); pytest: hidden range has no cursor pixels, size 3 vs 1.5 gives ~4x area, smoothing-off offset matches plan, volume 0.25 measured as -12 dB ±1 |
| P1 demo (all of the above together) | done | `python3 research/harness/demo_p1.py` -> `out/demo-p1.mp4` + `out/demo-p1-sheet.png` (not committed) |
| Bars from Screen Studio / FocuSee | not started | needs exports from licensed copies |
| Native capture macOS / Windows | not started | can't run in Linux CI |
| Tauri app shell + editor UI | not started | |
| GPU renderer (wgpu) | not started | |

Cursor smoothing default: engine uses 220 ms spring settle after a One Euro prefilter. The harness's
single-spring fit reads ~140 ms on our own output because the prefilter and lookahead are folded in;
the fitter is used only to compare Lens against a bar under the same model, not as a ground truth.

Cursor tracker and click ripples: the ripple is a white overlay, so it only brightens; the tracker now
searches the darkening-only diff first (the cursor's dark fill) and falls back to the absolute diff
only when nothing is found there. This removed the ~3 px anchor shift after clicks: the e2e cursor
test's 95th-percentile error had been 8.9-9.2 px (over the 8 px bound) on the previous commit in this
environment (OpenCV 4.14 and 5.0, ffmpeg 7.1).

Still not built from the P1 list (needs native code or models): native mic/system/webcam capture
(REC-08/09/10), local speech-to-text (AI-01), person segmentation for the cutout (CAM-07). The audio
pipeline takes audio files; captions take word timings as input.
