# Camera scenes (demand #18)

Clean-room, Lens's own design (no product was decompiled or copied; the idea comes from the public
demand evidence in `research/demand/demand-report.md` #18: camera-only cuts, camera moved / resized
per part of the video). A **scene** is a range of the recording that switches the webcam layout:
screen only, camera full frame, side by side, or picture-in-picture in a chosen corner, each with its
own transition.

## In the editor

- **Timeline > Scenes lane** (under Speed): **+** (or double-click the lane) adds a scene at the
  playhead, 3 s long or up to the next scene. A new scene is **Camera full**. Adding one to a recording
  that has a camera turns **Show webcam** on, so the scene shows. Scene blocks move, trim (edges snap to
  the playhead and other blocks), multi-select, duplicate and delete like any other block, one undo step
  each. Blocks are labelled with their layout ("Camera full", "Side by side", "PiP ↖", "Screen only").
  Without a camera the lane says *No camera in this recording*; with the webcam off it says scenes show
  when it is on.
- **Selected scene card** (top of the inspector):
  - **Layout**: Screen only / Camera full / Side by side / PiP.
  - **Corner** (PiP only): Top left / Top right / Bottom left / Bottom right, or *Webcam tab* (the
    project corner or the bubble's dragged position).
  - **Transition**: 0 – 2 s (default: the Webcam tab's Transition). The layout eases in over it when
    the scene starts and back out when it ends; 0 cuts. Where two scenes touch, the entering scene's
    transition is used.
  - Warnings when the recording has no camera or the webcam is off (with **Turn webcam on**).
- **Webcam tab > Scenes**: what scenes do, the list of scenes (click one to select it and jump to it),
  **Add scene at playhead**, and the default **Transition** for scenes without their own.
- **On the preview**: inside a PiP scene, dragging the webcam bubble snaps it to the corner it is
  dropped nearest (that scene's corner). Camera-full and side-by-side scenes own their slot and are
  not dragged. Outside scenes the bubble drags freely as before.

## Data

Scenes are `project.camera.layouts` (the layout segments the engine already had), with two optional
fields and an id:

```json
{ "id": "scene-…", "startMs": 2500, "endMs": 3500, "kind": "camera-overlay", "corner": "top-left", "transitionMs": 250 }
```

`kind` is `screen-only` | `fullscreen-camera` | `split` | `camera-overlay` (PiP) | `camera-cutout`
(older projects). `corner` and `transitionMs` are validated (`camera.layouts[].corner must be a
corner`, `transitionMs` 0..5000). Absent fields keep the old meaning (project corner / free position,
`camera.transitionMs`), so **old projects plan byte-identically** (engine vitest, below).

`layoutAt` (`packages/engine/src/layout.ts`) lays a scene out with its own corner and transition, and
returns the corner so the zoom shrink (`camera.zoomedSize`) stays anchored in the scene's corner
(`plan.ts`). Because scenes are plan data (per-frame camera / screen rects), the preview, the in-app
(browser) export used by the shipped desktop app and the Python reference export draw the same thing.

## Tests

- Engine vitest `packages/engine/test/cameraScenes.test.ts` (9): six old-style projects (no layouts;
  split; every kind back to back with a top-left project corner; overlapping 9:16 with no transition;
  free position + zoom shrink; webcam off) plan **byte-identically** to 7d1a5db's engine (sha256 of the
  plan JSON, golden values produced by running `cameraScenesCases.ts` against that engine); a scene
  corner replaces the project corner (and a dragged position) inside the scene only; per-scene
  transition timing (midpoint exactly halfway, holds after, used on the way out); 0 cuts; the entering
  scene's transition wins; a corner-only change animates; `sceneAt`; the zoom shrink stays in the
  scene's corner (≤ 0.02 px drift after the entry transition); validation.
- Editor vitest `apps/editor/test/sceneOps.test.ts` (4): add / move / trim / duplicate / select-all /
  delete on `camera.layouts`, sorted, unique ids; kind / corner / transition edits (corner dropped for
  non-PiP, transition clamped 0..2 s, *Webcam tab* removes the field); webcam turned on only with a
  camera.
- Playwright `apps/editor/e2e/cameraScenes.spec.ts` (bounds in the file, set before the first run):
  four scenes built through the Scenes lane **+**, edge trims and the scene card, then preview vs export
  at each scene and at a transition midpoint. Measured numbers in the Tracker row.

## Not done / known limits

- **Hide when silent** (`camera.hideDuringSilence`, the rest of demand #18) is still not wired: scenes
  are placed by hand.
- No per-scene camera size or crop (the Webcam tab's size and crop apply in every scene).
- Transitions are the layout ease (rects glide, opacity fades); no other transition styles here.
- A camera-only *recording mode* in the recorder is not built.
- Windows / macOS unverified; measured on the Linux sandbox only.
