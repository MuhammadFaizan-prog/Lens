import type { Rect } from "./types.js";
import type { ProjectConfig } from "./project.js";

/**
 * Framing (fix/aspect-framing-014): which part of the recording fills a canvas whose aspect differs
 * from it (a 16:9 recording on a 9:16 canvas).
 *  - "fit":    the whole recording, letterboxed and centred inside the padding (the default);
 *  - "fill":   the canvas is covered, the recording is cropped to the canvas shape, centred;
 *  - "follow": fill, and the crop window pans with the cursor / zoom target (the camera spring);
 *  - "custom": fill with a crop window the user places (output.framingRect, source px), its aspect
 *              locked to the canvas.
 *
 * Old projects carry no output.framing: their mode is derived from output.fit ("fill" = follow, which
 * is what fit "fill" always drew), so they render exactly as before (Rules.md §4, docs/Editor.md).
 */
export type FramingMode = "fit" | "fill" | "follow" | "custom";
export const FRAMING_MODES: readonly FramingMode[] = ["fit", "fill", "follow", "custom"];

export function framingMode(output: Pick<ProjectConfig["output"], "fit" | "framing">): FramingMode {
  const f = output.framing;
  if (f && (FRAMING_MODES as readonly string[]).includes(f)) return f;
  return output.fit === "fill" ? "follow" : "fit";
}

/** The largest window of `aspect` (w / h) inside `crop`, centred, in whole source px. */
export function fillWindow(crop: Rect, aspect: number): Rect {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : crop.w / crop.h;
  let w = crop.w;
  let h = w / a;
  if (h > crop.h) {
    h = crop.h;
    w = h * a;
  }
  const W = Math.max(2, Math.min(crop.w, Math.round(w)));
  const H = Math.max(2, Math.min(crop.h, Math.round(h)));
  return { x: crop.x + Math.round((crop.w - W) / 2), y: crop.y + Math.round((crop.h - H) / 2), w: W, h: H };
}

/**
 * A custom window (source px) made valid for `crop` and the canvas `aspect`: the aspect is locked
 * about the window's centre keeping its area, it is shrunk to fit inside the crop, then moved inside
 * it. No (or an invalid) rect = the Fill window. Whole px.
 */
export function customWindow(crop: Rect, aspect: number, rect: Rect | null | undefined): Rect {
  if (!rect || ![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) || !(rect.w > 0 && rect.h > 0)) return fillWindow(crop, aspect);
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : rect.w / rect.h;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  let w = Math.sqrt(rect.w * rect.h * a);
  let h = w / a;
  // never larger than the crop allows at this aspect
  const max = fillWindow(crop, a);
  if (w > max.w || h > max.h) {
    w = max.w;
    h = max.h;
  }
  // and at least 16 source px on the short side
  const minShort = Math.min(16, max.w, max.h);
  if (Math.min(w, h) < minShort) {
    const k = minShort / Math.min(w, h);
    w *= k;
    h *= k;
  }
  const W = Math.max(2, Math.min(crop.w, Math.round(w)));
  const H = Math.max(2, Math.min(crop.h, Math.round(h)));
  const x = Math.min(crop.x + crop.w - W, Math.max(crop.x, Math.round(cx - W / 2)));
  const y = Math.min(crop.y + crop.h - H, Math.max(crop.y, Math.round(cy - H / 2)));
  return { x, y, w: W, h: H };
}

/**
 * The part of the (cropped) source a Follow frame shows: the screen rect (output px, covering the
 * canvas, see fillScreenRect) and the camera viewport [x0, x0 + vw] x [y0, y0 + vh] mapped back to
 * cropped-source px. Used by tests and the overlay; the renderer draws the screen rect itself.
 */
export function visibleWindow(screen: Rect, out: { width: number; height: number }, view: { x0: number; vw: number; y0: number; vh: number }): Rect {
  const kx = screen.w / view.vw;
  const ky = screen.h / view.vh;
  const x0 = Math.max(0, -screen.x);
  const y0 = Math.max(0, -screen.y);
  const x1 = Math.min(screen.w, out.width - screen.x);
  const y1 = Math.min(screen.h, out.height - screen.y);
  return { x: view.x0 + x0 / kx, y: view.y0 + y0 / ky, w: (x1 - x0) / kx, h: (y1 - y0) / ky };
}

// ------------------------------------------------------------------ Follow: keep cursor and target (demand #15)

/** Share of the window kept clear on each side around the points Follow keeps in frame. */
export const FOLLOW_MARGIN = 0.06;

/**
 * The fixed zoom target Follow keeps in frame at source time `t` and how strongly (0..1): the active
 * fixed-focus zoom's target, or, while the camera is still zooming back out after one, that target,
 * weighted by how far the camera is zoomed into it (full from half way: 2 (scale - 1) / (zoom scale - 1)), so the requirement
 * grows and fades with the zoom instead of jumping at its edges.
 */
export function followTargetAt(segments: Array<{ startMs: number; endMs: number; scale: number; focus: { x: number; y: number } | "follow" }>, t: number, camScale: number): { x: number; y: number; w: number } | null {
  let active: (typeof segments)[number] | null = null;
  let last: (typeof segments)[number] | null = null;
  for (const s of segments) {
    if (t >= s.startMs && t < s.endMs) active = s;
    if (s.endMs <= t && (!last || s.endMs >= last.endMs)) last = s;
  }
  const s = active ?? last;
  if (!s || s.focus === "follow" || !(s.scale > 1)) return null;
  if (active === null && segments.some((x) => x.startMs >= s.endMs && x.startMs <= t)) return null;
  // full weight once the camera is half way in: the target is held in frame for the zoom's whole hold
  const w = Math.max(0, Math.min(1, (2 * (camScale - 1)) / (s.scale - 1)));
  return w > 1e-4 ? { x: s.focus.x, y: s.focus.y, w } : null;
}

