/**
 * Transitions and enter / exit animations (demand #14).
 *
 * - Cut transitions: where the edit timeline jumps (a cut join, the source is not continuous), the
 *   frames within ±d/2 of the join carry `tr` in the plan: the renderer draws the frame and the frame
 *   on the other side of the join (held still at the join, so no cut-away material is ever shown and
 *   the output length does not change) and composites them (crossfade, push, zoom-through, blur dip).
 *   Project-level `transitions` sets the default for cuts; a cut may override it (`transition`).
 * - One easing vocabulary for every animation: cut transitions, text slide / title card enter and exit,
 *   webcam enter and exit, and annotation in / out (`easing`).
 *
 * Every field is optional: a project without them builds a plan without `tr` or slide `fx`, so old
 * projects render exactly as before.
 */
import type { TimeRange } from "./types.js";
import type { TimelinePiece } from "./timeline.js";

export type Easing = "linear" | "ease-in" | "ease-out" | "ease-in-out" | "spring";
export const EASINGS: Easing[] = ["linear", "ease-in", "ease-out", "ease-in-out", "spring"];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Overshooting spring step from 0 to 1 over u = 0..1 (zeta 0.5, about 16% overshoot), landing on
 * exactly 1 at u = 1. Same curve as the annotation pop spring.
 */
function springStep(u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const z = 0.5;
  const w = 9;
  const wd = w * Math.sqrt(1 - z * z);
  const k = z / Math.sqrt(1 - z * z);
  const x = 1 - Math.exp(-z * w * u) * (Math.cos(wd * u) + k * Math.sin(wd * u));
  const r = Math.exp(-z * w) * (Math.cos(wd) + k * Math.sin(wd));
  return x + r * u * u;
}

/** Eased progress for u in 0..1 (clamped). ease-in-out is symmetric: ease(0.5) = 0.5. */
export function ease(kind: Easing | undefined, u: number): number {
  const v = clamp01(u);
  switch (kind) {
    case "linear":
      return v;
    case "ease-in":
      return v * v * v;
    case "ease-out":
      return 1 - (1 - v) ** 3;
    case "spring":
      return springStep(v);
    case "ease-in-out":
    default:
      return v < 0.5 ? 4 * v * v * v : 1 - (-2 * v + 2) ** 3 / 2;
  }
}

// ------------------------------------------------------------------------------ cut transitions

export type CutTransitionKind = "none" | "crossfade" | "push" | "zoom" | "blur";
export const CUT_TRANSITION_KINDS: CutTransitionKind[] = ["none", "crossfade", "push", "zoom", "blur"];

/** Project default for cut transitions (project.transitions). */
export interface TransitionsConfig {
  kind: CutTransitionKind;
  /** Whole transition length, centred on the cut (ms). Clamped so neighbouring windows never overlap. */
  durationMs: number;
  easing: Easing;
  /** manual = cuts on the Cuts lane (edits.cuts) only; all = also cleanup (filler / pause) and retake cuts. */
  scope: "manual" | "all";
}

/** A cut's own transition (edits.cuts[i].transition): any field given wins over the project default. */
export interface CutTransition {
  kind?: CutTransitionKind;
  durationMs?: number;
  easing?: Easing;
}

export function defaultTransitions(): TransitionsConfig {
  return { kind: "crossfade", durationMs: 500, easing: "ease-in-out", scope: "manual" };
}

/** The transition on one plan frame near a cut join. */
export interface PlanTransition {
  kind: Exclude<CutTransitionKind, "none">;
  /** Eased progress through the transition, 0 at its start (all outgoing) to 1 at its end (all incoming). */
  u: number;
  /** Output frame index of the other side of the join, held still: the first incoming frame, or the last outgoing one. */
  other: number;
  /** true when this frame is on the incoming side of the join (t >= join). */
  incoming: boolean;
}

export interface CutJoin {
  /** Output time of the join (ms). */
  outMs: number;
  /** Source time removed: [srcEnd of the outgoing piece, srcStart of the incoming piece). */
  cut: TimeRange;
  kind: Exclude<CutTransitionKind, "none">;
  durationMs: number;
  easing: Easing;
}

const MIN_TRANSITION_MS = 40;

/**
 * Cut joins of an edit timeline that get a transition. A join is two neighbouring pieces with no gap on
 * the output clock (a slide in between is not a join) and a jump in source time. The spec is the
 * overriding manual cut's, else the project default when the join removes a manual cut (or scope is
 * "all"). The duration is clamped to the shorter neighbouring piece so windows never overlap.
 */
