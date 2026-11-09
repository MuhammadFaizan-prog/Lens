/**
 * Pure timeline editing logic (no React): ranges on tracks, snapping, move / resize / create /
 * delete, cut merging and source <-> output frame mapping. Everything the timeline UI does to a
 * project goes through here, so it is unit-tested in isolation (test/timelineOps.test.ts).
 *
 * Timeline blocks live in SOURCE time (recording ms), like the engine's project data. The
 * transport works in OUTPUT frames; plan frames map one to the other.
 */
import { defaultSlide, mergeRanges, normalizeAnnotation, type ProjectConfig, type RenderPlan, type TimeRange, type ZoomSegment } from "@lens/engine";

export type TrackKind = "zoom" | "cut" | "speed" | "mask" | "annotation" | "slide" | "caption" | "volume";

export interface Range {
  startMs: number;
  endMs: number;
}

export const MIN_BLOCK_MS: Record<TrackKind, number> = { zoom: 300, cut: 50, speed: 200, mask: 200, annotation: 200, slide: 200, caption: 200, volume: 200 };

/** Index into p.overrides of the i-th volume segment (overrides also hold cursor-only ranges). */
export function volumeIndex(p: ProjectConfig, i: number): number {
  let n = -1;
  for (let j = 0; j < p.overrides.length; j++) if (p.overrides[j]!.volume !== undefined && ++n === i) return j;
  return -1;
}

export interface SnapOptions {
  targets: number[];
  /** Snap distance in ms (the UI converts ~8 px at the current zoom). */
  thresholdMs: number;
}

/** Nearest target within the threshold, else t unchanged. */
export function snap(t: number, opts: SnapOptions | null): { t: number; snapped: number | null } {
  if (!opts) return { t, snapped: null };
  let best: number | null = null;
  for (const s of opts.targets) if (Math.abs(s - t) <= opts.thresholdMs && (best === null || Math.abs(s - t) < Math.abs(best - t))) best = s;
  return best === null ? { t, snapped: null } : { t: best, snapped: best };
}

/** Move a range by delta, keeping its length, inside [lo, hi]; either edge may snap. */
export function moveRange(r: Range, deltaMs: number, lo: number, hi: number, snapOpts: SnapOptions | null = null): Range & { snapped: number | null } {
  const len = r.endMs - r.startMs;
  let start = Math.min(hi - len, Math.max(lo, r.startMs + deltaMs));
  let snapped: number | null = null;
  if (snapOpts) {
    const a = snap(start, snapOpts);
    const b = snap(start + len, snapOpts);
    const da = a.snapped === null ? Infinity : Math.abs(a.t - start);
    const db = b.snapped === null ? Infinity : Math.abs(b.t - (start + len));
    if (da <= db && a.snapped !== null) {
      start = a.t;
      snapped = a.snapped;
    } else if (b.snapped !== null) {
      start = b.t - len;
      snapped = b.snapped;
    }
    start = Math.min(hi - len, Math.max(lo, start));
  }
  return { startMs: start, endMs: start + len, snapped };
}

/** Drag one edge to t (snapped), keeping at least minLen and inside [lo, hi]. */
export function resizeRange(r: Range, edge: "start" | "end", t: number, minLen: number, lo: number, hi: number, snapOpts: SnapOptions | null = null): Range & { snapped: number | null } {
  const s = snap(t, snapOpts);
  if (edge === "start") {
    const start = Math.max(lo, Math.min(r.endMs - minLen, s.t));
    return { startMs: start, endMs: r.endMs, snapped: start === s.t ? s.snapped : null };
  }
  const end = Math.min(hi, Math.max(r.startMs + minLen, s.t));
  return { startMs: r.startMs, endMs: end, snapped: end === s.t ? s.snapped : null };
}

