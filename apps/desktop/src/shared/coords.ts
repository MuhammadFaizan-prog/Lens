/**
 * Screen coordinate mapping for the recorder (docs/Desktop.md, "Coordinates").
 *
 * Three spaces meet here:
 *  - DIP: Electron's screen API (`screen.getCursorScreenPoint`, `Display.bounds`). Logical pixels.
 *  - Physical: the OS's device pixels. uiohook-napi reports mouse events in physical pixels on
 *    Windows (the process is per-monitor DPI aware) and in X11 pixels on Linux.
 *  - Capture: pixels of the recorded video frame (what the engine calls source px).
 *
 * Each display has a DIP rect and a physical rect. On Windows with mixed DPI the DIP rects of
 * different displays do not line up with their physical rects by one global factor, so every
 * conversion goes through the display that contains the point: physical = physOrigin +
 * (dip - dipOrigin) * scaleFactor. The capture frame can be smaller than the display's physical size
 * (capture constraints, or a downscaled stream), so capture = (physical - physOrigin) * capW / physW.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayGeom {
  id: number;
  /** DIP bounds (Electron Display.bounds). */
  bounds: Rect;
  scaleFactor: number;
  /**
   * Physical bounds in OS device pixels. On Windows: screen.dipToScreenRect(null, bounds). Elsewhere
   * (X11): bounds * scaleFactor, which is what physicalBoundsOf() computes when this is absent.
   */
  physical?: Rect;
}

export interface CaptureSize {
  width: number;
  height: number;
}

export function physicalBoundsOf(d: DisplayGeom): Rect {
  if (d.physical) return d.physical;
  const s = d.scaleFactor;
  return { x: Math.round(d.bounds.x * s), y: Math.round(d.bounds.y * s), width: Math.round(d.bounds.width * s), height: Math.round(d.bounds.height * s) };
}

function inside(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height;
}

function distSq(p: Point, r: Rect): number {
  const dx = p.x < r.x ? r.x - p.x : p.x >= r.x + r.width ? p.x - (r.x + r.width - 1) : 0;
  const dy = p.y < r.y ? r.y - p.y : p.y >= r.y + r.height ? p.y - (r.y + r.height - 1) : 0;
  return dx * dx + dy * dy;
}

/** The display whose DIP rect holds p (nearest one when p falls in a gap between displays). */
export function displayAtDip(p: Point, displays: DisplayGeom[]): DisplayGeom {
  if (!displays.length) throw new Error("no displays");
  return displays.find((d) => inside(p, d.bounds)) ?? displays.reduce((a, b) => (distSq(p, b.bounds) < distSq(p, a.bounds) ? b : a));
}

/** The display whose physical rect holds p (nearest one in a gap). */
export function displayAtPhysical(p: Point, displays: DisplayGeom[]): DisplayGeom {
  if (!displays.length) throw new Error("no displays");
  return displays.find((d) => inside(p, physicalBoundsOf(d))) ?? displays.reduce((a, b) => (distSq(p, physicalBoundsOf(b)) < distSq(p, physicalBoundsOf(a)) ? b : a));
}

/** DIP screen point -> physical screen point, through the display that contains it. */
export function dipToPhysical(p: Point, displays: DisplayGeom[]): Point {
  const d = displayAtDip(p, displays);
  const ph = physicalBoundsOf(d);
  return { x: ph.x + (p.x - d.bounds.x) * d.scaleFactor, y: ph.y + (p.y - d.bounds.y) * d.scaleFactor };
}

/** Physical screen point -> capture px of the recorded display (may fall outside the frame: off this display). */
export function physicalToCapture(p: Point, captured: DisplayGeom, capture: CaptureSize): Point {
  const ph = physicalBoundsOf(captured);
  return { x: ((p.x - ph.x) * capture.width) / ph.width, y: ((p.y - ph.y) * capture.height) / ph.height };
}

/** DIP screen point -> capture px of the recorded display. */
export function dipToCapture(p: Point, displays: DisplayGeom[], captured: DisplayGeom, capture: CaptureSize): Point {
  return physicalToCapture(dipToPhysical(p, displays), captured, capture);
}

export function inFrame(p: Point, capture: CaptureSize): boolean {
  return p.x >= 0 && p.y >= 0 && p.x < capture.width && p.y < capture.height;
}

/**
 * Where a click lands in capture px. The hook's point is preferred (sub-DIP precise); the cursor poll
 * at the same moment cross-checks it. If they disagree by more than `tolerance` capture px, the hook
 * point is not in the physical space we assume (a DPI-unaware hook thread reports DIPs on Windows),
 * so the hook point is tried as a DIP point, and failing that the poll is used.
 */
export function resolveClickPoint(
  hook: Point | null,
  polledDip: Point | null,
  displays: DisplayGeom[],
  captured: DisplayGeom,
  capture: CaptureSize,
  tolerance = 3,
): { point: Point; source: "hook" | "hook-dip" | "poll" } | null {
  const fromPoll = polledDip ? dipToCapture(polledDip, displays, captured, capture) : null;
  if (hook) {
    const asPhys = physicalToCapture(hook, captured, capture);
    // the poll is whole DIPs, so allow one DIP of rounding on top of the tolerance
    const slack = tolerance + captured.scaleFactor * (capture.width / physicalBoundsOf(captured).width);
    if (!fromPoll || Math.hypot(asPhys.x - fromPoll.x, asPhys.y - fromPoll.y) <= slack) return { point: asPhys, source: "hook" };
    const asDip = dipToCapture(hook, displays, captured, capture);
    if (Math.hypot(asDip.x - fromPoll.x, asDip.y - fromPoll.y) <= slack) return { point: asDip, source: "hook-dip" };
  }
  return fromPoll ? { point: fromPoll, source: "poll" } : null;
}

/** The Electron display a desktopCapturer screen source belongs to (source.display_id; fallback: index). */
export function displayForSource(displayId: string | undefined, sourceId: string, displays: DisplayGeom[]): DisplayGeom | null {
  if (displayId) {
    const d = displays.find((x) => String(x.id) === displayId);
    if (d) return d;
  }
  // "screen:<index>:0" on platforms that leave display_id empty
  const m = /^screen:(\d+):/.exec(sourceId);
  if (m && displays.length === 1) return displays[0]!;
  if (m) return displays[Number(m[1])] ?? null;
  return null;
}
