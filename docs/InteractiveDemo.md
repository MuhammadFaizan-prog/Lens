# Interactive demo and step guide (demand #7)

One recording, three outputs: the polished video, an interactive click-through demo, and a
step-by-step guide. The demo and the guide are built from the same accepted step labels as the
video's numbered badges (`docs/Annotations.md`), so a project that already has its steps reviewed
exports all three without more work.

Clean-room, Lens's own design (`docs/Rules.md`). The idea comes from the public demand evidence in
`research/demand/demand-report.md` #7 (Supademo / Arcade reviews, the FocuSee "Interactive guides"
request); no product was opened, decompiled or copied, and the page layout, hotspot, tooltip,
colours, wording and PDF layout are our own. No new third-party code: the page is hand-written
HTML / CSS / JS, the PDF is written by Lens itself (no PDF library), images go through OpenCV / PIL
which Lens already uses.

## Using it

```bash
lens steps generate -C demo && lens steps accept -C demo          # once: review the step labels
lens set /demo/cta '{"title":"Ready to try it?","text":"Start a free trial.","buttonLabel":"Start free trial","url":"https://example.com/start","enabled":true}' -C demo
lens export demo  -C demo [--out folder]      # -> exports/demo-demo/index.html (one file)
lens export guide -C demo [--out folder]      # -> exports/demo-guide/guide.md, guide.html, guide.pdf
lens demo hotspot st3 --x 652 --y 418 --tooltip "Create the report" -C demo   # hotspot editor
lens demo hotspot st3 --clear -C demo
```

MCP: `export_demo` and `export_guide` (`project`, `out`). Editor: **Export…** in the top bar opens
the Export dialog (below). The low-level tool is `compositor/export_steps.py --manifest --plan
--screen --out --kind demo,guide --assets`; the engine's `stepsExportInput` writes its inputs.

## Project data (`project.demo`)

| Key | Default | Meaning |
|---|---|---|
| `title` | `""` | Demo / guide title; empty = the brand name (brand kit on), else "Interactive demo" |
| `description` | `""` | Line under the guide title and in the demo's first tooltip |
| `cta` | `{enabled: true, title: "You're all set", text: "", buttonLabel: "Get started", url: ""}` | Final slide of the demo and the end of the guide. `url` must be `http(s)://` or `mailto:` (anything else, e.g. `javascript:`, is refused by validation); no url = no button |
| `leadMs` | 80 | Each still is the frame this long before the click (the UI before the press, same as the step labeller) |
| `zoom` | `none` | `none`: the whole screen in its frame; `video`: the video's own camera at that moment (a click outside the zoomed view is reported in `outsideImage`) |
| `maxWidth` / `quality` | 1600 / 90 | Stills are rendered at the output size, scaled down to this width, JPEG quality |
| `hotspots` | `[]` | Hotspot editor changes per step: `{stepId, x?, y?, tooltip?}` (source px). The step label and the video's badge stay as they are |
| `guide.zoom` / `guide.boxPadding` | 2 / 6 | Guide screenshots are this much closer than the whole frame; padding of the highlight box in source px |

## How it works

1. **Steps** (`packages/engine/src/demo.ts`): accepted step drafts in click order, numbered 1..n,
   with the hotspot editor's position / tooltip applied.
2. **Stills** (`demoStillProject`): a derived project with the video's look (backdrop, padding,
   radius, shadow, crop, aspect, resolution), its privacy and hand-drawn masks, its other
   annotations and the brand watermark, but no camera motion, cursor, click effects, motion blur,
   captions, webcam, slides, brand cards, cuts or speed changes, so output time = source time. Step
   badges are left out (the hotspot replaces them). `stepsExportInput` builds the plan with only the
   still frames and a manifest (steps, brand palette and font, CTA, title).
3. **Rendering** (`compositor/lens_compositor/stepsexport.py`): the reference compositor draws the
   still frames exactly as the export draws video frames (so every privacy mask is applied). The
   hotspot is the click mapped the way `render.py` maps the screen: crop, then the camera viewport,
   then the layout's screen rect rounded to whole px, then the scale-down (pixel centres).
4. **Demo page**: one `index.html` with the stills as `data:` JPEGs, inline CSS and JS, the brand font
   inlined (`@font-face` from the font file), the logo inlined (PNG / JPEG / WebP only), and a
   Content-Security-Policy of `default-src 'none'; img-src data:; font-src data:; style-src
   'unsafe-inline'; script-src 'unsafe-inline'`, so the page cannot make a network request. Header
   with logo and title, progress bar, the still with a pulsing hotspot (a `<button>`, keyboard
   focusable, reduced-motion aware), a tooltip placed on the side with room (right, left, below,
   above; docked to the bottom of the screen under 640 px), Back / Next, and the CTA slide over a
   blurred last step with Restart. Keys: → / PageDown / Space next, ← / PageUp back, Home, End;
   `#step-4` and `#end` deep links (hash changes navigate). Also written: `demo.json` (hotspots in
   image px, each still's source→image map) and `images/step-NN.jpg` for tools.
5. **Guide**: per step, the full-resolution still cropped around the click (`guide.zoom` closer),
   the clicked control's box (from the step labeller, which now stores it; else 120 × 44 source px
   around the click) padded and drawn as a rounded outline in the brand primary with a white halo.
   `guide.md` (headings "Step k of N: label", relative images), `guide.html` (self-contained, print
   CSS one step per page) and `guide.pdf` (A4: cover with title, description, step list and the
   CTA; then one page per step with "Step k of N", the label and the screenshot as a lossless
   FlateDecode RGB image; Helvetica, not embedded).
