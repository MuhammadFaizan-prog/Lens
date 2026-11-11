import { OneEuroFilter, DEFAULT_ONE_EURO } from "./oneEuro.js";
import { stepSpring, type SpringState } from "./spring.js";
import { clicks, rawCursorAt } from "./events.js";
import type { CursorShape, InputEvent, RecordingMeta, SegmentOverride } from "./types.js";
import type { ProjectConfig } from "./project.js";
import { cursorShapeRuns, shapeAt, shapeSwapEnabled } from "./cursorShapes.js";

/** Per-frame cursor state produced by the engine and drawn by the compositor (C01-C07). */
export interface CursorSample {
  t: number;
  x: number;
  y: number;
  /** 0..1, drives idle fade (C05). */
  opacity: number;
  /** Multiplier on cursor size, < 1 while a button is held. */
  scale: number;
  shape: CursorShape;
  /** While the cursor type changes (demand #12): the type fading out, and how far the swap is (0..1). */
  fromShape?: CursorShape;
  mix?: number;
  /** Speed in source px/s, used for motion blur (C08). */
  speed: number;
}

export interface ClickEffect {
  t: number;
  x: number;
  y: number;
}

function smoothstep(u: number): number {
  const v = Math.min(1, Math.max(0, u));
  return v * v * (3 - 2 * v);
}

/**
 * Build the re-rendered cursor track. Pipeline:
 * raw log -> resample at fps -> One Euro prefilter (jitter) -> spring follower (glide, C01)
 * -> idle fade (C05) -> loop back to start (C06) -> press scale.
 * The spring target looks ahead by about a third of its settle time so the smoothed cursor still
 * reaches click points on time (clicks render at their true position).
 */
/** The cursor part of the override active at source time t (later overrides win per field). */
export function cursorOverrideAt(overrides: SegmentOverride[], tMs: number): { hidden: boolean; smoothing: boolean | null; size: number | null } {
  const out = { hidden: false, smoothing: null as boolean | null, size: null as number | null };
  for (const o of overrides) {
    if (!o.cursor || tMs < o.startMs || tMs >= o.endMs) continue;
    if (o.cursor.hidden !== undefined) out.hidden = o.cursor.hidden;
    if (o.cursor.smoothing !== undefined) out.smoothing = o.cursor.smoothing;
    if (o.cursor.size !== undefined) out.size = o.cursor.size;
  }
  return out;
}

/** Blend time when a per-segment override switches smoothing or size, so nothing snaps. */
export const OVERRIDE_BLEND_MS = 120;

export function buildCursorTrack(
  events: InputEvent[],
  meta: RecordingMeta,
  cfg: ProjectConfig["cursor"],
  fps: number,
  overrides: SegmentOverride[] = [],
): CursorSample[] {
  const frames = Math.max(1, Math.ceil((meta.durationMs / 1000) * fps));
  const dt = 1000 / fps;
  const out: CursorSample[] = [];
  const fx = new OneEuroFilter(DEFAULT_ONE_EURO);
  const fy = new OneEuroFilter(DEFAULT_ONE_EURO);
  const spring = cfg.smoothing.spring;
  const zeta = spring.damping / (2 * Math.sqrt(spring.stiffness * spring.mass));
  const omega = Math.sqrt(spring.stiffness / spring.mass);
  // Lag of a critically damped follower to a ramp is ~2/omega; look ahead by that much.
  const lookaheadMs = cfg.smoothing.enabled ? Math.min(250, (2 * zeta * 1000) / omega) : 0;

  const downs = events.filter((e) => e.type === "down" || e.type === "up");
  const shapeRuns = cursorShapeRuns(events, meta.durationMs, cfg, overrides);
  const swap = shapeSwapEnabled(cfg, overrides);

  let sx: SpringState | null = null;
  let sy: SpringState | null = null;
  let lastMoveT = 0;
  let prevRaw: { x: number; y: number } | null = null;
  let opacity = 1;
  let rawW = 0; // weight of the raw (unsmoothed) position, ramps for smoothing-off overrides
  const sizeMuls: number[] = [];
  const blendStep = dt / OVERRIDE_BLEND_MS;

  for (let i = 0; i < frames; i++) {
    const t = i * dt;
    const raw = rawCursorAt(events, t) ?? { x: meta.width / 2, y: meta.height / 2 };
    const ahead = rawCursorAt(events, Math.min(meta.durationMs, t + lookaheadMs)) ?? raw;
    let tx = ahead.x;
    let ty = ahead.y;
    if (cfg.smoothing.enabled && cfg.smoothing.prefilter) {
      tx = fx.filter(tx, t);
      ty = fy.filter(ty, t);
    }
    if (sx === null || sy === null) {
      sx = { x: tx, v: 0 };
      sy = { x: ty, v: 0 };
    } else if (cfg.smoothing.enabled) {
      sx = stepSpring(sx, tx, dt, spring);
      sy = stepSpring(sy, ty, dt, spring);
    } else {
      sx = { x: raw.x, v: (raw.x - sx.x) / (dt / 1000) };
      sy = { x: raw.y, v: (raw.y - sy.x) / (dt / 1000) };
    }

    if (prevRaw && Math.hypot(raw.x - prevRaw.x, raw.y - prevRaw.y) > 1.5) lastMoveT = t;
    const recentClick = downs.some((d) => d.t <= t && t - d.t < cfg.idleMs);
    if (recentClick) lastMoveT = Math.max(lastMoveT, t);
    prevRaw = raw;

    const ov = cursorOverrideAt(overrides, t);
    const idle = cfg.hideWhenIdle && t - lastMoveT > cfg.idleMs;
    const targetOpacity = cfg.visible && !ov.hidden ? (idle ? 0 : 1) : 0;
    const rawTarget = cfg.smoothing.enabled && ov.smoothing === false ? 1 : 0;
    rawW = i === 0 ? rawTarget : rawTarget > rawW ? Math.min(rawTarget, rawW + blendStep) : Math.max(rawTarget, rawW - blendStep);
    const sizeTarget = ov.size !== null ? ov.size / cfg.size : 1;
    sizeMuls.push(sizeTarget);
    const stepO = cfg.fadeMs > 0 ? dt / cfg.fadeMs : 1;
    opacity = targetOpacity > opacity ? Math.min(targetOpacity, opacity + stepO) : Math.max(targetOpacity, opacity - stepO);

    let held = false;
    for (const d of downs) {
      if (d.t > t) break;
      held = d.type === "down";
    }
    const sh = shapeAt(shapeRuns, t, swap);

    const sample: CursorSample = {
      t,
      x: sx.x + (raw.x - sx.x) * rawW,
      y: sy.x + (raw.y - sy.x) * rawW,
      opacity,
      scale: held ? cfg.pressScale : 1,
      shape: sh.shape,
      speed: Math.hypot(sx.v, sy.v),
    };
    if (sh.from !== undefined) {
      sample.fromShape = sh.from;
      sample.mix = sh.mix;
    }
    out.push(sample);
  }

  // Ease the press scale so it is not a hard snap (about 80 ms each way).
  const pressFrames = Math.max(1, Math.round(80 / dt));
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1]!;
    const cur = out[i]!;
    const step = (1 - cfg.pressScale) / pressFrames;
    if (cur.scale < prev.scale) cur.scale = Math.max(cur.scale, prev.scale - step);
    else if (cur.scale > prev.scale) cur.scale = Math.min(cur.scale, prev.scale + step);
  }

  // Size overrides ramp linearly over OVERRIDE_BLEND_MS (centered box filter of the step targets).
  const half = Math.max(0, Math.round(OVERRIDE_BLEND_MS / dt / 2));
  for (let i = 0; i < out.length; i++) {
    let acc = 0;
    let n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(out.length - 1, i + half); j++) {
      acc += sizeMuls[j]!;
      n++;
    }
    out[i]!.scale *= acc / n;
  }

  if (cfg.loopToStart && out.length > 1) {
    const first = out[0]!;
    const loopFrames = Math.min(out.length - 1, Math.round(cfg.loopMs / dt));
    for (let k = 0; k < loopFrames; k++) {
      const idx = out.length - loopFrames + k;
      const s = out[idx]!;
      const u = smoothstep((k + 1) / loopFrames);
      s.x = s.x + (first.x - s.x) * u;
      s.y = s.y + (first.y - s.y) * u;
      s.opacity = Math.max(s.opacity, first.opacity * u);
    }
  }
  return out;
}