export function cutJoins(pieces: TimelinePiece[], manualCuts: Array<TimeRange & { transition?: CutTransition | null }>, cfg: TransitionsConfig | undefined): CutJoin[] {
  const out: CutJoin[] = [];
  for (let i = 0; i + 1 < pieces.length; i++) {
    const a = pieces[i]!;
    const b = pieces[i + 1]!;
    if (Math.abs(a.outEnd - b.outStart) > 1e-6 || Math.abs(a.srcEnd - b.srcStart) < 1e-6) continue;
    const cut = { startMs: a.srcEnd, endMs: b.srcStart };
    const touching = manualCuts.filter((c) => c.endMs > cut.startMs - 1e-6 && c.startMs < cut.endMs + 1e-6);
    const own = touching.find((c) => c.transition && typeof c.transition === "object");
    if (!cfg && !own) continue;
    if (!own && touching.length === 0 && cfg?.scope !== "all") continue;
    const base = cfg ?? { ...defaultTransitions(), kind: "none" as CutTransitionKind };
    const kind = own?.transition?.kind ?? base.kind;
    if (kind === "none") continue;
    const want = own?.transition?.durationMs ?? base.durationMs;
    const room = Math.min(a.outEnd - a.outStart, b.outEnd - b.outStart);
    const durationMs = Math.min(want, room);
    if (!(durationMs >= MIN_TRANSITION_MS)) continue;
    out.push({ outMs: a.outEnd, cut, kind, durationMs, easing: own?.transition?.easing ?? base.easing });
  }
  return out;
}

/**
 * Transition state of output frame i (time t) for the given joins, or null. The window of a join J with
 * duration d is [J - d/2, J + d/2); the raw progress runs 0..1 across it.
 */
export function transitionAt(joins: CutJoin[], i: number, t: number, fps: number): PlanTransition | null {
  for (const j of joins) {
    const t0 = j.outMs - j.durationMs / 2;
    if (t < t0 - 1e-6 || t >= j.outMs + j.durationMs / 2 - 1e-6) continue;
    const first = Math.ceil((j.outMs * fps) / 1000 - 1e-6);
    const incoming = i >= first;
    const u = ease(j.easing, (t - t0) / j.durationMs);
    return { kind: j.kind, u: Math.round(u * 10000) / 10000, other: incoming ? first - 1 : first, incoming };
  }
  return null;
}

/**
 * How two frames are composited at eased progress u (shared by the editor renderer and its tests).
 * Outgoing frame A and incoming frame B, each drawn whole: alpha, scale about the centre, x offset as a
 * fraction of the width, and blur sigma as a fraction of the short side. B is drawn over A.
 */
export interface TransitionLayer {
  alpha: number;
  scale: number;
  dx: number;
  blur: number;
}

export function transitionLayers(kind: PlanTransition["kind"], u: number): { a: TransitionLayer; b: TransitionLayer } {
  const v = clamp01(u);
  switch (kind) {
    case "push":
      return { a: { alpha: 1, scale: 1, dx: -v, blur: 0 }, b: { alpha: 1, scale: 1, dx: 1 - v, blur: 0 } };
    case "zoom":
      // zoom-through: the outgoing frame flies towards the viewer and fades, the incoming one settles from slightly large
      return { a: { alpha: 1, scale: 1 + 0.35 * v, dx: 0, blur: 0 }, b: { alpha: v, scale: 1 + 0.15 * (1 - v), dx: 0, blur: 0 } };
    case "blur": {
      // blur dip: both blur towards the middle (peak 2.5% of the short side), the swap happens blurred
      const s = 0.025 * Math.sin(Math.PI * v);
      const w = clamp01((v - 0.3) / 0.4);
      return { a: { alpha: 1, scale: 1, dx: 0, blur: s }, b: { alpha: w * w * (3 - 2 * w), scale: 1, dx: 0, blur: s } };
    }
    case "crossfade":
    default:
      return { a: { alpha: 1, scale: 1, dx: 0, blur: 0 }, b: { alpha: v, scale: 1, dx: 0, blur: 0 } };
  }
}

export function validateTransitions(cfg: unknown, cuts: unknown[]): string[] {
  const errs: string[] = [];
  const spec = (v: Record<string, unknown>, n: string) => {
    if (v.kind !== undefined && !CUT_TRANSITION_KINDS.includes(v.kind as CutTransitionKind)) errs.push(`${n}.kind must be one of ${CUT_TRANSITION_KINDS.join(", ")}`);
    if (v.durationMs !== undefined && !(typeof v.durationMs === "number" && v.durationMs >= MIN_TRANSITION_MS && v.durationMs <= 4000)) errs.push(`${n}.durationMs must be within ${MIN_TRANSITION_MS}..4000`);
    if (v.easing !== undefined && !EASINGS.includes(v.easing as Easing)) errs.push(`${n}.easing must be one of ${EASINGS.join(", ")}`);
  };
  if (cfg !== undefined && cfg !== null) {
    if (typeof cfg !== "object" || Array.isArray(cfg)) errs.push("transitions must be {kind, durationMs, easing, scope}");
    else {
      const c = cfg as Record<string, unknown>;
      spec(c, "transitions");
      if (!CUT_TRANSITION_KINDS.includes(c.kind as CutTransitionKind) || typeof c.durationMs !== "number" || !EASINGS.includes(c.easing as Easing))
        errs.push("transitions needs kind, durationMs and easing");
      if (c.scope !== "manual" && c.scope !== "all") errs.push("transitions.scope must be manual or all");
    }
  }
  cuts.forEach((c, i) => {
    const tr = (c as { transition?: unknown })?.transition;
    if (tr === undefined || tr === null) return;
    if (typeof tr !== "object" || Array.isArray(tr)) errs.push(`edits.cuts[${i}].transition must be {kind?, durationMs?, easing?}`);
    else spec(tr as Record<string, unknown>, `edits.cuts[${i}].transition`);
  });
  return errs;
}

