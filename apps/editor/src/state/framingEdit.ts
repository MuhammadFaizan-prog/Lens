/**
 * Custom framing edit view (fix/aspect-framing-014). While the user places the custom window the
 * preview shows the whole (user-cropped) recording, fitted and centred like Fit, with the window drawn
 * over it; the window is stored in source px (project.output.framingRect). Pure geometry, unit-tested
 * in test/framing.test.ts. The export never sees this view: it renders the plan as built.
 */
import { fittedCardRect, normalizeCrop } from "@lens/engine";
import type { PlanFrame, ProjectConfig, Rect, RenderPlan } from "@lens/engine";

type Size = { width: number; height: number };

/** Where the whole user crop sits on the canvas in the edit view (output px): Fit, centred. */
export function editViewRect(p: ProjectConfig, meta: Size, out: Size): Rect {
  const uc = normalizeCrop(p.crop, meta);
  return fittedCardRect(out, uc.w / Math.max(1, uc.h), p);
}

/** Source window (source px) -> its box in the edit view (output px). */
export function windowToBox(win: Rect, uc: Rect, view: Rect): Rect {
  const kx = view.w / uc.w;
  const ky = view.h / uc.h;
  return { x: view.x + (win.x - uc.x) * kx, y: view.y + (win.y - uc.y) * ky, w: win.w * kx, h: win.h * ky };
}

/** Edit-view box (output px) -> source window (source px), unrounded. */
export function boxToWindow(b: Rect, uc: Rect, view: Rect): Rect {
  const kx = uc.w / view.w;
  const ky = uc.h / view.h;
  return { x: uc.x + (b.x - view.x) * kx, y: uc.y + (b.y - view.y) * ky, w: b.w * kx, h: b.h * ky };
}

/**
 * Dragging the filled screen (Fill / Custom, output px): `b` is where the canvas-covering card was
 * dragged to (it started at 0, 0, W, H showing `win`). The window that leaves the canvas showing what
 * the dragged card shows: moving the picture right pans the window left, growing it zooms in.
 */
export function windowFromDraggedScreen(win: Rect, b: Rect, out: Size): Rect {
  const k = win.w / Math.max(1e-6, b.w); // source px per output px
  return { x: win.x - b.x * k, y: win.y - b.y * (win.h / Math.max(1e-6, b.h)), w: out.width * k, h: out.height * (win.h / Math.max(1e-6, b.h)) };
}

/**
 * The plan as the edit view draws it: frame i shows the whole user crop in `view`, unzoomed, without
 * the cursor, clicks, masks or screen annotations (they live in the window's cropped space).
 */
export function framingEditPlan(plan: RenderPlan, i: number, uc: Rect, view: Rect): RenderPlan {
  const f = plan.frames[i];
  if (!f) return plan;
  const { m3d: _flat, ...rest } = f;
  const ef: PlanFrame = {
    ...rest,
    cam: [uc.w / 2, uc.h / 2, 1],
    camVel: [0, 0, 0],
    cur: null,
    clicks: [],
    masks: [],
    annotations: f.annotations.filter((a) => a.space === "frame"),
    layout: { ...f.layout, screen: [view.x, view.y, view.w, view.h], screenOpacity: 1, camera: null, cameraOpacity: 0 },
  };
  const frames = plan.frames.slice();
  frames[i] = ef;
  if (i > 0) frames[i - 1] = ef;
  return { ...plan, source: { ...plan.source, crop: [uc.x, uc.y, uc.w, uc.h] }, frames };
}
