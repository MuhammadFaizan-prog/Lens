# Freeze frames, still images and title cards (demand #20)

Lens's own design (clean room, Rules.md §1). Three kinds of "hold the picture" edits, all
non-destructive project data, drawn by the same render plan in the preview and in both export paths.

## In the editor

The annotation toolbar above the preview has an **Insert** group; everything goes in at the playhead.

| Button | What it does | Where it shows |
| --- | --- | --- |
| **+ Title card** | A full-frame card with a title, subtitle and accent bar (2 s). With the brand kit on, the card follows it: theme backdrop, brand font, primary accent, brand logo, and a text colour readable on the backdrop. | A pink marker on the Annotations lane |
| **+ Image** | Pick a PNG, JPEG or WebP; it is copied into the project folder (`media/`) and shown full-frame for 3 s, *Fit* (whole picture on the slide background) or *Fill* (covers the frame, edges cropped), with an optional caption and subtitle under it. | A green marker on the Annotations lane |
| **+ Freeze** (key **H**) | A **hold**: the screen stops on its frame at the start of the block for 2 s, while sound, captions, zooms, the webcam and annotations keep playing, so the video does not get longer. The cursor keeps moving over the still screen (handy for pointing at something while you talk) or can be hidden. | A blue block on the **Freeze** lane (drag, resize, copy, delete like any block; double-click the lane or its + to add one) |
| **+ Pause** | A **pause**: the whole video stops on this frame for 2 s, silent, and everything after it plays later (audio stays in sync). | A blue marker on the Annotations lane |

Selecting a block or marker opens its inspector: length / duration, cursor live or hidden (freeze),
*Make it a pause* (turns a hold into a pause of the same length), Fit / Fill and *Replace…* (image),
cross-fade, **Brand kit look** (title card and image; off = your own background and text colours).

## Project data

```jsonc
// hold freezes, source time; absent in older projects
"freezes": [{ "id": "freeze-1", "startMs": 4900, "endMs": 6900, "cursor": "live" }],
// slides gain an optional kind; absent = "text", the title card exactly as before
"slides": [
  { "id": "t", "atMs": 0, "durationMs": 2000, "title": "Chapter one", "brand": true },
  { "id": "i", "atMs": 4500, "durationMs": 3000, "kind": "image", "title": "", "image": { "path": "media/diagram.png", "aspect": 1.3333, "fit": "contain" } },
  { "id": "p", "atMs": 2800, "durationMs": 1500, "kind": "freeze" }
]
```

## How it renders

- **Hold** (`packages/engine/src/freeze.ts`, `plan.ts`): plan frames inside a hold carry
  `vid` = the freeze start, the source time of the screen picture; `src` keeps running, so the cursor,
  camera, captions, webcam, annotations and audio are unchanged. Masks are sampled at `vid` so a blur
  stays on the frozen content. `cursor: "hide"` drops the cursor and click effects for the hold only.
  On overlap the hold that started first wins, so the held frame never steps backwards. Every frame
  reader uses `videoTime(frame)` (= `vid ?? src`): the preview, the browser export worker (the
  desktop app's path), the on-page fallback, preset thumbnails, the parity page and the Python
  reference compositor (`render.py`).
- **Pause** is a slide of kind `freeze`: it goes through `insertSlides`, the same timeline insertion
  as title cards, so output time, audio pieces and captions shift by exactly its duration and the
  pause itself is silent; the plan draws no slide ops for it, so the held video (with its zoom,
  backdrop and annotations) shows through.
- **Image slides** draw the slide background and one `image` op (whole pixels, aspect kept) plus the
  optional text: the same op the brand logo uses, so both export paths already draw it.
- **Brand title cards** (`brand: true`) are resolved live by `applyTheme`, the same way as the brand
  intro / outro cards; changing the brand colour changes the card without touching it.

Old projects: no `freezes`, no `kind`, no `brand` = byte-identical plans (unit-tested), so they
render exactly as before. No engine default changed.

## Tests

- `packages/engine/test/freezeFrames.test.ts` (11): byte-identical plans without freezes; hold
  keeps `videoTime` at the start while `src`, cursor (moves > 800 px) and clicks continue, audio plan
  and length unchanged; cursor hide; masks follow the held picture; overlapping holds monotonic;
  validation; pause inserts exactly its duration, holds `src`, draws no slide and shifts the audio;
  image contain / cover geometry; brand cards follow a brand colour change.
- `apps/editor/test/freezeOps.test.ts` (3): Freeze lane add / move / resize / duplicate / delete /
  select-all, no overlap, editor-built project plans the hold.
- `apps/editor/e2e/freezeFrames.spec.ts`: builds all four through the Insert group on a synthetic
  moving scene (`scripts/make_freeze_sample.py`) and measures the preview and the exported MP4
  (red square centroid drift inside the hold, cursor still moving, pause frames identical, image and
  title-card pixels, preview vs export difference, the exported audio tone shifted by the pause and
  silence during it). Run with `LENS_EXPORT=browser` for the desktop export path.
