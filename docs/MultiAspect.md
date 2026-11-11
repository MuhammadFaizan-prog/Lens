# Several sizes from one recording (demand #15)

Clean-room, Lens's own design (no product was decompiled or copied; the idea comes from the public
demand evidence in `research/demand/demand-report.md` #15). One project exports a 16:9, a 9:16, a 1:1
and a 4:5 cut in one batch, each framed on its own, so a vertical cut is not a letterboxed copy of the
wide one.

Builds on the per-project framing shipped in v0.1.4 (`docs/Editor.md`, Fit / Fill / Follow cursor /
Custom, `packages/engine/src/framing.ts`).

## In the editor

- **Export… > Video > Several sizes…** (`sizes-enable`) turns it on: one row per size with its pixel
  size, a tick (exported or not), its framing (Fit / Fill / Follow cursor / Custom) and **Show**.
  The current aspect keeps its framing; the other shapes start on **Follow cursor**, which fills the
  frame and pans with the cursor, or towards a zoom's fixed target while that zoom is on, keeping the
  cursor in frame too (see "Follow keeps the cursor and the target" below). **One size**
  turns it off (the size shown stays).
- **Show** (or the toolbar's size picker, `tb-target`, which replaces the aspect picker while several
  sizes are on) makes that size the one the preview draws and every framing control edits, including
  Look > Output and the Custom window on the preview. One undo step per switch.
- **Crop keyframes** (Custom framing, Look > Screen > Framing > Keyframes): **+ Key at playhead** keeps
  the window shown now at that moment; with keys, the window glides between them (smoothstep, held
  before the first and after the last key) and every window edit (X / Y / W / H, dragging on the
  preview, Reset) sets the key at the playhead. The list shows each key's time and window, seek and
  remove.
- The toolbar **Export** button becomes **Export N sizes** and runs the batch; the Video tab also has
  **Export N sizes** and **Export MP4 (shown only)**. The export sheet shows *Exporting 9:16 (2 of 4)*
  and then one row per size with its size and a **Download** link (`lens-export-9x16.mp4`). Cancel
  stops the size being exported (its server job too, even when pressed while that size is still
  starting) and skips the rest.

## Follow keeps the cursor and the target

During a zoom on a fixed point, Follow used to aim the crop at the zoom target only; on a narrow size
(9:16 shows ~400 of 1280 source px, less while zoomed) a cursor 600 px away left the frame. Now each
Follow frame (`followFrame`, `packages/engine/src/framing.ts`):

1. starts from the old window (Fill size, centred on the pan focus): if it already holds the cursor
   and the target with 6 % of the window clear on each side, the frame is drawn exactly as before;
2. otherwise moves the window the least that holds both;
3. and if both cannot fit in a Fill window, widens it until they do: the recording shrinks in the
   frame and the background shows above and below it (on 9:16 with the cursor and target 600 px apart,
   about a 600 px wide window), and the camera zooms back out as far as that needs.

The target's weight follows the zoom (full from half way in, fading as the camera zooms back out), so
the frame moves continuously. A hidden or idle-hidden cursor is not kept (the old Follow then).

## Project data

```json
"output": {"aspect": "1:1", "framing": "custom", "framingRect": {...},
           "framingKeys": [{"srcMs": 100, "rect": {"x": 170, "y": 370, "w": 300, "h": 300}}]},
"exportTargets": {"active": "t1x1", "items": [
  {"id": "t16x9", "aspect": "16:9", "framing": "fit", "framingRect": null, "enabled": true},
  {"id": "t9x16", "aspect": "9:16", "framing": "follow", "framingRect": null, "enabled": true}, ...]}
```

- `exportTargets` is optional; older projects have none and render exactly as before.
- The active target's framing lives in `project.output` while it is shown (so every existing framing
  control works unchanged); switching saves it back into its item and loads the other one
  (`switchTarget`, `syncedTargets`). The item stored for the active target can therefore be older
  than `output`; `output` wins.
- `output.framingKeys` (also per target): `srcMs` on the recording clock, `rect` in source px; the
  aspect is locked to the canvas like `framingRect`. Absent or empty = the static `framingRect`.
- Validation: unique ids, `aspect` w:h (or `auto`), framing one of the four, `active` one of the ids,
  keys `srcMs >= 0` with a positive rect.

## Engine (`packages/engine/src/exportTargets.ts`, `plan.ts`)

- `projectForTarget(p, id)`: the project as one target exports it (its aspect, framing, window and
  keys in `output`, custom canvas size cleared, a free card dropped when the shape changes). The
  active target exports the project as it is, so its plan is identical to the plan without targets.
- Keyed Custom framing: the crop stays the whole (user-cropped) source and each frame's window becomes
  a screen rect covering the canvas (`windowScreenRect`), the same per-frame layout Follow already
  uses. A zoom magnifies about the window centre; the rect is clamped so no backdrop shows; corners
  and shadow are off like the other edge-to-edge framings. Because it is plan data, the preview
  renderer, the in-app (browser) export used by the desktop app and the Python reference export all
  draw it the same way.

## Tests

- Engine vitest `packages/engine/test/exportTargets.test.ts` (9): canvas sizes at 360p exact
  (640x360, 360x640, 360x360, 360x450); switching round trip lossless; disabled targets left out; old
  projects / no keys / the active target plan **identical** (JSON equal); keys held / smoothstep; each
  key's window maps edge to edge onto the canvas within 0.5 px; the window glides monotonically
  between keys; every keyed frame covers the canvas; validation.
- Editor vitest `apps/editor/test/framingKeys.test.ts` (2): window edits act on the key at the
  playhead, nothing changes without keys.
- Playwright `apps/editor/e2e/multiAspect.spec.ts` (bounds in the file, set before the first run):
  through the Export dialog, the toolbar size picker and the Custom keyframe panel, a 4-size batch
  on the in-app export path, then a second batch cancelled while its first size runs. See the Tracker
  row for the measured numbers.
- Engine vitest `packages/engine/test/followFraming.test.ts` (7): a frame that already holds the cursor
  is the old frame; close points held with the margin and the canvas still covered; far points held by
  widening; continuous in the target weight; target weighting; the e2e scene's plan on 9:16 and 4:5
  (cursor in frame on every frame, target in frame through the hold).

## Not done / known limits

- **Follow widens rather than cuts.** When the cursor and a zoom target are too far apart for the
  size, Follow shows both by shrinking the recording (background above and below) instead of a cut
  or a split; a per-size "cursor only" option is not built.
- Zooms are shared by all sizes (re-aimed by Follow, not re-planned per size); per-size zoom scales are
  not built.
- GIF / step-guide exports are one size; Windows unverified.
