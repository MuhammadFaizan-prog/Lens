# Lens live editor (`apps/editor`)

React + TypeScript + Vite web app; the UI the Tauri shell will wrap. Everything is driven by the
engine's render plan (`packages/engine`), rebuilt in the browser on every edit (8–40 ms for the
10 s sample) and drawn per frame by a Canvas2D port of the reference compositor.

```bash
npm install && npm run build
npm run dev -w apps/editor            # http://localhost:5178, opens apps/editor/sample (generated on first run)
LENS_BUNDLE=/path/to/bundle npm run dev -w apps/editor   # or ?dir=/path/to/bundle in the URL
npm test -w apps/editor               # vitest: timeline logic, history, audio schedule
npm run e2e -w apps/editor            # Playwright: parity, editor e2e, demo recording
```

A bundle is a folder with `screen.mp4` (cursorless capture), `meta.json`, `events.jsonl`, and
optionally `cam.mp4`, `transcript.json` (lens-transcribe output), `project.json` and audio files.
`apps/editor/scripts/make_sample.py` writes a synthetic one (fake app UI, procedural webcam,
speech-shaped mic track, hand-timed transcript with two fillers).

Playwright needs a Chromium: `npx playwright install chromium`, or a system Chromium at
`/usr/bin/chromium` / `$LENS_CHROMIUM` (`scripts/ensure-chromium.sh`; Playwright's CDN is blocked in
our CI sandbox). The demo recording also needs Playwright's ffmpeg; a system ffmpeg with libvpx
symlinked to `~/.cache/ms-playwright/ffmpeg-<rev>/ffmpeg-linux` works.

### Running the e2e on a small machine

The suite is 22 tests (parity 2, editor 14, demo 1, takes 2, privacy 1, annotations 2) and runs with `workers: 1`, `fullyParallel:
false`, one reused server (`reuseExistingServer`). On the 2-core sandbox with ~1 GB free, a default
headless Chromium (~900 MB over 8 processes) plus the export's compositor (~430 MB: Python 180, x264
110, two decoders) got the Playwright worker OOM-killed, so by default (`LENS_E2E_LOWMEM=0` turns it
off) Chromium runs with `--in-process-gpu --no-zygote --renderer-process-limit=1` and background
services off, and tests set the decoded-frame LRU to 8 bitmaps per track instead of 24
(`window.__lensMaxBitmaps`, `TEST_MAX_BITMAPS` in `e2e/helpers.ts`). `--single-process` was tried and
dropped: it crashes the browser whenever Playwright closes a context. Where memory is tightest, run
one invocation per spec and the export test on its own, and point `LENS_CHROMIUM` at a Playwright
`chromium-headless-shell` if one is present (old headless mode, ~350 MB):

```bash
npx vite build && npx vite preview --host 127.0.0.1 --port 5188 &   # the one server every run reuses
npx playwright test e2e/parity.spec.ts
npx playwright test e2e/editor.spec.ts --grep-invert "export renders"
npx playwright test e2e/editor.spec.ts -g "export renders"
npx playwright test e2e/demo.spec.ts
npx playwright test e2e/takes.spec.ts -g "swap take"     # multi-take, on apps/editor/sample-takes
npx playwright test e2e/takes.spec.ts -g "mark retake"
npx playwright test e2e/privacy.spec.ts                 # privacy scan + review, on apps/editor/sample-privacy
npx playwright test e2e/parity.spec.ts -g annotations   # annotations parity, on apps/editor/sample-annotations
npx playwright test e2e/annotations.spec.ts             # draw / edit / scrub / step labels / undo
```

Don't run pytest at the same time.

## Layout