export function clickEffects(events: InputEvent[]): ClickEffect[] {
  return clicks(events);
}

/** Interpolate a fixed-rate track at an arbitrary time. */
export function sampleTrack<T extends { t: number }>(track: T[], tMs: number, lerp: (a: T, b: T, u: number) => T): T {
  if (track.length === 0) throw new Error("empty track");
  const first = track[0]!;
  if (tMs <= first.t) return first;
  const last = track[track.length - 1]!;
  if (tMs >= last.t) return last;
  const dt = track.length > 1 ? track[1]!.t - first.t : 1;
  const i = Math.min(track.length - 2, Math.floor((tMs - first.t) / dt));
  const a = track[i]!;
  const b = track[i + 1]!;
  return lerp(a, b, (tMs - a.t) / (b.t - a.t));
}

export function lerpCursor(a: CursorSample, b: CursorSample, u: number): CursorSample {
  const out: CursorSample = {
    t: a.t + (b.t - a.t) * u,
    x: a.x + (b.x - a.x) * u,
    y: a.y + (b.y - a.y) * u,
    opacity: a.opacity + (b.opacity - a.opacity) * u,
    scale: a.scale + (b.scale - a.scale) * u,
    shape: u < 0.5 ? a.shape : b.shape,
    speed: a.speed + (b.speed - a.speed) * u,
  };
  // crossfade between two cursor types: interpolate the mix when both samples are in the same swap
  if (a.fromShape !== undefined || b.fromShape !== undefined) {
    if (a.fromShape !== undefined && b.fromShape !== undefined && a.fromShape === b.fromShape && a.shape === b.shape) {
      out.shape = a.shape;
      out.fromShape = a.fromShape;
      out.mix = a.mix! + (b.mix! - a.mix!) * u;
    } else if (a.fromShape !== undefined && b.fromShape === undefined && a.shape === b.shape) {
      // the swap ends between the two samples
      out.shape = a.shape;
      out.fromShape = a.fromShape;
      out.mix = a.mix! + (1 - a.mix!) * u;
    } else if (a.fromShape === undefined && b.fromShape !== undefined && a.shape === b.fromShape) {
      // the swap starts between the two samples
      out.shape = b.shape;
      out.fromShape = b.fromShape;
      out.mix = b.mix! * u;
    } else {
      const n = u < 0.5 ? a : b;
      out.shape = n.shape;
      if (n.fromShape !== undefined) {
        out.fromShape = n.fromShape;
        out.mix = n.mix;
      }
    }
    if (out.mix !== undefined && out.mix >= 0.9999) {
      delete out.fromShape;
      delete out.mix;
    }
  }
  return out;
}
