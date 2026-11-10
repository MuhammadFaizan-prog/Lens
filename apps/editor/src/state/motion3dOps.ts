/**
 * Pure editing logic for 3D motion blocks (no React, no store): keyframe indexing, pose edits,
 * adding / deleting keyframes and applying a template to an existing block. The store wraps each in
 * one undo step (store.edit / store.tweak); test/motion3dStore.test.ts covers them through the store.
 *
 * Keyframe index k of a segment, as the inspector lists them: 0 = `from`, 1..n = the interior keys
 * (kept sorted by `at`), n + 1 = `to`.
 */
import { fullPose, segmentPoseAt, type Motion3DSegment, type Motion3DTemplate, type Pose3D, type ProjectConfig } from "@lens/engine";

export type Axis3D = "rx" | "ry" | "rz";

/** Number of keyframes the inspector lists (from + interior + to). */
export function keyCount(s: Motion3DSegment): number {
  return (s.keys?.length ?? 0) + 2;
}

/** Fraction along the segment of keyframe k. */
export function keyAt(s: Motion3DSegment, k: number): number {
  const n = s.keys?.length ?? 0;
  if (k <= 0) return 0;
  if (k > n) return 1;
  return s.keys![k - 1]!.at;
}

/** Full pose of keyframe k. */
export function keyPose(s: Motion3DSegment, k: number): Pose3D {
  const n = s.keys?.length ?? 0;
  if (k <= 0) return fullPose(s.from);
  if (k > n) return fullPose(s.to);
  return fullPose(s.keys![k - 1]!.pose);
}

/** Drop fields equal to identity so saved projects stay small. */
function compact(p: Pose3D): Partial<Pose3D> {
  const o: Partial<Pose3D> = {};
  for (const [k, v] of Object.entries(p) as Array<[keyof Pose3D, number]>) if (k === "scale" ? v !== 1 : v !== 0) o[k] = v;
  return o;
}

/** Patch the pose of keyframe k. */
export function setKeyPose(s: Motion3DSegment, k: number, patch: Partial<Pose3D>): Motion3DSegment {
  const n = s.keys?.length ?? 0;
  const pose = compact({ ...keyPose(s, k), ...patch });
  if (k <= 0) return { ...s, from: pose };
  if (k > n) return { ...s, to: pose };
  return { ...s, keys: s.keys!.map((key, j) => (j === k - 1 ? { ...key, pose } : key)) };
}

/**
 * Add an interior keyframe at source time src, holding the pose the card has there (so adding a key
 * changes nothing until it is edited). Returns the segment and the new key's index, or null when src
 * is not strictly inside the segment or a key already sits within 1 % of it.
 */
export function addKeyAt(s: Motion3DSegment, src: number): { seg: Motion3DSegment; key: number } | null {
  const dur = s.endMs - s.startMs;
  if (!(dur > 0)) return null;
  const at = Math.round(((src - s.startMs) / dur) * 1000) / 1000;
  if (!(at > 0.01 && at < 0.99)) return null;
  const keys = s.keys ?? [];
  if (keys.some((k) => Math.abs(k.at - at) < 0.01)) return null;
  const pose = compact(segmentPoseAt(s, src));
  const next = [...keys, { at, pose }].sort((a, b) => a.at - b.at);
  return { seg: { ...s, keys: next }, key: next.findIndex((k) => k.at === at) + 1 };
}

/** Delete interior keyframe k (from / to cannot be deleted). */
export function deleteKey(s: Motion3DSegment, k: number): Motion3DSegment {
  const n = s.keys?.length ?? 0;
  if (k <= 0 || k > n) return s;
  const keys = s.keys!.filter((_, j) => j !== k - 1);
  const out: Motion3DSegment = { ...s, keys };
  if (!keys.length) delete out.keys;
  return out;
}