| Path | What |
|---|---|
| `src/render/renderer.ts` | `PlanRenderer`: background → shadow → screen (crop, camera, motion blur) → masks → click effects → cursor → rounded composite → webcam → shortcut pill → caption, pass for pass like `compositor/lens_compositor/render.py` |
| `src/render/cursorSprite.ts` | the Lens cursor art (same polygons as the compositor) with its soft shadow |
| `src/media/frames.ts` | frame-accurate source access: the dev server decodes every frame to JPEG once; the browser keeps the bytes and an LRU of 24 decoded bitmaps; index = round(t·fps/1000) like `FrameSource.at` |
| `src/media/audio.ts` | preview audio through the plan's audio pieces (cuts skipped, speed ranges, gain) + waveform peaks |
| `src/state/store.ts` | project + undo history, plan, playhead (output frame), playback / J-K-L shuttle, selection, transcript edits, save, export |
| `src/state/timelineOps.ts` | pure timeline logic: snapping, move / resize / create / delete, cut merging, auto-zoom freezing, source ↔ frame mapping |
| `src/state/history.ts` | undo / redo; a drag or slider gesture is one step |
| `src/components/*` | Preview, Transport (scrubber + live hover thumbnails), Timeline, Inspector, TranscriptPanel |
| `server/api.ts` | dev-server endpoints (Vite plugin): bundle, frames, media, font, save project, export via `compositor/render.py --progress` |
| `parity.html`, `src/parity.ts` | headless parity harness page |

The timeline is in **source** time (the engine's edit data is), with cuts shaded; the transport and
scrubber are in **output** frames. Editing a live auto zoom first "freezes" the current auto zooms
into the project (`auto: true` segments with `zoom.auto` off, which the engine already uses as-is),
so the planner does not put a moved zoom back; turning Auto zoom on again regenerates them.

Multi-take (`docs/Takes.md`): the **Alt takes** lane shows each retake group's takes (kept solid,
rejected hatched and struck through); clicking a rejected take keeps it, ▶ plays an A/B preview of a
take from a trial plan without touching history. The transcript strikes through rejected-take words
and offers take chips, Mark retake, a Takes toggle and Keep last / Keep best. The multi-take sample
is `apps/editor/sample-takes` (`make_sample.py --takes`, generated on first open).

Privacy (`docs/Privacy.md`): the left column switches between **Transcript** and **Privacy**. The
Privacy panel runs the on-device scan (`POST /api/privacy/scan` → `redact/lens-redact`, cached per
screen.mp4 in `.lens-cache/privacy/`), lists the finds by type with thumbnails, and accepts or
dismisses them (one or all; blur or pixelate). Accepted finds are tracked masks (hatched blocks in
the Masks lane). Export asks first while finds are pending. Sample: `apps/editor/sample-privacy`.
Source frames are now fetched from the bundle opened with `?dir=` (before, always the default one).

Annotations (`docs/Annotations.md`): a tool bar over the preview (Select, Arrow, Box, Ellipse, Text,
Callout, Step badge; On screen / On frame; + Text slide), an SVG overlay for drawing, handles and
inline text editing (`AnnotationOverlay.tsx`), an **Annotations** lane with slide markers, a style
inspector (`AnnotationInspector.tsx`) and a **Steps** tab in the left column (`StepsPanel.tsx`,
`POST /api/steps` → `lens-redact steps`). The renderer draws the plan's annotation ops
(`render/annotations.ts`, a port of `compositor/lens_compositor/annotations.py`): screen-anchored
items inside the screen before the cursor, frame-anchored ones after the webcam, slides last. A
regular-weight DejaVu Sans is served next to the bold one (`/api/font/caption-regular.ttf`).
Sample: `apps/editor/sample-annotations` (`make_sample.py --annotations`).

Caption styles (Windows request "diff diff fonts for the captions", `CaptionStyleControls.tsx` in the
Captions tab): a **Style** row of six one-click looks (`CAPTION_PRESETS` in `packages/engine/src/captionStyles.ts`;
a preset sets font, weight, case, colours, box, outline, highlight style and size, and keeps position, line
breaking and text), a **Font** list drawn in each face (`CAPTION_FONTS`; "Theme" follows the preset / brand
`@font`; a face that fails to load is disabled with a reason), then Weight, Capitals, Outline (width, colour) and
Highlight as Colour / Box. Any hand edit clears `captions.style.preset`. The page loads each bundled face as
`"Lens <family>"` (`render/assets.ts`); the export worker refuses to export when a chosen caption font did not
load rather than drawing the fallback. The renderer draws outline with `strokeText` under the fill and the box
highlight as a rounded rect behind the active word, matching `draw_caption` in `compositor/render.py` (FreeType
stroker), so glyph edges differ by sub-pixel coverage only; `parity-caption-styles.spec.ts` checks two looks.

