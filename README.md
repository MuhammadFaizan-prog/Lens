# Lens

A screen recorder that turns raw recordings into polished demo videos: auto-zoom on clicks and
typing, smooth cursor, backgrounds, shadows, rounded frames, motion blur, webcam layouts,
transcript-based editing, captions, and shortcut overlays. Target: output parity with Screen Studio
and FocuSee, judged by blind A/B comparison of exports of the same scripted session.

## Clean-room rule
Lens is built from scratch. We never decompile, disassemble, patch, or copy code, UI, icons, cursor
art, fonts, or copy from Screen Studio, FocuSee, or any other proprietary product. Behaviour is
learned only from public documentation and from measuring exported videos frame by frame.
See `docs/Rules.md`.

## Layout
- `packages/engine/` TypeScript engine: events → cursor track, auto-zoom, camera, timeline,
  transcript editing, layouts → per-frame render plan (`lens-plan` CLI).
- `compositor/` Python reference compositor: render plan + screen recording → MP4.
- `research/harness/` measurement harness: recovers padding, corner radius, shadow, zoom spring
  curves, lead/hold, cursor smoothing, loudness from any export; blind A/B pair builder.
- `research/bars/` reference exports from the products we match (not committed if licensed).
- `tests/` harness + compositor tests, including an end-to-end recovery test.

## Run
```bash
npm install && npm run build && npm test        # engine: typecheck + vitest
pip install opencv-python-headless numpy scipy pillow pytest
python3 -m pytest                               # harness + compositor + end-to-end
```

## Status
Engine, reference compositor, and harness work and are tested on synthetic sessions. Native capture
(ScreenCaptureKit / Windows Graphics Capture / WASAPI), the Tauri app shell, and the GPU renderer
are not built yet. No parity bars recorded yet. See `docs/Tracker.md`.