/** Apply a template's motion to an existing block, keeping its id and start; length from the template, clipped to maxEndMs. */
export function applyTemplate(s: Motion3DSegment, t: Motion3DTemplate, maxEndMs: number): Motion3DSegment {
  const out: Motion3DSegment = {
    id: s.id,
    startMs: s.startMs,
    endMs: Math.max(s.startMs + 200, Math.min(maxEndMs, s.startMs + t.durationMs)),
    template: t.user ? `user:${t.id}` : t.id,
    from: { ...t.from },
    to: { ...t.to },
    easing: t.easing,
    perspective: t.perspective,
  };
  if (t.keys?.length) out.keys = t.keys.map((k) => ({ ...k, pose: { ...k.pose } })).sort((a, b) => a.at - b.at);
  if (t.hold) out.hold = true;
  if (t.blendMs) out.blendMs = t.blendMs;
  if (t.periodMs) out.periodMs = t.periodMs;
  if (t.backface) out.backface = t.backface;
  return out;
}

/** Replace segment i of the project. Hand edits mark the block as custom-made only when asked. */
export function mapSegment(p: ProjectConfig, i: number, fn: (s: Motion3DSegment) => Motion3DSegment): ProjectConfig {
  return { ...p, motion3d: p.motion3d.map((s, j) => (j === i ? fn(s) : s)) };
}

/** Smallest gap between two keyframes, as a fraction of the block (the same 1 % addKeyAt keeps). */
export const KEY_GAP = 0.01;

/** Allowed `at` range of interior keyframe k: strictly between its neighbours, KEY_GAP away. */
export function keyAtRange(s: Motion3DSegment, k: number): [number, number] {
  const n = s.keys?.length ?? 0;
  if (k <= 0 || k > n) return [keyAt(s, k), keyAt(s, k)];
  return [keyAt(s, k - 1) + KEY_GAP, keyAt(s, k + 1) - KEY_GAP];
}

/**
 * Move interior keyframe k to fraction `at` of the block (clamped between its neighbours, so the key
 * order and its index never change). Start / End stay at 0 / 1 (move the block edges instead).
 */
export function setKeyAt(s: Motion3DSegment, k: number, at: number): Motion3DSegment {
  const n = s.keys?.length ?? 0;
  if (k <= 0 || k > n || !Number.isFinite(at)) return s;
  const [lo, hi] = keyAtRange(s, k);
  if (!(hi >= lo)) return s;
  const v = Math.round(Math.max(lo, Math.min(hi, at)) * 1000) / 1000;
  return { ...s, keys: s.keys!.map((key, j) => (j === k - 1 ? { ...key, at: v } : key)) };
}

/** Keyframe k back to the flat card (identity pose). */
export function resetKeyPose(s: Motion3DSegment, k: number): Motion3DSegment {
  const n = s.keys?.length ?? 0;
  if (k <= 0) return { ...s, from: {} };
  if (k > n) return { ...s, to: {} };
  return { ...s, keys: s.keys!.map((key, j) => (j === k - 1 ? { ...key, pose: {} } : key)) };
}

/**
 * Pose shown on a template tile: halfway between its first and last pose (linear, so a spring's
 * overshoot does not flatten it). A pose that would show the card edge-on (a flip at 90 degrees) is
 * taken a third of the way instead; a loop shows its first pose.
 */
export function templateTilePose(t: Pick<Motion3DTemplate, "from" | "to" | "keys" | "easing">): Pose3D {
  const a = fullPose(t.from);
  const b = fullPose(t.to);
  if (t.easing === "loop") return a;
  const at = (u: number) => {
    const o = {} as Pose3D;
    for (const key of Object.keys(a) as Array<keyof Pose3D>) o[key] = a[key] + (b[key] - a[key]) * u;
    return o;
  };
  const edgeOn = (p: Pose3D) => Math.abs(Math.cos((p.rx * Math.PI) / 180)) < 0.3 || Math.abs(Math.cos((p.ry * Math.PI) / 180)) < 0.3;
  if (t.keys?.length) {
    const mid = [...t.keys].sort((x, y) => Math.abs(x.at - 0.5) - Math.abs(y.at - 0.5))[0]!;
    const p = fullPose(mid.pose);
    if (!edgeOn(p)) return p;
  }
  for (const u of [0.5, 0.35, 0.2]) {
    const p = at(u);
    if (!edgeOn(p)) return p;
  }
  return a;
}
