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

## Render
```bash
node packages/engine/dist/cli.js --meta meta.json --events events.jsonl --project project.json \
  [--words words.json] --out plan.json
python3 compositor/render.py --plan plan.json --screen screen.mp4 [--camera cam.mp4] --out final.mp4
python3 compositor/render.py --plan plan.json --screen screen.mp4 --out final.gif   # GIF export
python3 research/harness/demo_p1.py      # out/demo-p1.mp4 + contact sheet, every P1 feature on
```
Audio, crop, masks, overrides and caption style live in `project.json`, for example:
```json
{
  "crop": {"x": 0, "y": 0, "w": 1600, "h": 900},
  "audio": {
    "tracks": [{"id": "mic", "kind": "mic", "path": "mic.wav", "offsetMs": 0, "volume": 1, "muted": false}],
    "noiseReduction": {"enabled": true, "amountDb": 12},
    "loudness": {"enabled": true, "targetLufs": -16, "truePeakDb": -1.5, "lra": 11}
  },
  "cursor": {"clickSound": true, "clickSoundVolume": 0.5},
  "masks": [{"id": "pw", "kind": "blur", "rect": {"x": 300, "y": 200, "w": 400, "h": 60},
             "startMs": 0, "endMs": 4000, "feather": 8, "fadeMs": 200, "strength": 12}],
  "overrides": [{"startMs": 5000, "endMs": 7000, "cursor": {"hidden": true}, "volume": 0.5}],
  "camera": {"enabled": true, "mirror": true, "crop": {"x": 160, "y": 0, "w": 960, "h": 720}, "zoomedSize": 0.6},
  "captions": {"enabled": true, "wordHighlight": true,
               "style": {"fontSize": 44, "position": "bottom", "maxWordsPerLine": 5, "highlightColor": "#ffd23f"}},
  "export": {"gif": {"fps": 15, "width": 640, "loop": true}}
}
```
Relative audio paths resolve against the plan file's folder. Mask strength means dim amount
(spotlight, 0..1), blur sigma or pixel block size in source px. Mask rects, crop and override
times are in source pixels / recording time.

## Status
Engine, reference compositor, and harness work and are tested on synthetic sessions, including the
P1 set: audio mux with edits, denoise + loudness, click sounds, GIF, crop, masks, webcam
mirror/crop/zoomed size, styled captions with word highlight, and per-segment overrides. Native capture
(ScreenCaptureKit / Windows Graphics Capture / WASAPI), the Tauri app shell, and the GPU renderer
are not built yet. No parity bars recorded yet. See `docs/Tracker.md`.
