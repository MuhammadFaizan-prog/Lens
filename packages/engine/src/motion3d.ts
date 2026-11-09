/**
 * 3D motion for the screen card (feat/motion-3d).
 *
 * A motion3d segment animates the whole screen card (screen + everything drawn inside it: masks,
 * clicks, screen-anchored annotations, cursor) through a rigid 3D transform seen through a pinhole
 * camera. The 2D zoom / camera still runs *inside* the card, so the two compose: zoom picks what the
 * card shows, motion3d moves the card.
 *
 * Conventions (shared by the editor's WebGL pass and compositor/lens_compositor/motion3d.py):
 *  - Card-local coordinates: output px relative to the untransformed card centre (ox, oy), x right,
 *    y DOWN, z toward the viewer.
 *  - p' = T + Rz(rz) * Ry(ry) * Rx(rx) * (s * p): scale, then rotate about X, then Y, then Z, then
 *    translate. Angles are degrees, unclamped (any finite value: -360..360 and beyond are fine).
 *      rx > 0 tilts the top edge away from the viewer; ry > 0 turns the right edge away; rz > 0 is
 *      clockwise on screen.
 *  - Translation: tx, ty are fractions of the output width / height; tz is px at 1080p (scaled
 *    with the output like the corner radius), > 0 toward the viewer.
 *  - Projection: the eye sits `perspective` px (at 1080p) in front of the card centre:
 *      k = d / (d - z), x_out = ox + x * k, y_out = oy + y * k.
 *    The denominator is clamped to >= 0.05 d so a point never crosses behind the eye.
 *
 * Segment times are source ms, like zoom segments, so cuts and speed ranges retime 3D motion the
 * same way they retime zooms (a 2x speed range plays the tilt twice as fast; a cut skips into it).
 *
 * Default: project.motion3d = [] and the plan emits no m3d field, so projects without 3D motion
 * render exactly as before (Rules.md §4: no default changed).
 */

export interface Pose3D {
  rx: number;
  ry: number;
  rz: number;
  tx: number;
  ty: number;
  tz: number;
  scale: number;
}

export type Easing3D = "spring" | "ease-in-out" | "ease-out" | "ease-in" | "linear" | "loop";
export const EASINGS_3D: Easing3D[] = ["spring", "ease-in-out", "ease-out", "ease-in", "linear", "loop"];

/** An interior keyframe: `at` is the fraction of the segment (0 < at < 1). */
export interface Motion3DKey {
  at: number;
  pose: Partial<Pose3D>;
  /** Easing of the span that ends at this key (default: the segment's easing). */
  easing?: Easing3D;
}

export interface Motion3DSegment {
  id: string;
  /** Source ms. */
  startMs: number;
  endMs: number;
  /** Template id it was made from ("custom" for hand-built, "user:<id>" for a saved template). */
  template: string;
  /** Pose at the start (missing fields = identity). */
  from: Partial<Pose3D>;
  /** Pose at the end. */
  to: Partial<Pose3D>;
  /** Extra keyframes between from and to (0 -> 90 -> 180 style). Ignored by "loop". */
  keys?: Motion3DKey[];
  /**
   * Easing per span. "loop" oscillates from <-> to with periodMs, axes out of phase (rx, tx, ty...
   * on sine, ry, tz on cosine) so rx/ry drift on an ellipse; give it blendMs to ease in and out.
   */
  easing: Easing3D;
  /** Eye distance in px at 1080p. */
  perspective: number;
  /** Keep the final pose after endMs until the next segment starts. */
  hold?: boolean;
  /** Blend in from (and, without hold, out to) the flat card over this many ms. */
  blendMs?: number;
  /** Loop period (easing "loop"). */
  periodMs?: number;
  /** What a card turned past 90 degrees shows: "card" = its back (a plain rounded card), "front" = the screen again, reading correctly (a card flip). */
  backface?: "card" | "front";
}

