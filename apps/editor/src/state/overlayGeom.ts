/**
 * Pure geometry for on-canvas manipulation (Windows bugs #12 / #14): normalized overlay positions,
 * rect move / resize with handles, snapping, and the zoom rectangle <-> engine zoom target mapping.
 * Unit-tested in test/overlayGeom.test.ts.
 */
export interface Pt {
  x: number;
  y: number;
}
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type Corner = "nw" | "ne" | "sw" | "se";

/** Centre of a box in output px -> fractions of the output (what the project stores). */
export function toNorm(c: Pt, W: number, H: number): Pt {
  return { x: c.x / W, y: c.y / H };
}

/** Fractions of the output -> output px. */
export function fromNorm(n: Pt, W: number, H: number): Pt {
  return { x: n.x * W, y: n.y * H };
}

/** Normalized centre that keeps a w x h box fully inside a W x H frame. */
export function clampedNormCentre(c: Pt, w: number, h: number, W: number, H: number): Pt {
  const x = Math.min(W - w / 2, Math.max(w / 2, c.x));
  const y = Math.min(H - h / 2, Math.max(h / 2, c.y));
  return toNorm({ x, y }, W, H);
}

export function centre(b: Box): Pt {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

export function moveBox(b: Box, dx: number, dy: number): Box {
  return { ...b, x: b.x + dx, y: b.y + dy };
}

/**
 * Drag a corner handle to p. keepAspect keeps w/h (logo, webcam, zoom rect) with the opposite corner
 * fixed; minSize is the smallest width (and height) allowed.
 */
export function resizeBox(b: Box, h: Corner, p: Pt, keepAspect = false, minSize = 4): Box {
  const ax = h === "nw" || h === "sw" ? b.x + b.w : b.x; // anchor (opposite corner)
  const ay = h === "nw" || h === "ne" ? b.y + b.h : b.y;
  let w = Math.max(minSize, Math.abs(p.x - ax));
  let hh = Math.max(minSize, Math.abs(p.y - ay));
  if (keepAspect) {
    const r = b.w / b.h;
    // follow whichever axis the pointer moved further along, relative to the aspect
    if (w / r >= hh) hh = w / r;
    else w = hh * r;
  }
  const x = h === "nw" || h === "sw" ? ax - w : ax;
  const y = h === "nw" || h === "ne" ? ay - hh : ay;
  return { x, y, w, h: hh };
}

/**
 * resizeBox with Alt: the box grows about its centre (the dragged corner and its mirror move
 * together); keepAspect (Shift) keeps w/h. Without fromCentre this is resizeBox.
 */
export function resizeBoxFrom(b: Box, h: Corner, p: Pt, keepAspect = false, minSize = 4, fromCentre = false): Box {
  if (!fromCentre) return resizeBox(b, h, p, keepAspect, minSize);
  const c = centre(b);
  let w = Math.max(minSize, 2 * Math.abs(p.x - c.x));
  let hh = Math.max(minSize, 2 * Math.abs(p.y - c.y));
  if (keepAspect) {
    const r = b.w / b.h;
    if (w / r >= hh) hh = w / r;
    else w = hh * r;
  }
  return { x: c.x - w / 2, y: c.y - hh / 2, w, h: hh };
}

/** Frame snap lines: edges and centre, plus the rule-of-thirds lines when thirds is set (the screen card). */
export function snapLines(W: number, H: number, thirds = false): { xs: number[]; ys: number[] } {
  return thirds ? { xs: [0, W / 3, W / 2, (2 * W) / 3, W], ys: [0, H / 3, H / 2, (2 * H) / 3, H] } : { xs: [0, W / 2, W], ys: [0, H / 2, H] };
}

/** Snap a dragged corner point to the snap lines (resize); returns the point and guides hit. */
export function snapPoint(p: Pt, lines: { xs: number[]; ys: number[] }, threshold: number): { p: Pt; gx: number[]; gy: number[] } {
  const sx = snap1(p.x, lines.xs, threshold);
  const sy = snap1(p.y, lines.ys, threshold);
  return { p: { x: sx.v, y: sy.v }, gx: sx.at === null ? [] : [sx.at], gy: sy.at === null ? [] : [sy.at] };
}

/** Snap v to the nearest target within threshold; returns the value and the target hit (or null). */
export function snap1(v: number, targets: number[], threshold: number): { v: number; at: number | null } {
  let best: number | null = null;
  for (const t of targets) if (Math.abs(t - v) <= threshold && (best === null || Math.abs(t - v) < Math.abs(best - v))) best = t;
  return best === null ? { v, at: null } : { v: best, at: best };
}

/**
 * Snap a moving box to the frame's edges and centre lines (and its own edges / centre to them).
 * Returns the snapped box and the guide lines to draw (output px).
 */
export function snapBox(b: Box, W: number, H: number, threshold: number, thirds = false): { box: Box; gx: number[]; gy: number[] } {
  const { xs, ys } = snapLines(W, H, thirds);
  let dx = 0;
  let dy = 0;
  const gx: number[] = [];
  const gy: number[] = [];
  let bestX = threshold + 1;
  for (const [edge, val] of [["l", b.x], ["c", b.x + b.w / 2], ["r", b.x + b.w]] as const) {
    void edge;
    const s = snap1(val, xs, threshold);
    if (s.at !== null && Math.abs(s.v - val) < bestX) {
      bestX = Math.abs(s.v - val);
      dx = s.v - val;
      gx.splice(0, gx.length, s.at);
    }
  }
  let bestY = threshold + 1;
  for (const val of [b.y, b.y + b.h / 2, b.y + b.h]) {
    const s = snap1(val, ys, threshold);
    if (s.at !== null && Math.abs(s.v - val) < bestY) {
      bestY = Math.abs(s.v - val);
      dy = s.v - val;
      gy.splice(0, gy.length, s.at);
    }
  }
  return { box: moveBox(b, dx, dy), gx, gy };
}

// ------------------------------------------------------------------ zoom rectangle <-> engine target

/**
 * The engine's camera keeps the zoomed viewport inside the (cropped) screen: the centre is clamped to
 * [w/2s, W - w/2s]. The rectangle shows what the export will show, so it is clamped the same way.
 */
export function clampZoomCentre(c: Pt, scale: number, srcW: number, srcH: number): Pt {
  const hw = srcW / (2 * scale);
  const hh = srcH / (2 * scale);
  return { x: Math.min(srcW - hw, Math.max(hw, c.x)), y: Math.min(srcH - hh, Math.max(hh, c.y)) };
}

/** Viewport rectangle (source px, origin at the crop) of a zoom at `focus` and `scale`. */
export function zoomRect(focus: Pt, scale: number, srcW: number, srcH: number): Box {
  const s = Math.max(1, scale);
  const c = clampZoomCentre(focus, s, srcW, srcH);
  const w = srcW / s;
  const h = srcH / s;
  return { x: c.x - w / 2, y: c.y - h / 2, w, h };
}

/** Engine target of a rectangle: focus = its centre (clamped), scale = screen width / rect width. */
export function zoomTarget(r: Box, srcW: number, srcH: number, minScale = 1, maxScale = 8): { focus: Pt; scale: number } {
  const scale = Math.min(maxScale, Math.max(minScale, srcW / Math.max(1, r.w)));
  const c = clampZoomCentre(centre(r), scale, srcW, srcH);
  return { focus: { x: Math.round(c.x * 100) / 100, y: Math.round(c.y * 100) / 100 }, scale: Math.round(scale * 1000) / 1000 };
}
