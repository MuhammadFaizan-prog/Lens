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
