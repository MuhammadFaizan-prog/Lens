# Annotations, text slides and auto step labels (demand #4)

Clean-room, Lens's own design. The idea comes from the public demand evidence in
`research/demand/demand-report.md` #4 (arrows, callouts, click descriptions, full-text slides,
enter/exit animations); no product was decompiled or copied, and none of the shapes, animation
curves, colours or layouts were taken from another product. Text uses DejaVu Sans / DejaVu Sans
Bold (Bitstream Vera licence + public-domain changes, permissive); the held-out test session also
uses Liberation Sans (SIL OFL 1.1) as test media only. Nothing is baked into the recording:
annotations are project data, editable until export.

## What there is

| Kind | Geometry | Notes |
|---|---|---|
| `text` | `rect` (x, y top-left; `w` = wrap width, 0 = no wrap) | roles: `title` (frame, centred, pill), `lower-third` (frame, accent bar on the left), `label` (screen, pill); `align` left / center / right |
| `arrow` | `from`, `to`, `curve` (bend as a fraction of length, sign = side) | heads / tails: `triangle`, `open`, `dot`, `none` |
| `rect` / `ellipse` | `rect` | highlight: outline + translucent fill, corner radius |
| `badge` | `at`, `size` (radius) | numbered step badge; `number: null` = automatic (1, 2, 3 by start time among auto badges); optional label pill (`text`) |
| `callout` | `rect` (bubble), `to` (pointer tip) | rounded bubble with a pointer leaving the side that faces the tip; wrapped text |

Every item has `startMs` / `endMs` (source time, like masks), an `in` and an `out` animation
(`none`, `fade`, `pop`, `draw`, `typewriter` in; `none`, `fade`, `pop`, `draw` out, each with
`ms`) and a `style`: colour, fill + fill opacity, stroke width, font size, bold, text colour, corner
radius, drop shadow (opacity, blur, offset) and overall opacity.

**Anchors.** `screen`: geometry in source px (full recording, before crop); the renderer maps it
through the virtual camera like a mask, so it follows zoom and pan, sits inside the rounded screen
(under the cursor) and scales with the zoom. `frame`: positions as fractions of the output frame,
sizes in px at 1080p scaled with the output resolution; drawn above the webcam, under shortcut
pill and caption.

**Text slides** (`project.slides`): full-frame title cards (title, subtitle, background, text
colour, accent bar, sizes) inserted at a source time (`atMs`) with their own `durationMs` and an
optional cross-fade (`fadeMs`) with the video. The engine splits the edit timeline there and
moves everything after it later by exactly the slide's duration (`insertSlides`), so video,
captions, click sounds and audio after it shift together; the slide is silent and holds the source
frame under its fades. A slide inside a cut lands where the cut is. Plan: `plan.slides` (output
spans) and `frame.slide`.

## Animation curves (`packages/engine/src/annotations.ts`)

| | curve |
|---|---|
| fade | ease-out cubic of opacity |
| pop | scale 0.4 → 1 along an underdamped spring step response (ζ = 0.5, ω = 9 per unit of animation time, one overshoot of ~16%, residual removed so it lands on exactly 1), opacity ramps in over the first 30% |
| draw | ease-in-out cubic of the drawn path fraction (arrows by arc length with the head riding on the tip; outlines of boxes, ellipses and bubbles, their fill fading in with it) |
| typewriter | linear count of visible characters (layout always uses the whole text, so wrapping never jumps) |

In and out each take at most half the item's life. `animState(item, t)` returns opacity, scale,
draw fraction and typed fraction; unit tests pin the values at known times.

## How it is drawn (preview == export)

The engine owns every decision and emits **drawing ops** per frame (`frame.annotations[]`): filled
polygons, stroked polylines (round caps and joins) and text boxes (wrap width, alignment, backing
pill, visible-character count), already tessellated (48-segment arrows, 96-segment ellipses,
8-segment rounded corners, callout notch), in cropped source px (screen) or output px (frame).
Both renderers only transform points and draw:

