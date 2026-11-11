# Cursor that matches the UI (demand #12)

Clean-room, Lens's own design and cursor art (no product was decompiled or copied; the need comes from
the public demand evidence in `research/demand/demand-report.md` #12). Lens draws its own cursor
over a cursorless capture, so without help it shows the arrow everywhere, even where the real screen
showed a hand over a link or an I-beam over a text field. Now the drawn cursor takes the type the UI
showed under it, in the editor preview, the browser export the desktop app uses and the Python
reference compositor.

## Where the types come from

Lowest priority first (`packages/engine/src/cursorShapes.ts`):

1. **Recorded.** The desktop recorder logs `{"t": .., "type": "cursor-shape", "shape": ..}` lines in
   `events.jsonl` on the video clock. On Windows a PowerShell child (`apps/desktop/src/main/cursorType.ts`,
   no native module) loads the standard system cursors (`LoadCursor IDC_*`) and polls `GetCursorInfo`
   every ~15 ms, printing the cursor's IDC id when it changes; main stamps it as it arrives. Arrow,
   hand, I-beam, busy / app-starting, crosshair, the four resize cursors, move and not-allowed map to
   Lens types; an app's own custom cursor reads as "unknown" and keeps the previous type.
   macOS and Linux log no types yet (no system API reachable without a native module).
2. **Inferred** (no types logged and *Match UI hover* on). A deliberately conservative guess from the
   input alone: the I-beam over a spot the user clicked and then typed at least 2 keys into within
   2.5 s (a text field), from the moment the cursor came within 16 px of the click (at most 800 ms
   before it) until it moves 24 px away or clicks elsewhere. Nothing else is guessed: a click on a
   native Windows button shows the arrow and a link shows the hand, and the log cannot tell them apart.
3. **Set by you.** Per-segment overrides (`overrides[].cursor.shape`) from the editor; they win over
   everything.

A change of type is drawn as a 100 ms crossfade (smoothstep): the old type fades out under the new
one at the same hotspot. The plan carries it on the frames inside a swap only:
`cur = [x, y, opacity, scale, shape, fromShape, mix]` (otherwise the usual 5 fields).

## Types and art

`arrow, pointer (hand), text (I-beam), grab, grabbing, crosshair, resize-ew, resize-ns, resize-nwse,
resize-nesw, move, wait (busy, an hourglass), not-allowed`. Arrow, hand and I-beam are the original
Lens sprites (pixel-identical); the others are outline + fill primitives
(`apps/editor/src/render/cursorSprite.ts SHAPE_PRIMS`, mirrored in `compositor/lens_compositor/render.py`).

## Project settings

```json
"cursor": {"matchHover": true, "theme": "light"},
"overrides": [{"startMs": 5250, "endMs": 6250, "cursor": {"shape": "grab"}}]
```

| Key | Meaning |
|---|---|
| `cursor.matchHover` | `true`: recorded types, else inferred ones, crossfaded. `false`: the arrow throughout (overrides still apply). Absent (projects made before this): recorded types only with the old hard swap, so old projects plan and render exactly as before. New desktop recordings set `true`. |
| `cursor.theme` | `classic` (white outline, dark fill; default) or `light` (dark outline, white fill). Applies to every type. |
| `cursor.shape` | unchanged: `system` follows the types above; a fixed shape wins everywhere. |
| `overrides[].cursor.shape` | the type in that source range, whatever was logged or inferred. |

## Editor

Inspector → **Cursor** tab → **Cursor type**:

- **Match UI hover** switch, with where the types come from ("from recording" / "guessed" / "arrow only").
- **Theme**: Classic (dark) / Light.
- **At playhead**: set a type from the playhead to the end of its segment.
- One row per segment (time range, click to jump there): a select with *Auto · <type>* and every type,
  and a tag (*recorded*, *guessed*, *set by you*). Picking a type stores an override for that range
  (an overlapping older choice is trimmed, never stacked); *Auto* removes it. Each change is one undo step.

## Tests

- `packages/engine/test/cursorShapes.test.ts`: plans of 4 projects without the feature (no types,
  logged types, fixed shape, cursor overrides without a shape) hash-identical to main 7d1a5db
  (`cursorShapesGolden.ts`); inference; priority; overrides; crossfade length and monotonic mix.
- `apps/editor/test/cursorOps.test.ts`: override add / split / clear, art for every type.
- `apps/desktop/test/cursorType.test.ts`: IDC mapping, the poller's line protocol, `cursor-shape` log lines.
- `tests/test_cursor_types.py`: Python art distinct per type; light theme swaps the fill.
- e2e `apps/editor/e2e/cursorTypes.spec.ts` (`LENS_EXPORT=browser`, optional `LENS_MAIN_URL` = an editor
  built from main for the identity check): see `docs/Tracker.md` for the measured numbers.

## Not done

- Logged types on macOS / Linux (needs a native module or a helper per platform); Windows logging is
  unit-tested only, not run on a real Windows machine yet.
- Hover-state timing ("UI-locked smoothing" in the demand report: the smoothed cursor exactly on the
  real position at each hover change) is a separate piece of work.
- An animated busy cursor (the hourglass is static) and per-app custom cursor art.