export interface Motion3DTemplate {
  id: string;
  name: string;
  durationMs: number;
  from: Partial<Pose3D>;
  to: Partial<Pose3D>;
  keys?: Motion3DKey[];
  easing: Easing3D;
  perspective: number;
  hold?: boolean;
  blendMs?: number;
  periodMs?: number;
  backface?: "card" | "front";
  /** Saved by the user (stored in the editor's local library). */
  user?: boolean;
}

export const IDENTITY_POSE: Pose3D = { rx: 0, ry: 0, rz: 0, tx: 0, ty: 0, tz: 0, scale: 1 };
export const POSE_KEYS: (keyof Pose3D)[] = ["rx", "ry", "rz", "tx", "ty", "tz", "scale"];
export const DEFAULT_PERSPECTIVE = 2000;
export const BACK_COLOR = "#26262d";

/** Built-in templates. Durations and easing are design choices (no measurement yet). */
export const MOTION3D_TEMPLATES: Motion3DTemplate[] = [
  { id: "custom", name: "Custom", durationMs: 1500, from: {}, to: {}, easing: "ease-in-out", perspective: DEFAULT_PERSPECTIVE },
  { id: "tilt-in", name: "Tilt in", durationMs: 1000, from: { rx: 25 }, to: {}, easing: "spring", perspective: DEFAULT_PERSPECTIVE },
  { id: "tilt-out", name: "Tilt out", durationMs: 1000, from: {}, to: { rx: 25 }, easing: "ease-in-out", perspective: DEFAULT_PERSPECTIVE, hold: true },
  { id: "swing-left", name: "Swing left", durationMs: 1100, from: { ry: 35 }, to: {}, easing: "spring", perspective: DEFAULT_PERSPECTIVE },
  { id: "swing-right", name: "Swing right", durationMs: 1100, from: { ry: -35 }, to: {}, easing: "spring", perspective: DEFAULT_PERSPECTIVE },
  { id: "perspective-reveal", name: "Perspective reveal", durationMs: 1600, from: { rx: 55, tz: -700, ty: 0.08 }, to: {}, easing: "spring", perspective: DEFAULT_PERSPECTIVE },
  { id: "flip", name: "Flip", durationMs: 1400, from: {}, to: { ry: 360 }, easing: "ease-in-out", perspective: DEFAULT_PERSPECTIVE, backface: "front" },
  { id: "flip-reveal", name: "Flip reveal", durationMs: 1300, from: { ry: 180 }, to: {}, easing: "ease-in-out", perspective: DEFAULT_PERSPECTIVE, backface: "card" },
  { id: "roll", name: "Roll", durationMs: 900, from: { rz: -8, scale: 0.94 }, to: {}, easing: "spring", perspective: DEFAULT_PERSPECTIVE },
  { id: "float", name: "Float", durationMs: 6000, from: { rx: 5, ry: -6 }, to: { rx: -5, ry: 6 }, easing: "loop", periodMs: 4000, blendMs: 700, perspective: DEFAULT_PERSPECTIVE },
  { id: "push-in", name: "Push in 3D", durationMs: 1300, from: { tz: -450, rx: 12 }, to: {}, easing: "spring", perspective: DEFAULT_PERSPECTIVE },
  { id: "isometric", name: "Isometric hold", durationMs: 3000, from: { rx: 30, rz: -30, scale: 0.8 }, to: { rx: 30, rz: -30, scale: 0.8 }, easing: "linear", blendMs: 600, perspective: 4000 },
  { id: "dolly-up", name: "Dolly up", durationMs: 1300, from: { ty: 0.14, rx: 20 }, to: {}, easing: "spring", perspective: DEFAULT_PERSPECTIVE },
];

export function motion3dTemplate(id: string, extra: Motion3DTemplate[] = []): Motion3DTemplate | undefined {
  return [...MOTION3D_TEMPLATES, ...extra].find((t) => t.id === id);
}

