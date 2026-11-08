import type { InputEvent, RecordingMeta, Rect, Vec2, ZoomSegment } from "./types.js";

/**
 * Source crop (LOOK-14). The engine works entirely in cropped space: event positions, zoom focus
 * points and mask rects are shifted by the crop origin and the recording size becomes the crop
 * size, so camera clamping, auto-zoom fitting and cursor math need no crop awareness at all.
 * The compositor slices the crop out of each source frame before the camera transform.
 */

/** Clamp a crop to the source, rounded to whole px. null crop means the full source. */
export function normalizeCrop(crop: Rect | null | undefined, meta: Pick<RecordingMeta, "width" | "height">): Rect {
  if (!crop) return { x: 0, y: 0, w: meta.width, h: meta.height };
  const x = Math.max(0, Math.min(meta.width - 2, Math.round(crop.x)));
  const y = Math.max(0, Math.min(meta.height - 2, Math.round(crop.y)));
  const w = Math.max(2, Math.min(meta.width - x, Math.round(crop.w)));
  const h = Math.max(2, Math.min(meta.height - y, Math.round(crop.h)));
  return { x, y, w, h };
}

export function isFullFrame(crop: Rect, meta: Pick<RecordingMeta, "width" | "height">): boolean {
  return crop.x === 0 && crop.y === 0 && crop.w === meta.width && crop.h === meta.height;
}

export function toCropSpace(p: Vec2, crop: Rect): Vec2 {
  return { x: p.x - crop.x, y: p.y - crop.y };
}

export function fromCropSpace(p: Vec2, crop: Rect): Vec2 {
  return { x: p.x + crop.x, y: p.y + crop.y };
}

/** True when a cropped-space point lies inside the crop. */
export function insideCrop(p: Vec2, crop: Rect): boolean {
  return p.x >= 0 && p.y >= 0 && p.x <= crop.w && p.y <= crop.h;
}

export function cropEvents(events: InputEvent[], crop: Rect): InputEvent[] {
  if (crop.x === 0 && crop.y === 0) return events;
  return events.map((e) => ("x" in e ? { ...e, x: e.x - crop.x, y: e.y - crop.y } : e));
}

export function cropMeta(meta: RecordingMeta, crop: Rect): RecordingMeta {
  return { ...meta, width: crop.w, height: crop.h };
}

/**
 * Events the auto-zoom planner should see: clicks outside the crop are dropped (a zoom toward a
 * point the viewer cannot see would just slam into the crop edge).
 */
export function zoomableEvents(events: InputEvent[], crop: Rect): InputEvent[] {
  return events.filter((e) => !((e.type === "down" || e.type === "up") && !insideCrop(e, crop)));
}

export function cropZoomSegments(segs: ZoomSegment[], crop: Rect): ZoomSegment[] {
  return segs.map((s) => (s.focus === "follow" ? s : { ...s, focus: toCropSpace(s.focus, crop) }));
}

export function cropRect(r: Rect, crop: Rect): Rect {
  return { x: r.x - crop.x, y: r.y - crop.y, w: r.w, h: r.h };
}
