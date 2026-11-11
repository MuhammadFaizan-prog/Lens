# Sharper text in zooms (demand #22)

When the camera zooms past 1.5x, small UI text is upscaled by the canvas's bilinear filter (preview,
browser export) or OpenCV's bicubic warp (Python reference) and goes soft. With **Sharpen text in
zooms** on, the screen is resampled from the source frame with a Lanczos-3 filter and then
unsharp-masked, so text edges stay crisp.

## Using it

Zoom tab -> **Sharpen zoomed text**:

- **Sharpen text in zooms** (toggle, `data-testid="zoom-sharpen"`): on / off.
- **Amount** (0-150 %, default 60 %, `zoom-sharpen-amount`): unsharp strength; disabled while off.

New desktop recordings start with it on (`apps/desktop/src/main/recording.ts`). Projects made before
this feature have no setting and render exactly as before. If the browser has no WebGL2 the Zoom tab
says so and zooms are drawn unsharpened.

## Project data

`project.zoom.sharpen = { enabled: boolean, amount: 0..1.5 }`, optional (absent = off). Validated in
`resolveProject`. The render plan gets `style.zoomSharpen = { amount }` only when it is on and the amount
is above 0, so every other plan is byte-identical to one made before the feature.

## How it renders

Same algorithm in both renderers:

1. **Ramp**: effective amount = amount x smoothstep((scale - 1.5) / 0.25): 0 at 1.5x and below, full
   from 1.75x, so nothing pops when a zoom passes the threshold. Frames at or below 1.5x take the old
   code path unchanged.
2. **Lanczos-3 resample** of the camera's source rect (the same pixel-centre mapping as the old
   bilinear / bicubic path), 6 x 6 taps, weights normalised, result **clamped to the 2 x 2 source
   pixels** around each sample (Lanczos' own overshoot beside hard edges can never leave the data).
3. **Unsharp mask**: c + amount x (c - 3x3 binomial blur), **clamped to the 3 x 3 neighbourhood
   range** (it steepens edges, it never paints a halo beside them).
4. While the camera moves fast enough for motion blur, the blurred view is only unsharp-masked (step 3).

| Path | Code |
|---|---|
| Preview + browser export (the desktop app's export, no Python) | `apps/editor/src/render/sharpen.ts` (WebGL2 `SharpenPass`), called from `PlanRenderer.drawScreen` |
| Python reference compositor (`/api/export`, `compositor/render.py`) | `compositor/lens_compositor/sharpen.py` (numpy / OpenCV), called from `render()` |

## Tests

- Engine `packages/engine/test/zoomSharpen.test.ts`: not in the defaults; off / amount 0 plans
  byte-identical to plans without the setting; on adds only `style.zoomSharpen`; validation.
- Editor `apps/editor/test/zoomSharpen.test.ts`: ramp values, Lanczos kernel, renderer only builds the
  WebGL pass for zoomed frames of a sharpened plan, passes the same source rect as `drawImage`,
  motion-blur frames get the unsharp-only pass.
- Python `tests/test_zoom_sharpen.py`: identity at 1x, exact pixel-centre mapping, no overshoot at a
  hard edge (OpenCV Lanczos-4 control does overshoot), unsharp clamp, >= 1.25x Laplacian variance on
  text-like strokes, and a full render where only frames above 1.5x change.
- Playwright `apps/editor/e2e/zoomSharpen.spec.ts` (sample `scripts/make_sharpen_sample.py`: 11 px UI
  text panel + black / white bars, fixed 2.5x zoom, 720p30). Bounds were set before the first run;
  results are in `docs/Tracker.md`.

## Not done

- No OCR accuracy test on zoomed text (the demand report's suggested test); sharpness is measured as
  Laplacian variance and ringing as overshoot beside hard edges.
- No learned super-resolution; this is a classical resampler + sharpener.
- Capture at native backing scale (the other half of the demand item) is a capture-side change and is
  not part of this branch.
- Unverified on Windows (WebGL2 in the packaged Electron app is expected but was not measured there).