// ------------------------------------------------------------------------------ enter / exit

/** Enter / exit animation of a text slide or brand title card. */
export type SlideAnimKind = "none" | "fade" | "slide-up" | "slide-down" | "slide-left" | "slide-right" | "zoom" | "blur";
export const SLIDE_ANIM_KINDS: SlideAnimKind[] = ["none", "fade", "slide-up", "slide-down", "slide-left", "slide-right", "zoom", "blur"];

export interface ElementAnim<K extends string> {
  kind: K;
  ms: number;
  easing?: Easing;
}

/** Slide transform: offset (output px), scale about the frame centre, blur sigma (output px). */
export interface SlideFx {
  opacity: number;
  dx: number;
  dy: number;
  scale: number;
  blur: number;
}

/**
 * Slide state from one animation at visibility v (0 = hidden, 1 = settled; already eased).
 * slide-up enters moving up from below the frame (and exits continuing up, out the top).
 */
function slideAnim(kind: SlideAnimKind, v: number, W: number, H: number, entering: boolean, s: SlideFx): void {
  const away = 1 - v;
  const dir = entering ? 1 : -1;
  switch (kind) {
    case "fade":
      s.opacity *= v;
      break;
    case "slide-up":
      s.dy += dir * away * H;
      break;
    case "slide-down":
      s.dy -= dir * away * H;
      break;
    case "slide-left":
      s.dx += dir * away * W;
      break;
    case "slide-right":
      s.dx -= dir * away * W;
      break;
    case "zoom":
      s.scale *= 0.8 + 0.2 * v;
      s.opacity *= Math.min(1, Math.max(0, v));
      break;
    case "blur":
      s.blur += away * Math.min(W, H) * 0.03;
      s.opacity *= Math.min(1, Math.max(0, v));
      break;
    case "none":
      break;
  }
}

/**
 * Opacity and transform of a slide at tInSlide given its enter / exit (each falls back to the legacy
 * fadeMs cross-fade when absent). Both sides are shortened to half the slide when it is short.
 */
export function slideFx(
  sl: { durationMs: number; fadeMs: number; enter?: ElementAnim<SlideAnimKind> | null; exit?: ElementAnim<SlideAnimKind> | null },
  tInSlide: number,
  W: number,
  H: number,
): SlideFx {
  const half = sl.durationMs / 2;
  const legacy = Math.max(0, Math.min(sl.fadeMs, half));
  const s: SlideFx = { opacity: 1, dx: 0, dy: 0, scale: 1, blur: 0 };
  const side = (a: ElementAnim<SlideAnimKind> | null | undefined, local: number, entering: boolean) => {
    if (a) {
      const ms = a.kind === "none" ? 0 : Math.max(0, Math.min(a.ms, half));
      if (ms > 0 && local < ms) slideAnim(a.kind, ease(a.easing ?? "ease-out", local / ms), W, H, entering, s);
    } else if (legacy > 0 && local < legacy) {
      s.opacity *= 1 - (1 - clamp01(local / legacy)) ** 3;
    }
  };
  side(sl.enter, tInSlide, true);
  side(sl.exit, sl.durationMs - tInSlide, false);
  return s;
}

/** Webcam enter / exit (camera.enter / camera.exit): how the overlay appears and leaves. */
export type CameraAnimKind = "none" | "fade" | "pop" | "slide" | "scale";
export const CAMERA_ANIM_KINDS: CameraAnimKind[] = ["none", "fade", "pop", "slide", "scale"];

export function validateElementAnim(a: unknown, kinds: readonly string[], n: string): string[] {
  if (a === undefined || a === null) return [];
  if (typeof a !== "object" || Array.isArray(a)) return [`${n} must be {kind, ms, easing?}`];
  const v = a as Record<string, unknown>;
  const errs: string[] = [];
  if (!kinds.includes(v.kind as string)) errs.push(`${n}.kind must be one of ${kinds.join(", ")}`);
  if (!(typeof v.ms === "number" && v.ms >= 0 && v.ms <= 10000)) errs.push(`${n}.ms must be within 0..10000`);
  if (v.easing !== undefined && !EASINGS.includes(v.easing as Easing)) errs.push(`${n}.easing must be one of ${EASINGS.join(", ")}`);
  return errs;
}
