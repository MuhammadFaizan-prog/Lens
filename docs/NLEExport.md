# Editor hand-off: overlay with alpha, FCPXML, EDL (demand #11)

Branch `feat/nle-export-015`. For people who finish videos in Final Cut Pro, DaVinci Resolve, Premiere or
After Effects: Lens exports what it draws over the recording as a transparent layer, and the edit as a
project file, so the screen recording, the cuts and the overlay line up frame for frame in the other editor.

## In the editor

**Export…** → **Editor hand-off** tab → **Export overlay + project files**. Progress shows on the button;
when it is done the tab lists the four files as downloads. They are also in the bundle under
`.lens-export/<id>/`:

| File | What it is |
|---|---|
| `overlay.mov` | ProRes 4444 with alpha (`prores_ks`, profile 4444, yuva444p10le input, 16-bit alpha; ffprobe reports yuva444p12le) |
| `overlay.webm` | VP9 with alpha (`libvpx-vp9`, yuva420p, `alpha_mode=1`) |
| `cuts.fcpxml` | FCPXML 1.9: one asset-clip of the screen recording per kept range, a gap per text slide, a `timeMap` on sped-up ranges, a marker per zoom ("Zoom 2.00x at 320,180" / "follow cursor"), the overlay as a connected clip on lane 1 over the whole edit |
| `cuts.edl` | CMX3600: one event per kept range (source in / out, record in / out, reel SCREEN), M2 lines for speed, each zoom as a `* LOC:` locator (Resolve reads them as markers) and a `* ZOOM` comment |

The overlay has the output size and frame rate and as many frames as the video export. It holds the click
effects, screen-anchored annotations and the cursor (through the virtual camera, so they follow zooms, and
clipped to the rounded screen card) and frame-anchored annotations, on transparent. It does not hold the
backdrop, shadow, screen, masks, webcam, captions (use the SRT / VTT export), shortcut pill, watermark or
slides. Put it on the track above the plain `screen.mp4` placed by the project file.

## How it works

- `POST /api/export-overlay { project }`: the server builds the plan with `editPieces: true` (adds
  `plan.pieces`, the edit timeline; ordinary plans are unchanged, no `pieces` key), writes `cuts.fcpxml`
  and `cuts.edl` (`toFcpxml` / `toEdl` in `packages/engine/src/nle.ts`) and starts ffmpeg reading PNG
  frames (`server/nleExport.ts`, one ffmpeg, two outputs).
- The editor draws every frame with the preview's renderer in overlay mode
  (`PlanRenderer.draw(..., { overlay: true })`, in the export worker, PNG with alpha) and posts them to
  `/api/export-browser/:id/frame` like the video export. No source frames are decoded and no Python runs:
  the desktop app's path, ffmpeg only.
- Every time in the project files is a whole output frame at the plan's fps, the same frames the video
  holds. Zooms come from the plan's zoom segments, cut to the kept ranges and moved onto the output clock.

## Tests

Bounds were set before each first run.

- Engine vitest `nle.test.ts` (5): a plan without `editPieces` is unchanged; clips match the plan's edit
  pieces within one frame (exact on the fixture); zooms cut to kept ranges; FCPXML and EDL carry the same
  cuts; slides are gaps, speed ranges get a `timeMap` and an M2 line. One test-code fix on the first run:
  the M2 regex assumed the wrong column spacing (the EDL line was right).
- Editor vitest `nleExport.test.ts` (1): the ffmpeg arguments (PNG in, ProRes 4444 + VP9 alpha out).
- Playwright `e2e/nleExport.spec.ts` (web build, 2026-11-11), through the Export dialog: overlay.mov
  prores / 4444 / yuva444p12le, 150 frames; overlay.webm vp9, alpha_mode 1, 150 frames; at frames
  10 / 40 / 50 / 100 / 140 the alpha around the plan's cursor position is 255 (bound >= 128) in both files,
  and every pixel more than 80 px away is 0 in the .mov (bound <= 2) and at most 4 in the .webm (bound
  <= 8); cuts.fcpxml well-formed, 3 clips; cuts.edl 3 events; every clip / event time within 0.0 ms of the
  kept ranges (bound 1 frame, 33.3 ms); one zoom marker and one zoom locator. One fixture fix after the
  first run: frame 60 had a click ripple on it (the check needs a frame without one), replaced by 50.
- Regression: `parity.spec.ts` (preview vs compositor) unchanged: sample mean 0.99573 / min 0.99408,
  annotations 0.99042 / 0.98289, brand 0.99295 / 0.98902; the Urdu case could not run here (its sample
  needs speech synthesis this sandbox lacks).

## Not done

- Import tested in Final Cut Pro, Resolve, Premiere (no licences here); only XML well-formedness, times and
  codecs are checked. FCPXML 1.9 `src` paths are absolute `file://` URLs to the bundle on this machine.
- Separate stems for the screen without cursor, the webcam (alpha cutout) and captions with alpha; zooms as
  keyframes (they are markers / locators now); a "no background" video export.
- 3D motion frames in the overlay go through the same 3D pass as the video; not measured.
- Annotations in the overlay are drawn by the same code as the video but are not in the e2e fixture.
- The Windows build's bundled ffmpeg must include `prores_ks` and `libvpx-vp9`; unverified on Windows.