/** A new segment from a template, starting at startMs (source ms). */
export function segmentFromTemplate(t: Motion3DTemplate, startMs: number, id: string): Motion3DSegment {
  const s: Motion3DSegment = {
    id,
    startMs: Math.round(startMs),
    endMs: Math.round(startMs + t.durationMs),
    template: t.user ? `user:${t.id}` : t.id,
    from: { ...t.from },
    to: { ...t.to },
    easing: t.easing,
    perspective: t.perspective,
  };
  if (t.keys?.length) s.keys = t.keys.map((k) => ({ ...k, pose: { ...k.pose } }));
  if (t.hold) s.hold = true;
  if (t.blendMs) s.blendMs = t.blendMs;
  if (t.periodMs) s.periodMs = t.periodMs;
  if (t.backface) s.backface = t.backface;
  return s;
}

/** A template from a segment ("Save as template"). */
export function templateFromSegment(s: Motion3DSegment, id: string, name: string): Motion3DTemplate {
  const t: Motion3DTemplate = { id, name, durationMs: s.endMs - s.startMs, from: { ...s.from }, to: { ...s.to }, easing: s.easing, perspective: s.perspective, user: true };
  if (s.keys?.length) t.keys = s.keys.map((k) => ({ ...k, pose: { ...k.pose } }));
  if (s.hold) t.hold = true;
  if (s.blendMs) t.blendMs = s.blendMs;
  if (s.periodMs) t.periodMs = s.periodMs;
  if (s.backface) t.backface = s.backface;
  return t;
}

export function fullPose(p: Partial<Pose3D> | undefined): Pose3D {
  return { ...IDENTITY_POSE, ...(p ?? {}) };
}

export function lerpPose(a: Pose3D, b: Pose3D, u: number): Pose3D {
  const o = {} as Pose3D;
  for (const k of POSE_KEYS) o[k] = a[k] + (b[k] - a[k]) * u;
  return o;
}

export function isIdentityPose(p: Pose3D): boolean {
  return Math.abs(p.rx) < 1e-4 && Math.abs(p.ry) < 1e-4 && Math.abs(p.rz) < 1e-4 && Math.abs(p.tx) < 1e-6 && Math.abs(p.ty) < 1e-6 && Math.abs(p.tz) < 1e-3 && Math.abs(p.scale - 1) < 1e-6;
}

const SPRING_Z = 0.7;
const SPRING_W = 10;
function springRaw(v: number): number {
  const wd = SPRING_W * Math.sqrt(1 - SPRING_Z * SPRING_Z);
  return 1 - Math.exp(-SPRING_Z * SPRING_W * v) * (Math.cos(wd * v) + ((SPRING_Z * SPRING_W) / wd) * Math.sin(wd * v));
}
const SPRING_END = springRaw(1);

/** Easing curve 0..1 -> value (the spring overshoots ~4.6% and lands exactly on 1). */
export function ease3d(e: Easing3D, v: number): number {
  const u = v <= 0 ? 0 : v >= 1 ? 1 : v;
  switch (e) {
    case "linear":
    case "loop":
      return u;
    case "ease-in":
      return u * u * u;
    case "ease-out":
      return 1 - (1 - u) ** 3;
    case "ease-in-out":
      return u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
    case "spring":
      return u >= 1 ? 1 : springRaw(u) + (1 - SPRING_END) * u;
  }
}

const smooth = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

/** The keyframe list of a segment: from at 0, interior keys sorted, to at 1. */
export function segmentKeys(s: Motion3DSegment): Array<{ at: number; pose: Pose3D; easing: Easing3D }> {
  const inner = (s.keys ?? []).filter((k) => k.at > 0 && k.at < 1).sort((a, b) => a.at - b.at);
  return [
    { at: 0, pose: fullPose(s.from), easing: s.easing },
    ...inner.map((k) => ({ at: k.at, pose: fullPose(k.pose), easing: k.easing ?? s.easing })),
    { at: 1, pose: fullPose(s.to), easing: s.easing },
  ];
}

