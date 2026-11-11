# Transitions and enter / exit animations (demand #14)

Branch `feat/transitions-015`. One animation vocabulary for cut transitions, text slides, brand title
cards, the webcam overlay and annotations. Every field is optional: a project without them builds the
same plan as before (no `tr` on any frame, no slide `fx`), so old projects render identically.

## What the user gets

| Where | Control | Options |
|---|---|---|
| Look tab, **Cut transitions** | Style, Length (0.1-2 s), Easing, "Also on cleanup & retake cuts" | None, Crossfade, Push, Zoom through, Blur dip |
| Timeline, Cuts lane | chip inside each cut block (glyph of its transition; accent border when the cut has its own) opens a picker: Project default or any style | hidden on blocks narrower than 32 px; there the cut's right-click menu has **Transition…** with the same picker |
| Inspector, selected cut | Transition (Project default / style), Length, Easing | per-cut override |
| Text slide card, brand intro / outro card | Enter, Exit: Default (the old cross-fade), None, Fade, Slide up / down / left / right, Zoom, Blur; Length; Easing | |
| Webcam panel, **Enter / exit** | Enter, Exit: Default (grow / shrink), None, Fade, Pop, Slide, Scale; Length; Easing | where a layout segment shows or hides the webcam |
| Annotation inspector | In easing, Out easing (Default = the style's own curve) | |

Easings everywhere: Linear, Ease in, Ease out, Ease in-out, Spring (about 16% overshoot).
Every change is one undo step.

## Project fields

- `transitions: { kind, durationMs, easing, scope: "manual" | "all" }`: default for cut joins.
- `edits.cuts[i].transition: { kind?, durationMs?, easing? }`: per-cut override (any field given wins).
- `slides[i].enter / exit`, `brand.intro / outro.enter / exit`: `{ kind, ms, easing? }`.
- `camera.enter / exit`: `{ kind, ms, easing? }`.
- `annotations[i].in / out.easing`.

## How a cut transition renders

A join is where the edit timeline jumps in source time (two neighbouring pieces, no gap on the output
clock). Frames within ±d/2 of the join carry `tr = { kind, u, other, incoming }` in the plan: eased
progress `u`, and the output index of the other side of the join, **held still** (the first incoming
frame for outgoing frames, the last outgoing frame for incoming ones). The renderer draws both frames
whole and composites them; no cut-away material is shown and the output length does not change. The
duration is clamped to the shorter neighbouring piece so windows never overlap; transitions under 40 ms
are dropped.

Layers (`transitionLayers` in `packages/engine/src/transitions.ts`, outgoing A, incoming B drawn over A,
on black):

- Crossfade: B alpha u.
- Push: A shifted by -u·W, B by (1-u)·W.
- Zoom through: A scaled 1 + 0.35u, B alpha u and scaled 1 + 0.15(1-u).
- Blur dip: both blurred by 2.5% of the short side × sin(πu); B fades in over u 0.3..0.7 (smoothstep).

Slide `fx = [dx, dy, scale, blur]` (output px) is the slide's enter / exit transform.

## The three renderers

- **Editor preview and browser export** (`apps/editor/src/render/renderer.ts`, `export/exportWorker.ts`):
  the shipped desktop path (no Python). The export worker loads the other side's source frame as well.
- **Python reference compositor** (`compositor/lens_compositor/render.py`): `draw_frame` draws one plan
  frame; a frame with `tr` is drawn twice, the held side's source frame from a second decoder
  (`HeldFrames`, which keeps each wanted frame from when it passes it until its last use, so the
  incoming side's request back in source time needs no re-decode), then `composite_transition`. Slides
  with `fx` are drawn alone (premultiplied, from a black and a white pass), transformed, blurred and laid
  over.

## Tests

Bounds were set before each first run.

- Engine vitest `transitions.test.ts` (+ golden), editor vitest `transitionOps.test.ts`.
- Playwright `apps/editor/e2e/transitions.spec.ts` (web build, `LENS_EXPORT=browser`): UI picker (Look
  tab, chip menu, selection card), 48 transition frames, crossfade midpoint error 0.38% preview / 1.17%
  export (bound 10%), preview vs export mean |RGB| 1 / 2 / 1 / 1.97 / 2.1 for crossfade / push / zoom /
  blur / slide enter (bound 12), no-transition plan byte-identical after setting everything back.
- pytest `tests/test_transitions.py` (Python compositor, same fixture, frames before the encode):
  48 `tr` frames; every frame outside a transition byte-identical to the same plan without `tr`;
  crossfade midpoint 0.38% (bound 10%), every crossfade frame within 0.44% of the luma span of
  (1-u)A + uB (bound 5%); push left minus right = 1.0 × span (bound 0.6), push frame equals the shifted
  sides with mean error 0 (bound 2 levels); zoom / blur dip 0.50 × span away from both sides (bound 0.2);
  slide enter dy 180 px, video above, red slide band below; a plan without transitions renders
  byte-identically with main's compositor (7d1a5db) and this one.
- `editor.spec.ts` after the chip fix (2026-11-11, web build): both snapping tests pass with the chip in
  place (the chip sits inside the cut block, clear of the 7 px trim handles). Whole file with
  `LENS_EXPORT=browser`: 12/14. The two failures are not from this branch: "inspector changes update the
  render immediately" clicks a "Backdrop Ember" button that no longer exists in the editor (the
  background picker replaced it, on main too), and "export renders an MP4 through the compositor"
  expects the compositor path; run on that path (`LENS_EXPORT=compositor`) it passes.

## Not done

- Render-time overhead vs no transitions (demand report's "under 5%") not measured.
- A/B viewer test with real users.
- Transitions on Windows: unverified (Linux web build only).
