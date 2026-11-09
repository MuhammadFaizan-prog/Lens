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
- `apps/editor/` live editor (React + TypeScript + Vite; the UI Tauri will wrap): Canvas2D preview
  driven by the render plan, transport, timeline, inspector, transcript editing, export. See
  `docs/Editor.md`.
- `compositor/` Python reference compositor: render plan + screen recording → MP4; `pipeline.py`
  runs transcription → plan → render in one go.
- `transcribe/` on-device speech-to-text (`lens-transcribe`): faster-whisper base.en (MIT) on the
  CPU, word timings aligned to measured pauses, filler and pause detection. See `docs/STT.md`.
- `redact/` on-device privacy scan (`lens-redact`): Tesseract OCR on sampled frames, classifiers for
  emails, phones, cards, API keys, JWTs, tokens, IPs and notification banners, frame-by-frame box
  tracking into timed masks. See `docs/Privacy.md`. `lens-redact steps` drafts step labels from
  clicks + OCR (`docs/Annotations.md`).
- `research/harness/` measurement harness: recovers padding, corner radius, shadow, zoom spring
  curves, lead/hold, cursor smoothing, loudness from any export; blind A/B pair builder.
- `research/bars/` reference exports from the products we match (not committed if licensed).
- `tests/` harness + compositor tests, including an end-to-end recovery test.

## Run
```bash
npm install && npm run build && npm test        # engine + editor: typecheck, build, vitest
pip install opencv-python-headless numpy scipy pillow pytest faster-whisper
sudo apt install espeak-ng tesseract-ocr        # test-only: synthetic speech + caption OCR
python3 -m pytest                               # harness + compositor + STT + end-to-end
```

## Editor
```bash
npm install && npm run build
npm run dev -w apps/editor        # http://localhost:5178 with the synthetic sample bundle
LENS_BUNDLE=/path/to/bundle npm run dev -w apps/editor
npm run e2e -w apps/editor        # Playwright (needs Chromium: npx playwright install chromium)
```
Space play/pause · J/K/L shuttle · ←/→ one frame (Shift: 10) · ⌘/Ctrl-Z undo, ⇧⌘Z redo ·
Del deletes the selected block or transcript words. Export calls `compositor/render.py` through the
dev server and shows its progress.

## Render
```bash
node packages/engine/dist/cli.js --meta meta.json --events events.jsonl --project project.json \
  [--words words.json] --out plan.json
python3 compositor/render.py --plan plan.json --screen screen.mp4 [--camera cam.mp4] --out final.mp4
python3 compositor/render.py --plan plan.json --screen screen.mp4 --out final.gif   # GIF export
python3 research/harness/demo_p1.py      # out/demo-p1.mp4 + contact sheet, every P1 feature on

# speech-to-text: transcript JSON for --words, or let the pipeline transcribe the mic track
transcribe/lens-transcribe mic.wav -o transcript.json [--offset-ms 400]
python3 compositor/pipeline.py --meta meta.json --events events.jsonl --project project.json \
  --screen screen.mp4 --out final.mp4   # transcribes when captions / edits.cleanup need words

# step labels: draft "Click Save"-style labels from the clicks, accept them all as numbered badges
redact/lens-redact steps screen.mp4 --events events.jsonl -o steps.json
node packages/engine/dist/cli.js --meta meta.json --events events.jsonl --project project.json \
  --step-labels steps.json --accept-steps --out plan.json

# privacy: find sensitive text, then hide everything found (or review it in the editor's Privacy panel)
redact/lens-redact screen.mp4 --events events.jsonl -o privacy.json --thumbs thumbs/
node packages/engine/dist/cli.js --meta meta.json --events events.jsonl --project project.json \
  --privacy-scan privacy.json --accept-privacy --project-out redacted.project.json --out plan.json
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
  "edits": {"cleanup": {"enabled": true, "removeFillers": true, "shortenPauses": true, "maxPauseMs": 900, "keepPauseMs": 350},
            "takes": {"enabled": true, "strategy": "last"}},
  "transcription": {"mode": "auto", "track": "mic", "model": "base.en"},
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
mirror/crop/zoomed size, styled captions with word highlight, and per-segment overrides. Local
speech-to-text turns the mic track into word timings, so captions and filler/pause removal run on
real audio (tested on synthetic espeak speech only). The live editor (`apps/editor`) previews the
plan in the browser at parity with the reference compositor (SSIM-tested), with a timeline,
inspector, transcript editing, Calm/Default/Punchy zoom presets with a zoom budget, and export.
Multi-take: retakes are found in the transcript and the last (or best) take is kept, with an Alt
takes lane to swap or A/B-preview takes (`edits.takes`, see `docs/Takes.md`).
Privacy redaction: an on-device scan finds emails, phone and card numbers, API keys, tokens, JWTs,
IPs and notification banners, follows them through scrolls and zooms, and offers them for review in
the editor's Privacy panel; accepted ones become tracked blur masks (`privacy`, see `docs/Privacy.md`).
Annotations: text, arrows, box / ellipse highlights, numbered step badges and callouts with fade /
pop / draw-on / typewriter animations, anchored to the screen (they follow zooms) or the frame, plus
full-frame text slides; auto step labels drafted from clicks + local OCR and reviewed in the editor's
Steps panel (`annotations`, `slides`, `stepLabels`, see `docs/Annotations.md`).
Native capture (ScreenCaptureKit / Windows Graphics Capture / WASAPI), the Tauri app shell, and the
GPU renderer are not built yet. No parity bars recorded yet. See `docs/Tracker.md`.