- `compositor/lens_compositor/annotations.py`: each item into its own layer, vector ops 4×
  supersampled (OpenCV, sub-pixel shift) and area-averaged, text with PIL **without kerning**
  (`Layout.BASIC`), then the drop shadow (Gaussian, σ = blur / 2) and the item's opacity.
- `apps/editor/src/render/annotations.ts`: the same with Canvas2D paths, `fontKerning = "none"`,
  `shadowBlur` (= 2σ) on the layer.

Text layout is the same greedy word wrap on advance widths in both, line height
`trunc((ascent + descent) × 1.15)`, DejaVu Sans / Bold served to the browser by the dev server.

## Auto step labels (`redact/lens_redact/steps.py`, `lens-redact steps`)

For each left click in `events.jsonl` (double clicks merged): the frame 80 ms before the press, a
520 × 200 source-px region around the click, upscaled 2×, OCR'd twice with Tesseract
(`--psm 11`): as it is, and as a polarity-free **contrast map** (distance from a 21 px median
background), so white text on a coloured button reads as well as dark text on a page; overlapping
words keep the more confident reading. Words are grouped into lines (the privacy scan's
`group_lines`), lines split into controls at gaps wider than one text height, and the control under
the click (text box padded to roughly a button) is chosen, else the nearest within 40 px, else
"Click here" (confidence 0). Verb: **Open** for navigation (a menu / sidebar word, an item of a
top menu row, or an item in a left-aligned vertical list of short items), **Click** otherwise.

```bash
redact/lens-redact steps screen.mp4 --events events.jsonl -o steps.json
node packages/engine/dist/cli.js ... --step-labels steps.json [--accept-steps] --out plan.json
```

Drafts live in `project.stepLabels.drafts` (`pending` / `accepted` / `dismissed`, editable label).
Accepting one adds an auto-numbered badge (`stepId`) up-right of the click, from 400 ms before to
2.6 s after it, with the label in a pill. Dismissing, un-reviewing or deleting the badge removes
it; numbers close up. A re-run keeps the review state and edited label of the same click.

## Editor

- **Tool bar** over the preview: Select (V), Arrow (A), Box (B), Ellipse (E), Text (T), Callout
  (C), Step badge (N); **On screen / On frame** for new items; **+ Text slide** at the playhead.
- **On the preview** (`AnnotationOverlay`): click-drag draws (arrows from tail to head, boxes and
  callouts corner to corner, text and badges by click). New items start their in-animation before
  the playhead so they are fully visible where you drew them. Select tool: click to select, drag to
  move, handles for box corners, arrow ends, arrow bend and callout tip. Double-click text, a
  callout or a badge to edit its text inline (Enter commits, Shift+Enter new line, Esc cancels).
  Drawing while zoomed lands on the content under the pointer.
- **Annotations lane** in the timeline: one block per item (stacked when they overlap), move and
  trim like other blocks, double-click to add a text item; slide markers (drag to move).
- **Inspector**: text, colours, fill, stroke, font size, bold, radius, curve and head / tail,
  shadow, opacity, in / out animation and time, jump / play buttons for the in and out animation.
  Slides: title, subtitle, duration, cross-fade, colours, accent, size.
- **Steps** panel (left column): Generate step labels (dev server `POST /api/steps`, cached per
  screen.mp4 + events.jsonl), review list with the number each badge draws, editable labels,
  accept / dismiss one or all, click a number to jump to the click.
- Scrubbing (scrubber, timeline, frame stepping) redraws the animation state live. Every change is
  one undo step; a drag is one step.

Sample bundle: `apps/editor/sample-annotations` (`make_sample.py --annotations`: a 13 s
click-through of a fake app with every kind, both anchors, a zoom and a text slide).

## Tests and measurements

Bounds were written into the tests before the first measurement.