/** Free space around t among existing blocks of one track, as [lo, hi]. */
export function freeSpan(blocks: Range[], t: number, durationMs: number, ignoreIndex = -1): [number, number] {
  let lo = 0;
  let hi = durationMs;
  blocks.forEach((b, i) => {
    if (i === ignoreIndex) return;
    if (b.endMs <= t) lo = Math.max(lo, b.endMs);
    else if (b.startMs >= t) hi = Math.min(hi, b.startMs);
  });
  return [lo, hi];
}

/** A new block of up to lenMs starting at t, fitted into the free space; null if there is no room. */
export function createRange(blocks: Range[], t: number, lenMs: number, durationMs: number, minLen: number): Range | null {
  if (blocks.some((b) => t >= b.startMs && t < b.endMs)) return null;
  const [lo, hi] = freeSpan(blocks, t, durationMs);
  let start = Math.max(lo, t);
  let end = Math.min(hi, start + lenMs);
  // not enough room after t: slide back so the block keeps its full length where possible
  if (end - start < lenMs) start = Math.max(lo, end - lenMs);
  return end - start >= minLen ? { startMs: start, endMs: end } : null;
}

// ------------------------------------------------------------------ project-level edits

export function blocksOf(p: ProjectConfig, track: TrackKind): Range[] {
  switch (track) {
    case "zoom":
      return p.zoom.segments;
    case "cut":
      return p.edits.cuts;
    case "speed":
      return p.edits.speed;
    case "mask":
      return p.masks;
    case "annotation":
      return p.annotations;
    case "slide":
      // slides are points in source time; as ranges they are zero-length
      return p.slides.map((s) => ({ startMs: s.atMs, endMs: s.atMs }));
    case "caption":
      return p.captions.cues ?? [];
    case "volume":
      return p.overrides.filter((o) => o.volume !== undefined);
  }
}

/** Replace block i of a track with a patch (times or other fields). */
export function updateBlock(p: ProjectConfig, track: TrackKind, i: number, patch: Partial<Range> & Record<string, unknown>): ProjectConfig {
  switch (track) {
    case "zoom":
      return { ...p, zoom: { ...p.zoom, segments: p.zoom.segments.map((s, j) => (j === i ? { ...s, ...patch } : s)) } };
    case "cut":
      return { ...p, edits: { ...p.edits, cuts: p.edits.cuts.map((c, j) => (j === i ? { ...c, ...patch } : c)) } };
    case "speed":
      return { ...p, edits: { ...p.edits, speed: p.edits.speed.map((s, j) => (j === i ? { ...s, ...patch } : s)) } };
    case "mask":
      return {
        ...p,
        masks: p.masks.map((m, j) => {
          if (j !== i) return m;
          // moving a tracked mask in time carries its keys along (a resize keeps them where they are)
          const q = patch as Partial<typeof m>;
          if (m.keys && q.startMs !== undefined && q.endMs !== undefined && Math.abs(q.endMs - q.startMs - (m.endMs - m.startMs)) < 0.5) {
            const d = q.startMs - m.startMs;
            if (d) return { ...m, ...patch, keys: m.keys.map((k) => ({ ...k, tMs: k.tMs + d })) };
          }
          return { ...m, ...patch };
        }),
      };
    case "annotation":
      return { ...p, annotations: p.annotations.map((a, j) => (j === i ? { ...a, ...patch } : a)) };
    case "slide":
      return { ...p, slides: p.slides.map((s, j) => (j === i ? { ...s, ...(patch.startMs !== undefined ? { atMs: patch.startMs } : {}) } : s)) };
    case "caption":
      return { ...p, captions: { ...p.captions, cues: (p.captions.cues ?? []).map((c, j) => (j === i ? { ...c, ...patch } : c)) } };
    case "volume": {
      const k = volumeIndex(p, i);
      return { ...p, overrides: p.overrides.map((o, j) => (j === k ? { ...o, ...patch } : o)) };
    }
  }
}

