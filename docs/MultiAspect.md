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
  frame and pans with the cursor, or with a zoom's fixed target while that zoom is on. **One size**
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
  stops the size being exported and skips the rest.

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
  on the in-app export path. See the Tracker row for the measured numbers and the one bound that
  fails (the cursor is not in the 9:16 / 4:5 frame while Follow aims at a zoom target 600 px away).

## Not done / known limits

- **Follow cannot keep both the cursor and a distant zoom target in a narrow frame.** During a
  fixed-target zoom, Follow aims at the target (by design); on the 9:16 and 4:5 sizes the cursor is
  then outside the frame, and during the pans into and out of the zoom (about 0.4 s in all here) neither is. The e2e bound "cursor in
  frame on every Follow frame" fails for that reason (31 / 60 frames on 9:16, 29 / 60 on 4:5 in the
  test clip). A per-size "follow the cursor, ignore zoom targets" option or a cut instead of a pan
  would be the next step.
- Zooms are shared by all sizes (re-aimed by Follow, not re-planned per size); per-size zoom scales are
  not built.
- GIF / step-guide exports are one size; Windows unverified.
