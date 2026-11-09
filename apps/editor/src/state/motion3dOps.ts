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
