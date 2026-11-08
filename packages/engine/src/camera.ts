import { stepSpring, type SpringState } from "./spring.js";
import type { CursorSample } from "./cursor.js";
import type { RecordingMeta, Rect, SpringParams, Vec2, ZoomSegment } from "./types.js";

/** Virtual camera over the source screen for one frame (B01-B05, B09). */
export interface CameraSample {
  t: number;
  /** Viewport center in source px. */
  cx: number;
  cy: number;
  /** Magnification (1 = whole screen). */
  scale: number;
  /** Velocities for motion blur: px/s of the center and scale units/s. */
  vx: number;
  vy: number;
  vScale: number;
  /** Id of the zoom segment driving this frame, if any. */
  segment: string | null;
}

export interface CameraOptions {
  spring: SpringParams;
  /**
   * Follow deadzone: fraction of the viewport half-extent around the center inside which the
   * cursor can move without panning. 0 = always centered on cursor, 1 = pan only at the edge.
   */
  followDeadzone: number;
  /**
   * Region of the visible viewport (normalized 0..1 viewport coords) covered by an overlay such as
   * the webcam. Smart framing (B05) shifts the camera so the cursor never sits under it.
   */
  avoid?: Rect | null;
}

function clampCenter(c: Vec2, scale: number, meta: RecordingMeta): Vec2 {
  const halfW = meta.width / (2 * scale);
  const halfH = meta.height / (2 * scale);
  return {
    x: Math.min(meta.width - halfW, Math.max(halfW, c.x)),
    y: Math.min(meta.height - halfH, Math.max(halfH, c.y)),
  };
}

export function activeSegment(segments: ZoomSegment[], tMs: number): ZoomSegment | null {
  let found: ZoomSegment | null = null;
  for (const s of segments) if (tMs >= s.startMs && tMs < s.endMs) found = s; // later segments win
  return found;
}

/**
 * Simulate the camera at the cursor track's frame rate. Scale animates in log space so a 1x->2x
 * zoom and a 2x->4x zoom feel equally fast; the center animates in source px. After each step the
 * center is re-clamped against the current scale so the viewport never shows past the screen edge.
 */
export function buildCameraTrack(
  cursor: CursorSample[],
  segments: ZoomSegment[],
  meta: RecordingMeta,
  opts: CameraOptions,
): CameraSample[] {
  if (cursor.length === 0) return [];
  const dt = cursor.length > 1 ? cursor[1]!.t - cursor[0]!.t : 1000 / 60;
  const home: Vec2 = { x: meta.width / 2, y: meta.height / 2 };
  let ls: SpringState = { x: 0, v: 0 }; // log(scale)
  let sx: SpringState = { x: home.x, v: 0 };
  let sy: SpringState = { x: home.y, v: 0 };
  let follow: Vec2 = { ...home };
  let prevSeg: string | null = null;
  const out: CameraSample[] = [];

  for (let i = 0; i < cursor.length; i++) {
    const cur = cursor[i]!;
    const t = cur.t;
    const seg = activeSegment(segments, t);
    const targetScale = seg ? seg.scale : 1;
    let target: Vec2 = home;
    if (seg) {
      if (seg.focus === "follow") {
        if (seg.id !== prevSeg) follow = { x: cur.x, y: cur.y };
        const halfW = meta.width / (2 * targetScale);
        const halfH = meta.height / (2 * targetScale);
        const dzX = halfW * opts.followDeadzone;
        const dzY = halfH * opts.followDeadzone;
        const dx = cur.x - follow.x;
        const dy = cur.y - follow.y;
        if (Math.abs(dx) > dzX) follow.x += dx - Math.sign(dx) * dzX;
        if (Math.abs(dy) > dzY) follow.y += dy - Math.sign(dy) * dzY;
        target = follow;
      } else {
        target = seg.focus;
      }
      target = clampCenter(target, targetScale, meta);
      if (opts.avoid) target = avoidOverlay(target, { x: cur.x, y: cur.y }, targetScale, meta, opts.avoid);
    }
    prevSeg = seg ? seg.id : null;

    if (i === 0) {
      ls = { x: Math.log(targetScale), v: 0 };
      sx = { x: target.x, v: 0 };
      sy = { x: target.y, v: 0 };
    } else {
      ls = stepSpring(ls, Math.log(targetScale), dt, opts.spring);
      sx = stepSpring(sx, target.x, dt, opts.spring);
      sy = stepSpring(sy, target.y, dt, opts.spring);
    }
    const scale = Math.max(1, Math.exp(ls.x));
    const c = clampCenter({ x: sx.x, y: sy.x }, scale, meta);
    out.push({ t, cx: c.x, cy: c.y, scale, vx: sx.v, vy: sy.v, vScale: scale * ls.v, segment: seg ? seg.id : null });
  }
  return out;
}

/**
 * Smart framing (B05): if the cursor would land inside the overlay region of the viewport, shift the
 * camera center just enough that it clears the region (plus a small margin), then re-clamp.
 */
export function avoidOverlay(center: Vec2, cursor: Vec2, scale: number, meta: RecordingMeta, avoid: Rect): Vec2 {
  const vw = meta.width / scale;
  const vh = meta.height / scale;
  const left = center.x - vw / 2;
  const top = center.y - vh / 2;
  const u = (cursor.x - left) / vw;
  const v = (cursor.y - top) / vh;
  const margin = 0.04;
  const inside = u > avoid.x - margin && u < avoid.x + avoid.w + margin && v > avoid.y - margin && v < avoid.y + avoid.h + margin;
  if (!inside) return center;
  // Move horizontally or vertically, whichever needs the smaller shift.
  const shiftLeft = (u - (avoid.x - margin)) * vw; // move cursor left in view => move center right
  const shiftRight = (avoid.x + avoid.w + margin - u) * vw;
  const shiftUp = (v - (avoid.y - margin)) * vh;
  const shiftDown = (avoid.y + avoid.h + margin - v) * vh;
  const options = [
    { dx: shiftLeft, dy: 0 },
    { dx: -shiftRight, dy: 0 },
    { dx: 0, dy: shiftUp },
    { dx: 0, dy: -shiftDown },
  ].sort((a, b) => Math.abs(a.dx) + Math.abs(a.dy) - (Math.abs(b.dx) + Math.abs(b.dy)));
  for (const o of options) {
    const moved = clampCenter({ x: center.x + o.dx, y: center.y + o.dy }, scale, meta);
    const nu = (cursor.x - (moved.x - vw / 2)) / vw;
    const nv = (cursor.y - (moved.y - vh / 2)) / vh;
    const still = nu > avoid.x - margin && nu < avoid.x + avoid.w + margin && nv > avoid.y - margin && nv < avoid.y + avoid.h + margin;
    if (!still) return moved;
  }
  return center;
}

export function lerpCamera(a: CameraSample, b: CameraSample, u: number): CameraSample {
  return {
    t: a.t + (b.t - a.t) * u,
    cx: a.cx + (b.cx - a.cx) * u,
    cy: a.cy + (b.cy - a.cy) * u,
    scale: a.scale + (b.scale - a.scale) * u,
    vx: a.vx + (b.vx - a.vx) * u,
    vy: a.vy + (b.vy - a.vy) * u,
    vScale: a.vScale + (b.vScale - a.vScale) * u,
    segment: u < 0.5 ? a.segment : b.segment,
  };
}
