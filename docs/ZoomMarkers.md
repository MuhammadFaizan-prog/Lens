# Hotkey zoom markers (demand #19)

Auto-zoom guesses where a zoom belongs from clicks and typing; many people would rather say so
themselves, at the moment they are explaining something ("make zooms opt-in, for example by pressing a
keyboard shortcut while recording", demand report #19). Lens now has a **zoom-marker hotkey**.

## Using it

1. Start a recording as usual.
2. When you get to something worth a closer look, point at it and press **Ctrl+Alt+Z** (Cmd+Alt+Z on
   macOS). It works from any app while Lens records. The recorder's live panel also has a
   **⚑ Zoom marker** button, the tray menu has **Add zoom marker** while recording, and the panel shows
   how many markers you dropped.
3. Stop. The project opens with one **zoom block per marker** on the Zoom lane (marked ⚑ with an amber
   outline). Each block starts at the moment you pressed the key, is aimed at where the cursor was, and
   lasts 3 s, or until your next marker (consecutive markers glide from one point to the next instead of
   zooming out and in again). A second press within 0.4 s of the first counts once.
4. The blocks are normal manual zoom blocks: drag, trim, re-aim (click the preview), change the zoom
   level, or delete them. Auto-zoom stays as it was; turn it off in the inspector if you want only
   your markers.

The key is bound **only while recording**, so Ctrl+Alt+Z keeps working in other apps the rest of the
time. Change or clear it in **Settings > Shortcut Keys > Zoom marker (while recording)**. If another app
already owns the key, the recording still starts, the recorder says the hotkey is unavailable, and the
button and tray item still work.

## How it is stored

- While recording: `markers.jsonl` in the recording folder, one line per press,
  `{"t": <ms on the video clock>, "kind": "zoom", "x": <cursor x>, "y": <cursor y>}` (capture px, same
  clock and space as `events.jsonl`). The file exists only when at least one marker was dropped, and it
  is written line by line, so a crash keeps every marker already pressed. `events.jsonl` is unchanged.
- At Stop: the markers become `zoom.segments` in the new `project.json` (`id` `marker-1`, `marker-2`,
  ..., `auto: false`, scale = the default zoom 2x, focus = the cursor point). `recording.json` records
  the marker count.
- A recording folder with `markers.jsonl` but no `project.json` yet (a copied or salvaged recording) gets
  the same blocks when the editor opens it (`apps/editor/server/api.ts`).
- Recordings without markers produce exactly the same files as before.

Code: `packages/engine/src/markers.ts` (log format, markers -> zoom blocks), `apps/desktop/src/main/recording.ts`
(`marker()`, `markerSegmentsOf`), `apps/desktop/src/main/main.ts` (hotkey bound while recording, tray item),
recorder button / counter, Settings row, editor Zoom lane styling.

## Tests

- `apps/desktop/test/markers.test.ts` (vitest, 8): log round trip and a line cut off mid-write; blocks
  start at the marker (bound: within 1 frame at 60 fps), aimed at the logged cursor, end at the next
  marker / 3 s / the end of the recording, double tap dropped, focus clamped into the frame;
  `Recording.marker()` stamps the press on the video clock between the times read just before and after
  the call and at the cursor (bound 0.01 px), returns nothing before start and after stop; no markers =
  no file and no blocks.
- `apps/editor/e2e/zoomMarkers.spec.ts` (Playwright, web build, browser export path): a recording with
  two markers opens with two blocks at the marker times (bound ±1 frame), the plan's camera starts moving
  within 1 frame of each marker and is at >= 1.9x 1.2 s later; in the exported MP4 the marked point sits
  at the centre of the screen (bound 4 px) and the sample's dot covers 3.2-4.8x the pixels it covers
  unzoomed.

**Linux-tested only.** The global hotkey itself (Electron `globalShortcut` on Windows / macOS) was not
pressed in an end-to-end run; it needs a check on Windows. Not built: the "hold a key to suppress
click zooms" modifier from the same request.