Caption translation (`docs/Translation.md`): the Captions tab has a **Languages** section: caption
language switcher, **Translate to…** with progress (`POST /api/translate` → `translate/lens-translate`
on the bundle's transcript, polled at `GET /api/translate/:id`), the selected track's segments side by
side with their source (edit, Enter / blur commits one undo step), .srt / .vtt download for the selected
language (`store.subtitleFile`, output clock). The renderer draws right-to-left captions in the plan's
visual order, Arabic-script words in Noto Naskh Arabic with `direction = rtl`. The **About** button
(top bar) lists third-party notices, including the CC-BY-4.0 model attribution. Sample:
`apps/editor/sample-translate` (`make_sample.py --translate`, Spanish + Urdu, Urdu selected).

Deleting transcript words adds cuts (`cutsForDeletedWords`) and, since this change, words inside
any cut are left out of captions (engine `plan.ts`). "Remove fillers" cuts every filler not already
cut, as one undo step. Zoom intensity presets and the zoom budget are engine features
(`zoomPreset`, `applyZoomBudget`), see Tracker.

## Framing (fix/aspect-framing-014)

Which part of the recording fills a canvas of another shape (a 16:9 screen on a 9:16 canvas). Picked
with the tiles under the aspect picker (Look > Output), in the Screen section, or the toolbar select
next to the aspect:

| Mode | Plan | Notes |
|---|---|---|
| Fit | card = the source fitted inside the padding, centred (`fittedCardRect`) | the whole recording; the default |
| Fill | source crop = the largest centred window of the canvas aspect (`fillWindow`), card = the canvas | square corners, no shadow (nothing to show around it) |
| Follow cursor | the Fill-mode pan of Windows bug #8: an over-size screen rect panned by `buildPanTrack` (cursor deadzone, fixed zoom targets, the zoom spring) | what `fit: "fill"` always drew |
| Custom | source crop = `output.framingRect` made valid by `customWindow` (aspect locked to the canvas about its centre keeping the area, shrunk / moved inside the user crop), card = the canvas | the window is edited on the preview (below) or with X / Y / W / H (source px) |

Stored as `project.output.framing` (+ `output.framingRect`, source px, the same space as `crop`).
**Default unchanged (Rules.md §4):** a project without `framing` takes its mode from `output.fit`
(`"fill"` = follow, anything else = fit), so every older project plans byte-for-byte as before; this
was checked by planning 8 legacy projects (16:9, 9:16 fit / fill, 1:1 fill + webcam, free cards,
crop + fill, hidden backdrop) with the engine at de0daa3 and with this branch: identical JSON. Picking
a mode also writes `fit` (follow = `"fill"`, the rest `"fit"`) so presets and older builds read the
same thing; applying a preset's look drops `framing` (its `fit` decides). A free card (`project.card`,
a dragged / resized screen) still wins over the mode; picking a mode clears it.

Design choices: an aspect change keeps the framing mode (it used to force Fit) and always clears the
free card, so the card re-fits **centred**; a Custom window re-locks to the new canvas shape about its
centre. A click on the screen card no longer nudges it: the card waits for a 4 screen-px move before
it drags (Faizi's 9:16 report showed the card stored low on the canvas; a fitted card is always
centred, so only a stored free card can sit there).

Editing Custom: "Adjust on preview" (on when Custom is picked) switches the preview to an edit view,
`framingEditPlan`: the whole user crop fitted and centred, unzoomed, no cursor / clicks / masks /
screen annotations, the outside of the window dimmed; drag the window to pan, corners resize with the
aspect locked; one gesture is one undo step. In Fill / Custom, dragging the picture on the normal
preview pans the window too (it becomes Custom). The Screen section's card X / Y / W / H, Scale and
card buttons show only for Fit or a free card (Fill / Follow / Custom cover the canvas). The edit view is preview-only; export renders the
plan as built, through the same `PlanRenderer` as the preview.