6. **Text privacy**: labels, titles and CTA text go through the privacy classifiers first; an email,
   key, token or card number in a label (OCR read a clicked address) becomes `•••`.

## Editor: Export dialog

**Export…** (top bar) opens a dialog with three tabs:

- **Video**: the existing MP4 export (progress sheet as before).
- **Interactive demo**: step list, call-to-action fields (title, text, button, link), **Build demo**,
  the built page live in an iframe, **Download HTML**, and the **hotspot editor** for the selected
  step: its still with a draggable hotspot and a tooltip field. Dragging or editing is one undo step
  each, stored in `project.demo.hotspots`, and reaches the iframe at once (postMessage to the page,
  which only listens when opened with `#lens-preview` inside a frame); changes to steps or the CTA
  show "rebuild to update the preview".
- **Step guide**: **Build guide**, a preview of `guide.html`, and PDF / Markdown / HTML downloads.

Dev server: `POST /api/steps-export {project, kind}`, `GET /api/steps-export/:id`,
`GET /api/steps-export/:id/file/<path>` (confined to that export's folder).

## Tests and measurements

Bounds were written into the tests before the first run.

| Test | Bound | Measured |
|---|---|---|
| Hotspot vs the click (`tests/test_steps_export.py`): a magenta marker drawn into the recording at each click point; its centroid in each exported still vs the hotspot. Two sessions: whole screen (crop + 6% padding + 16:9 layout of a 16:10 recording), and `zoom: video` with a 1.8× zoom over one click | ≤ 2 px on each axis | worst 0.13 px over 12 stills |
| Same in the rendered page (Playwright `stepsExport.spec.ts`): hotspot element centre vs the marker found in the displayed image, at 1600×1000 and 900×700 | ≤ 2 px on each axis of the rendered size | worst 0.16 px |
| Demo page, offline (`context.setOffline`, every non-file request routed and aborted) | 0 requests, 0 console errors; hotspot click advances; → ← Home End work; step count = accepted steps; CTA slide with the project's link | pass |
| Privacy (`test_no_secret_readable_in_demo_or_guide`): fake console session with planted fake secrets, six steps clicked on secrets, scan + accept all, export demo + guide; OCR of every secret region visible in each still / guide image and of the whole of every image | 0 leaks; control (same export with the detections dismissed) reads ≥ 70% of the regions | 0 leaks in 12 images / 41 secret regions + whole-image OCR; control 40/41 (0.98) |
| Guide PDF | pages = steps + 1; "Step k of N" once each; one image per step page, lossless; highlight box outline ≥ 90% within RGB distance 60 of the brand primary (PNG and PDF image) | 7 pages, 6 steps, outline cover 1.00 on all six |
| Markdown / HTML / demo HTML self-contained | one heading + image per step; no http(s) reference except the CTA link; CSP present | pass |
| Engine vitest `demo.test.ts` (7): steps order / numbering / overrides, title fallback, CTA link validation, still project contents, output time = source time in the still plan, no steps error | — | 7 / 7 |
| CLI integration (export demo / guide, `--format demo`, hotspot editor idempotent, errors 2 / 3 / 4) and MCP (`export_demo` / `export_guide`, not_found before review, path escape refused) | documented exit codes; idempotent | pass |
| Playwright Export dialog: build, live iframe, drag the hotspot (project changes, iframe hotspot moves without a rebuild), tooltip live, undo, guide PDF | — | pass |

## Known limits

- Stills only: no per-step video snippets yet, no GIF steps, no typing steps (only clicks become
  steps), no branching or multi-path demos, no hosting or share link (#13), no analytics beacon.
- `zoom: video` can put a click outside the zoomed view; the hotspot is then clamped to the edge and
  the step is listed in the export result's `outsideImage`.
- The PDF uses Helvetica (not embedded) with WinAnsi text: characters outside it (Arabic, CJK)
  print as "?"; the HTML and Markdown keep them. Brand fonts are used in the HTML outputs only.
- SVG logos are not inlined (scripts inside SVG); use PNG / JPEG / WebP.
- The demo file grows with the steps (~150-250 KB per 1280 px still, plus ~600 KB for an inlined
  brand font).
- Tested on synthetic sessions only; the demand report's pilot (time to publish, viewer completion)
  has not been run.