| Test | Bound | Measured |
|---|---|---|
| Engine vitest `annotations.test.ts` (14): curves (monotonic, end points, pop overshoot 10–25% and continuity), in / out timing at known times, arrow head rides the drawn tip, rounded rect / callout notch, crop + frame scaling, typewriter, auto numbering (accept order, dismiss renumbers, edit follows, re-run keeps state), slides on the timeline (shift, in a cut, stacked, at the end), plan (exact +90 frames for 3 s of slides, no clicks / captions during slides, silent audio pieces, source 6 s at output 9 s), validation | — | 14 / 14 |
| Arrow draw-on in the export (`tests/test_annotations.py`) | visible tip within the plan's tips of frames i−1..i+1, ±2 px for anti-aliasing / encode | pass (24 frames checked) |
| Text readable in the export | ≥ 95% of all words and ≥ 80% per item read back by OCR | 14 / 14 words (title, lower-third, screen label under a 2× zoom, callout, badge label) |
| Screen-anchored box over its target while zoomed | every edge within ±2 px of target edge + padding, through zoom in, hold and out | 135 frames, worst 1.68 px |
| Text slide | exactly durationMs × fps / 1000 slide frames, output length + exactly the slide, beeps after it at their shifted times ±1 frame, silent slide | 45 / 45 frames at the planned frame, 3 / 3 beeps within a frame |
| Step labels, dev session (14 clicks) | ≥ 90% exact, 100% numbering order | 14 / 14 exact (1.000), order 100% |
| Step labels, **held-out** session (16 clicks: dark theme, Liberation Sans, other words, sizes, positions) | ≥ 90% exact, 100% numbering order | **16 / 16 exact (1.000)** on its first and only run, order 100% |
| Preview ↔ export parity on the annotations sample (14 frames: every kind, both anchors, a zoom, slide fades) | every frame ≥ 0.95 SSIM, mean ≥ 0.97 (the existing bounds) | mean 0.99043, min 0.98289 |
| Playwright `annotations.spec.ts` (2) | draw an arrow on the preview (lands within 4 px of the pointer), text by click + inline typing, double-click to edit, scrub the draw-on with the scrubber (draw fraction and drawn pixels never go down, < 35% → > 85%), undo back to the original pixels (< 0.5 levels), redo; generate step labels (real OCR), edit one, accept all, badges numbered by click time with no gaps, panel shows the drawn numbers, badge next to its click, undo / redo | 2 / 2 |

Measurement-method changes made after a first failing run (bounds unchanged, see Tracker):
the arrow tip is found by projecting each pixel onto (arrow colour − background) instead of an RGB
box, so the thin anti-aliased point of the head counts; the box test searches near where the plan
says the box is (orange anti-aliased edges of other items elsewhere matched the red box); text is
OCR'd per item region (laid out exactly as the compositor lays it out, polarity-normalised, 2×)
instead of the whole frame, where Tesseract skipped two pills.

## Known limits

- Step labels: synthetic web-app screens only (two fonts, clean rendering, 1×); no real apps, no
  icons-only buttons (they get "Click here"), no accessibility-tree labels (needs native capture),
  English only. The navigation word list was written before the held-out session but by the same
  author; the held-out "Insert" (not in the list) was found by the top-row rule. The demand
  report's test (100 clicks across 5 real web apps, ≥ 80% usable unedited) has not been run.
- A step badge's label pill can run off the right edge of the screen (it always sits to the right).
- Annotation text has no font choice beyond DejaVu Sans / Bold, no rotation, no per-word styling,
  no rich text, no emoji colour; screen-anchored items scale with the zoom (no "keep size" option).
- Callout pointers become thin when the tip is far away (base width is fixed by the bubble size).
- Slides have a solid background only (no gradient / image), no in-slide animation, and slides
  are not in the Steps export (#7) yet.
- No task test with users (time to add 6 callouts vs Camtasia / Keynote) yet.
- The editor's hit test uses each item's bounding box (arrows: distance to the curve).