const LOOP_SIN: Record<keyof Pose3D, boolean> = { rx: true, ry: false, rz: true, tx: true, ty: true, tz: false, scale: true };

/** Pose of a segment at source time src, without blend (src clamped into the segment). */
export function segmentPoseAt(s: Motion3DSegment, src: number): Pose3D {
  const dur = Math.max(1, s.endMs - s.startMs);
  const local = Math.max(0, Math.min(dur, src - s.startMs));
  if (s.easing === "loop") {
    const a = fullPose(s.from);
    const b = fullPose(s.to);
    const ph = (2 * Math.PI * local) / Math.max(100, s.periodMs ?? 4000);
    const o = {} as Pose3D;
    for (const k of POSE_KEYS) {
      const mid = (a[k] + b[k]) / 2;
      const half = (b[k] - a[k]) / 2;
      o[k] = mid + half * (LOOP_SIN[k] ? Math.sin(ph) : -Math.cos(ph));
    }
    return o;
  }
  const keys = segmentKeys(s);
  const u = local / dur;
  let i = 0;
  while (i < keys.length - 2 && u >= keys[i + 1]!.at) i++;
  const a = keys[i]!;
  const b = keys[i + 1]!;
  const v = b.at > a.at ? (u - a.at) / (b.at - a.at) : 1;
  return lerpPose(a.pose, b.pose, ease3d(b.easing, v));
}

export interface Motion3DState {
  pose: Pose3D;
  perspective: number;
  backface: "card" | "front";
  seg: string;
}

/** The 3D pose of the card at source time src, or null when flat (identity). */
export function motion3dAt(segments: Motion3DSegment[], src: number): Motion3DState | null {
  if (!segments.length) return null;
  let active: Motion3DSegment | null = null;
  for (const s of segments) if (src >= s.startMs && src < s.endMs && (!active || s.startMs >= active.startMs)) active = s;
  let pose: Pose3D;
  let seg: Motion3DSegment;
  if (active) {
    seg = active;
    pose = segmentPoseAt(seg, src);
    const bl = seg.blendMs ?? 0;
    if (bl > 0) {
      let w = smooth((src - seg.startMs) / bl);
      if (!seg.hold) w = Math.min(w, smooth((seg.endMs - src) / bl));
      pose = lerpPose(IDENTITY_POSE, pose, w);
    }
  } else {
    // a held pose: the last segment that ended before src with hold, unless another started since
    let held: Motion3DSegment | null = null;
    for (const s of segments) if (s.hold && s.endMs <= src && (!held || s.endMs > held.endMs)) held = s;
    if (!held) return null;
    if (segments.some((s) => s !== held && s.startMs >= held!.endMs && s.startMs <= src)) return null;
    seg = held;
    pose = segmentPoseAt(held, held.endMs);
  }
  if (isIdentityPose(pose)) return null;
  return { pose, perspective: seg.perspective, backface: seg.backface ?? "card", seg: seg.id };
}

/** Resolved per-frame transform in output px (what PlanFrame.m3d carries). */
export interface Motion3DFrame {
  /** rx, ry, rz (deg), tx, ty, tz (output px), scale. */
  pose: [number, number, number, number, number, number, number];
  /** Eye distance, output px. */
  d: number;
  /** Projection origin = untransformed card centre, output px. */
  o: [number, number];
  /** Projected card corners TL, TR, BR, BL (output px) of the integer card rect the renderers draw. */
  quad: [number, number, number, number, number, number, number, number];
  /** "front": draw the screen texture on quad; "back": draw the plain card back. */
  face: "front" | "back";
  /** true when the quad was relabelled so the front reads correctly past 90 degrees (backface "front"). */
  mirrored?: "x" | "y";
}