export function deleteBlock(p: ProjectConfig, track: TrackKind, i: number): ProjectConfig {
  switch (track) {
    case "zoom":
      return { ...p, zoom: { ...p.zoom, segments: p.zoom.segments.filter((_, j) => j !== i) } };
    case "cut":
      return { ...p, edits: { ...p.edits, cuts: p.edits.cuts.filter((_, j) => j !== i) } };
    case "speed":
      return { ...p, edits: { ...p.edits, speed: p.edits.speed.filter((_, j) => j !== i) } };
    case "mask":
      return { ...p, masks: p.masks.filter((_, j) => j !== i) };
    case "annotation": {
      const a = p.annotations[i];
      const q = { ...p, annotations: p.annotations.filter((_, j) => j !== i) };
      // a step badge deleted by hand sends its draft back to review
      return a?.stepId ? { ...q, stepLabels: { ...q.stepLabels, drafts: q.stepLabels.drafts.map((d) => (d.id === a.stepId ? { ...d, state: "pending" as const } : d)) } } : q;
    }
    case "slide":
      return { ...p, slides: p.slides.filter((_, j) => j !== i) };
    case "caption":
      return { ...p, captions: { ...p.captions, cues: (p.captions.cues ?? []).filter((_, j) => j !== i) } };
    case "volume": {
      const k = volumeIndex(p, i);
      return { ...p, overrides: p.overrides.filter((_, j) => j !== k) };
    }
  }
}