## Preview vs export

Parity test: `e2e/parity.spec.ts` builds the plan for the sample project in the browser, renders 14
frames (zoom in/hold/pan, motion blur, blur + spotlight masks, ripples, webcam shrink-on-zoom,
captions with highlight) and compares them with `compositor/render.py` frames for the same plan,
taken before the video encode (`RenderOptions.frame_sink`). Metric: luma SSIM (Wang 2004, 11×11
Gaussian σ 1.5) over the whole 1280×720 frame. Thresholds, fixed before the first measurement:
**every frame ≥ 0.95, mean ≥ 0.97**. Measured: mean 0.988, min 0.983 (see Tracker).

Intentional or accepted differences:

1. **Source pixels.** The preview reads JPEG (q 2) proxies of the source frames; the compositor reads
   raw decoded frames. ~1.6 levels mean absolute difference on the source alone.
2. **Resampling.** Canvas "high" quality smoothing vs OpenCV INTER_AREA (down) / INTER_CUBIC (up).
   Pixel-centre conventions are matched (offset 0.5 − 0.5/k), the filters are not.
3. **Background dither.** The compositor adds ±0.5 level noise against banding; the preview does not.
4. **Text.** Same font (DejaVu Sans Bold, served by the dev server), same layout maths (no kerning,
   FreeType-style rounded metrics), but Chrome and PIL rasterise differently and PIL's pill corners
   are not anti-aliased.
5. **Overlapping spotlights.** Preview dims by the product of (1 − spot); the compositor by
   1 − max(spot). Identical unless two spotlights overlap.
6. **Viewport beyond the frame edge** (only motion-blur samples can do this): compositor replicates
   edge pixels, preview leaves them transparent.
7. **Cursor sprite.** Drawn as a 256 px vector with premultiplied resampling; the compositor
   supersamples 4× and resizes non-premultiplied RGBA.
8. **Motion blur** is a running average in 8-bit, so up to ~1 level of rounding per pixel.
9. **Encode.** Exports are x264 yuv420p, converted with the BT.709 matrix (limited range,
   `accurate_rnd+full_chroma_int`) and tagged bt709 / tv (`encoder_args` in `render.py`). Before,
   ffmpeg's default untagged BT.601 conversion was decoded as BT.709 by players (what browsers do
   for HD), shifting saturated colours by up to 23 levels (10.8 mean over 10 flat patches); now
   ≤2 levels worst channel, 0.7 mean, decoded the same way (`tests/test_export_colour.py`).
   Parity is still measured before the encode, so this does not enter the SSIM numbers.
10. **Audio preview** plays the raw mic track: no denoise or loudness normalisation (export only),
    no click sounds, and speed ranges change pitch (WebAudio playbackRate) where the export uses
    pitch-preserving atempo.
11. **Annotation text** is laid out the same way in both (no kerning: PIL `Layout.BASIC` and canvas
    `fontKerning = "none"`), but rasterised by different engines; vector ops are 4× supersampled in
    the compositor and coverage-anti-aliased by the canvas. Measured on the annotations sample:
    SSIM mean 0.990, min 0.983 (bounds unchanged).
12. **Image backdrops** (`background.kind = "image"`) are not drawn by the preview yet (it falls back
    to the first colour).

## Export dialog (demand #7)

**Export…** in the top bar opens the Export dialog: **Video** (the MP4 export), **Interactive demo**
(steps, call-to-action fields, Build demo, live preview in an iframe, Download HTML, and a hotspot
editor: drag the selected step's hotspot on its still, edit its tooltip; one undo step each, applied
to the preview at once) and **Step guide** (Build guide, preview, PDF / Markdown / HTML). See
`docs/InteractiveDemo.md`. Playwright: `e2e/stepsExport.spec.ts`.