export interface FollowView {
  x0: number;
  vw: number;
  y0: number;
  vh: number;
}

/**
 * One Follow frame (fill, panned): the screen rect for the canvas, and a camera override when the
 * window has to reach outside the zoom's viewport. The window is the Fill window centred on the pan
 * focus `focus`; when that leaves the cursor (or the zoom target, weighted in from the cursor by
 * `target.w`) within FOLLOW_MARGIN of an edge or outside, the window moves the least that brings them
 * in, and if both cannot fit it widens (the screen shrinks, background shows) until they do. A frame
 * that already holds them is drawn exactly as before (`fillScreenRect`), so old projects only change
 * where the cursor used to leave the frame.
 */
export function followFrame(
  out: { width: number; height: number },
  src: { width: number; height: number },
  view: FollowView,
  focus: { x: number; y: number },
  cursor: { x: number; y: number } | null,
  target: { x: number; y: number; w: number } | null,
  fallback: () => Rect,
): { screen: Rect; cam: { cx: number; cy: number; scale: number } | null } {
  if (!cursor) return { screen: fallback(), cam: null };
  const W = out.width;
  const H = out.height;
  const aspect = W / H;
  const sa = src.width / src.height;
  const coverW = Math.max(H * sa, W);
  const coverH = coverW / sa;
  const Fw = (W / coverW) * view.vw;
  const Fh = (H / coverH) * view.vh;
  const pts = [cursor];
  if (target) pts.push({ x: cursor.x + (target.x - cursor.x) * target.w, y: cursor.y + (target.y - cursor.y) * target.w });
  const rx0 = Math.min(...pts.map((p) => p.x));
  const rx1 = Math.max(...pts.map((p) => p.x));
  const ry0 = Math.min(...pts.map((p) => p.y));
  const ry1 = Math.max(...pts.map((p) => p.y));
  const m = FOLLOW_MARGIN;
  // the old window: Fill size, centred on the focus, clamped inside the camera viewport
  const oldCx = Math.min(view.x0 + view.vw - Fw / 2, Math.max(view.x0 + Fw / 2, focus.x));
  const oldCy = Math.min(view.y0 + view.vh - Fh / 2, Math.max(view.y0 + Fh / 2, focus.y));
  const holds = (cx: number, cy: number, ww: number, wh: number) =>
    rx0 >= cx - ww * (0.5 - m) - 1e-6 && rx1 <= cx + ww * (0.5 - m) + 1e-6 && ry0 >= cy - wh * (0.5 - m) - 1e-6 && ry1 <= cy + wh * (0.5 - m) + 1e-6;
  if (holds(oldCx, oldCy, Fw, Fh)) return { screen: fallback(), cam: null };
  // widen only as much as the points need
  let ww = Math.max(Fw, (rx1 - rx0) / (1 - 2 * m), ((ry1 - ry0) / (1 - 2 * m)) * aspect);
  let wh = ww / aspect;
  if (wh < Fh) {
    wh = Fh;
    ww = wh * aspect;
  }
  const place = (old: number, lo: number, hi: number, size: number, extent: number) => {
    // least move from the old centre that holds the points, then inside the recording when it fits
    let c = Math.min(Math.max(old, hi - size * (0.5 - m)), lo + size * (0.5 - m));
    if (size <= extent) c = Math.min(extent - size / 2, Math.max(size / 2, c));
    else c = extent / 2;
    return c;
  };
  const cx = place(oldCx, rx0, rx1, ww, src.width);
  const cy = place(oldCy, ry0, ry1, wh, src.height);
  // the camera viewport must contain the window (inside the recording)
  const wx0 = Math.max(0, cx - ww / 2), wx1 = Math.min(src.width, cx + ww / 2);
  const wy0 = Math.max(0, cy - wh / 2), wy1 = Math.min(src.height, cy + wh / 2);
  let v = view;
  let cam: { cx: number; cy: number; scale: number } | null = null;
  if (wx0 < view.x0 - 1e-6 || wx1 > view.x0 + view.vw + 1e-6 || wy0 < view.y0 - 1e-6 || wy1 > view.y0 + view.vh + 1e-6) {
    const scale0 = src.width / view.vw;
    const scale = Math.max(1, Math.min(scale0, src.width / (wx1 - wx0), src.height / (wy1 - wy0)));
    const vw = src.width / scale;
    const vh = src.height / scale;
    let ccx = Math.min(Math.max(view.x0 + view.vw / 2, wx1 - vw / 2), wx0 + vw / 2);
    let ccy = Math.min(Math.max(view.y0 + view.vh / 2, wy1 - vh / 2), wy0 + vh / 2);
    ccx = Math.min(src.width - vw / 2, Math.max(vw / 2, ccx));
    ccy = Math.min(src.height - vh / 2, Math.max(vh / 2, ccy));
    v = { x0: ccx - vw / 2, vw, y0: ccy - vh / 2, vh };
    cam = { cx: ccx, cy: ccy, scale };
  }
  const k = W / ww;
  return { screen: { x: W / 2 - (cx - v.x0) * k, y: H / 2 - (cy - v.y0) * k, w: v.vw * k, h: v.vh * k }, cam };
}