let idSeq = 0;
export function newId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${Date.now().toString(36)}${idSeq}`;
}

/** Add a block to a track; returns the project and the new block's index. */
export function addBlock(p: ProjectConfig, track: TrackKind, r: Range, srcW = 1920, srcH = 1080): { project: ProjectConfig; index: number } {
  switch (track) {
    case "zoom": {
      const seg: ZoomSegment = { id: newId("zoom"), startMs: r.startMs, endMs: r.endMs, scale: p.zoom.defaultScale, focus: "follow", style: p.zoom.style, auto: false };
      const segments = [...p.zoom.segments, seg].sort((a, b) => a.startMs - b.startMs);
      return { project: { ...p, zoom: { ...p.zoom, segments } }, index: segments.indexOf(seg) };
    }
    case "cut": {
      const c = { startMs: r.startMs, endMs: r.endMs };
      const cuts = [...p.edits.cuts, c].sort((a, b) => a.startMs - b.startMs);
      return { project: { ...p, edits: { ...p.edits, cuts } }, index: cuts.indexOf(c) };
    }
    case "speed": {
      const s = { startMs: r.startMs, endMs: r.endMs, rate: 2 };
      const speed = [...p.edits.speed, s].sort((a, b) => a.startMs - b.startMs);
      return { project: { ...p, edits: { ...p.edits, speed } }, index: speed.indexOf(s) };
    }
    case "mask": {
      const m = { id: newId("mask"), kind: "blur" as const, rect: { x: Math.round(srcW * 0.35), y: Math.round(srcH * 0.4), w: Math.round(srcW * 0.3), h: Math.round(srcH * 0.12) },
        startMs: r.startMs, endMs: r.endMs, feather: 8, fadeMs: 200, strength: 12 };
      const masks = [...p.masks, m].sort((a, b) => a.startMs - b.startMs);
      return { project: { ...p, masks }, index: masks.indexOf(m) };
    }
    case "annotation": {
      // a frame-anchored text label in the middle of the frame
      const a = normalizeAnnotation({ id: newId("text"), kind: "text", anchor: "frame", startMs: r.startMs, endMs: r.endMs, rect: { x: 0.35, y: 0.45, w: 0.3, h: 0 }, align: "center", text: "Text" });
      return { project: { ...p, annotations: [...p.annotations, a] }, index: p.annotations.length };
    }
    case "slide": {
      const s = defaultSlide(newId("slide"), r.startMs);
      return { project: { ...p, slides: [...p.slides, s] }, index: p.slides.length };
    }
    case "caption": {
      // a hand-written caption (works with no transcript); turning captions on so it shows
      const c = { id: newId("cue"), startMs: r.startMs, endMs: r.endMs, text: "Caption" };
      const cues = [...(p.captions.cues ?? []), c].sort((a, b) => a.startMs - b.startMs);
      return { project: { ...p, captions: { ...p.captions, enabled: true, cues } }, index: cues.indexOf(c) };
    }
    case "volume": {
      const o = { startMs: r.startMs, endMs: r.endMs, volume: 0.5 };
      const overrides = [...p.overrides, o].sort((a, b) => a.startMs - b.startMs);
      const q = { ...p, overrides };
      return { project: q, index: blocksOf(q, "volume").indexOf(o) };
    }
  }
}

/** Merge overlapping / touching cuts (run after a cut edit is committed). */
export function normalizeCuts(p: ProjectConfig): ProjectConfig {
  return { ...p, edits: { ...p.edits, cuts: mergeRanges(p.edits.cuts) } };
}

/** Remove [r] from a list of ranges (restoring deleted transcript words). */
export function subtractRange(ranges: TimeRange[], r: Range): TimeRange[] {
  const out: TimeRange[] = [];
  for (const c of ranges) {
    if (c.endMs <= r.startMs || c.startMs >= r.endMs) out.push({ ...c });
    else {
      if (c.startMs < r.startMs) out.push({ startMs: c.startMs, endMs: r.startMs });
      if (c.endMs > r.endMs) out.push({ startMs: r.endMs, endMs: c.endMs });
    }
  }
  return out;
}

/**
 * Auto zooms are recomputed from the events on every plan; editing one freezes the current auto
 * zooms into the project (auto: true segments with zoom.auto off, which the engine uses as-is),
 * so moving one does not make the planner put it back.
 */
export function freezeAutoZooms(p: ProjectConfig, planZooms: ZoomSegment[]): ProjectConfig {
  if (!p.zoom.auto) return p;
  const manual = p.zoom.segments.filter((s) => !s.auto);
  const autos = planZooms.filter((s) => s.auto).map((s) => ({ ...s, id: newId("auto") }));
  const segments = [...manual, ...autos].sort((a, b) => a.startMs - b.startMs);
  return { ...p, zoom: { ...p.zoom, auto: false, segments } };
}

/** Turn auto zoom back on: drop frozen auto segments, keep manual ones. */
export function unfreezeAutoZooms(p: ProjectConfig): ProjectConfig {
  return { ...p, zoom: { ...p.zoom, auto: true, segments: p.zoom.segments.filter((s) => !s.auto) } };
}

// ------------------------------------------------------------------ time mapping

/** First output frame whose source time is >= srcMs (frames' src is non-decreasing). */
export function frameForSource(plan: Pick<RenderPlan, "frames">, srcMs: number): number {
  const f = plan.frames;
  if (!f.length) return 0;
  let lo = 0;
  let hi = f.length - 1;
  if (srcMs <= f[0]!.src) return 0;
  if (srcMs > f[hi]!.src) return hi;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (f[mid]!.src < srcMs - 1e-6) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Output frame index at output time t (ms), clamped. */
export function frameAt(plan: Pick<RenderPlan, "output">, tMs: number): number {
  const n = plan.output.frames;
  return Math.max(0, Math.min(n - 1, Math.floor((tMs * plan.output.fps) / 1000 + 1e-6)));
}

export function isCut(cuts: Range[], srcMs: number): boolean {
  return cuts.some((c) => srcMs >= c.startMs && srcMs < c.endMs);
}

/** Timecode mm:ss.ff (ff = frame within the second). */
export function timecode(ms: number, fps: number): string {
  const total = Math.max(0, Math.round((ms * fps) / 1000));
  const f = total % fps;
  const s = Math.floor(total / fps);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}.${String(f).padStart(2, "0")}`;
}