/** Rotate + translate a card-local point; returns [x, y, z] in card-local 3D (before projection). */
export function transformPoint(m: Pick<Motion3DFrame, "pose">, x: number, y: number): [number, number, number] {
  const [rx, ry, rz, tx, ty, tz, s] = m.pose;
  let X = x * s;
  let Y = y * s;
  let Z = 0;
  const a = (rx * Math.PI) / 180;
  const b = (ry * Math.PI) / 180;
  const c = (rz * Math.PI) / 180;
  // Rx
  let y1 = Y * Math.cos(a) - Z * Math.sin(a);
  let z1 = Y * Math.sin(a) + Z * Math.cos(a);
  Y = y1;
  Z = z1;
  // Ry
  const x2 = X * Math.cos(b) + Z * Math.sin(b);
  const z2 = -X * Math.sin(b) + Z * Math.cos(b);
  X = x2;
  Z = z2;
  // Rz
  const x3 = X * Math.cos(c) - Y * Math.sin(c);
  y1 = X * Math.sin(c) + Y * Math.cos(c);
  X = x3;
  Y = y1;
  z1 = Z;
  return [X + tx, Y + ty, z1 + tz];
}

/** Project an output-px point of the untransformed card (absolute coords) through the transform. */
export function project3d(m: Pick<Motion3DFrame, "pose" | "d" | "o">, px: number, py: number): [number, number] {
  const [X, Y, Z] = transformPoint(m, px - m.o[0], py - m.o[1]);
  const k = m.d / Math.max(m.d - Z, 0.05 * m.d);
  return [m.o[0] + X * k, m.o[1] + Y * k];
}

/** Python's round() (banker's rounding), as the renderers round the screen rect. */
function pyRound(v: number): number {
  const f = Math.floor(v);
  const d = v - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Signed area of a quad (shoelace); > 0 = front facing in y-down coordinates (clockwise TL TR BR BL). */
export function quadArea(q: number[]): number {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    a += q[2 * i]! * q[2 * j + 1]! - q[2 * j]! * q[2 * i + 1]!;
  }
  return a / 2;
}

/** Corners of rect (x, y, w, h) projected: TL, TR, BR, BL. */
export function projectRect(m: Pick<Motion3DFrame, "pose" | "d" | "o">, x: number, y: number, w: number, h: number): [number, number, number, number, number, number, number, number] {
  const pts = [project3d(m, x, y), project3d(m, x + w, y), project3d(m, x + w, y + h), project3d(m, x, y + h)];
  return pts.flat() as [number, number, number, number, number, number, number, number];
}

/** Bring an angle to [-180, 180). */
const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

/**
 * Resolve a pose to a plan frame for the card at screen rect (output px, as in layout.screen).
 * tx / ty fractions are scaled by the output size, tz and perspective by resScale.
 */
export function motion3dFrame(st: Motion3DState, screen: [number, number, number, number], out: { width: number; height: number }, resScale: number): Motion3DFrame {
  const sx = pyRound(screen[0]);
  const sy = pyRound(screen[1]);
  const sw = Math.max(2, pyRound(screen[2]));
  const sh = Math.max(2, pyRound(screen[3]));
  const p = st.pose;
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  const m: Motion3DFrame = {
    pose: [r3(p.rx), r3(p.ry), r3(p.rz), r3(p.tx * out.width), r3(p.ty * out.height), r3(p.tz * resScale), Math.round(p.scale * 1e5) / 1e5],
    d: r3(Math.max(100, st.perspective) * resScale),
    o: [sx + sw / 2, sy + sh / 2],
    quad: [0, 0, 0, 0, 0, 0, 0, 0],
    face: "front",
  };
  let q = projectRect(m, sx, sy, sw, sh);
  if (quadArea(q) < 0) {
    if (st.backface === "front") {
      // relabel: show the front mirrored back so it reads correctly (a card flip). Mirror across the
      // axis whose rotation is further past 90 degrees.
      const ax = Math.abs(wrap180(p.rx));
      const ay = Math.abs(wrap180(p.ry));
      if (ay >= ax) {
        q = [q[2], q[3], q[0], q[1], q[6], q[7], q[4], q[5]];
        m.mirrored = "x";
      } else {
        q = [q[6], q[7], q[4], q[5], q[2], q[3], q[0], q[1]];
        m.mirrored = "y";
      }
    } else m.face = "back";
  }
  m.quad = q.map((v) => Math.round(v * 100) / 100) as Motion3DFrame["quad"];
  return m;
}

/**
 * Projected outline of the card's rounded rect (for the soft shadow that follows the tilt):
 * `perCorner` points per corner arc, clockwise from the top edge.
 */
export function cardOutline(m: Pick<Motion3DFrame, "pose" | "d" | "o">, x: number, y: number, w: number, h: number, radius: number, perCorner = 6): Array<[number, number]> {
  const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
  const pts: Array<[number, number]> = [];
  const corners: Array<[number, number, number]> = [
    [x + w - r, y + r, -90],
    [x + w - r, y + h - r, 0],
    [x + r, y + h - r, 90],
    [x + r, y + r, 180],
  ];
  for (const [cx, cy, a0] of corners) {
    const n = r > 0 ? perCorner : 1;
    for (let i = 0; i < n; i++) {
      const a = ((a0 + (90 * i) / Math.max(1, n - 1)) * Math.PI) / 180;
      pts.push(project3d(m, cx + r * Math.cos(a), cy + r * Math.sin(a)));
    }
  }
  return pts;
}

/** Validation messages for project.motion3d. */
export function validateMotion3d(list: unknown): string[] {
  const errs: string[] = [];
  if (!Array.isArray(list)) return ["motion3d must be a list of segments"];
  const pose = (p: unknown, where: string) => {
    if (p === undefined) return;
    if (!p || typeof p !== "object") {
      errs.push(`${where} must be a pose object`);
      return;
    }
    for (const [k, v] of Object.entries(p)) {
      if (!POSE_KEYS.includes(k as keyof Pose3D)) errs.push(`${where}.${k} is not a pose field`);
      else if (!Number.isFinite(v)) errs.push(`${where}.${k} must be a number`);
      else if (k === "scale" && !((v as number) > 0)) errs.push(`${where}.scale must be > 0`);
    }
  };
  for (const s of list as Motion3DSegment[]) {
    if (!s || typeof s !== "object" || typeof s.id !== "string") {
      errs.push("motion3d segment needs an id");
      continue;
    }
    if (!Number.isFinite(s.startMs) || !(s.endMs > s.startMs)) errs.push(`motion3d ${s.id} ends before it starts`);
    if (!EASINGS_3D.includes(s.easing)) errs.push(`motion3d ${s.id} easing ${String(s.easing)} unknown`);
    if (!(s.perspective >= 100)) errs.push(`motion3d ${s.id} perspective must be >= 100 px`);
    if (s.backface !== undefined && s.backface !== "card" && s.backface !== "front") errs.push(`motion3d ${s.id} backface must be card or front`);
    if (s.blendMs !== undefined && !(s.blendMs >= 0)) errs.push(`motion3d ${s.id} blendMs must be >= 0`);
    if (s.periodMs !== undefined && !(s.periodMs > 0)) errs.push(`motion3d ${s.id} periodMs must be > 0`);
    pose(s.from, `motion3d ${s.id} from`);
    pose(s.to, `motion3d ${s.id} to`);
    if (s.keys !== undefined) {
      if (!Array.isArray(s.keys)) errs.push(`motion3d ${s.id} keys must be a list`);
      else
        for (const k of s.keys) {
          if (!(k && k.at > 0 && k.at < 1)) errs.push(`motion3d ${s.id} key at must be within (0, 1)`);
          else {
            pose(k.pose, `motion3d ${s.id} key ${k.at}`);
            if (k.easing !== undefined && !EASINGS_3D.includes(k.easing)) errs.push(`motion3d ${s.id} key easing unknown`);
          }
        }
    }
  }
  return errs;
}
