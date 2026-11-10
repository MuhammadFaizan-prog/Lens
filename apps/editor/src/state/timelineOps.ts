/**
 * Pure timeline editing logic (no React): ranges on tracks, snapping, move / resize / create /
 * delete, cut merging and source <-> output frame mapping. Everything the timeline UI does to a
 * project goes through here, so it is unit-tested in isolation (test/timelineOps.test.ts).
 *
 * Timeline blocks live in SOURCE time (recording ms), like the engine's project data. The
 * transport works in OUTPUT frames; plan frames map one to the other.
 */
import { defaultFreeze, defaultSlide, mergeRanges, MOTION3D_TEMPLATES, normalizeAnnotation, segmentFromTemplate, type Motion3DTemplate, type ProjectConfig, type RenderPlan, type TimeRange, type ZoomSegment } from "@lens/engine";

export type TrackKind = "zoom" | "cut" | "speed" | "freeze" | "mask" | "annotation" | "slide" | "caption" | "volume" | "motion3d";

export interface Range {
  startMs: number;
  endMs: number;
}

export const MIN_BLOCK_MS: Record<TrackKind, number> = { zoom: 300, cut: 50, speed: 200, freeze: 200, mask: 200, annotation: 200, slide: 200, caption: 200, volume: 200, motion3d: 200 };

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
    case "freeze":
      return p.freezes ?? [];
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
    case "motion3d":
      return p.motion3d;
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
    case "freeze":
      return { ...p, freezes: (p.freezes ?? []).map((f, j) => (j === i ? { ...f, ...patch } : f)) };
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
    case "motion3d":
      // keyframes are fractions of the segment, so a move or a resize carries them along
      return { ...p, motion3d: p.motion3d.map((m, j) => (j === i ? { ...m, ...patch } : m)) };
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
    case "freeze":
      return { ...p, freezes: (p.freezes ?? []).filter((_, j) => j !== i) };
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
    case "motion3d":
      return { ...p, motion3d: p.motion3d.filter((_, j) => j !== i) };
  }
}

let idSeq = 0;
export function newId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${Date.now().toString(36)}${idSeq}`;
}

/** Add a block to a track; returns the project and the new block's index. */
export function addBlock(p: ProjectConfig, track: TrackKind, r: Range, srcW = 1920, srcH = 1080, template?: Motion3DTemplate): { project: ProjectConfig; index: number } {
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
    case "freeze": {
      const f = defaultFreeze(newId("freeze"), Math.round(r.startMs), Math.round(r.endMs));
      const freezes = [...(p.freezes ?? []), f].sort((a, b) => a.startMs - b.startMs);
      return { project: { ...p, freezes }, index: freezes.indexOf(f) };
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
    case "motion3d": {
      const t = template ?? MOTION3D_TEMPLATES.find((x) => x.id === "tilt-in")!;
      const m = { ...segmentFromTemplate(t, r.startMs, newId("m3d")), endMs: Math.round(r.endMs) };
      const motion3d = [...p.motion3d, m].sort((a, b) => a.startMs - b.startMs);
      return { project: { ...p, motion3d }, index: motion3d.indexOf(m) };
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

// ------------------------------------------------------------------ zoom selection index

/*
 * A zoom Selection's index is always into the render plan's zoomSegments (what the timeline draws,
 * auto zooms included). The project segment it edits is found by segment id, never by position:
 * the plan interleaves live auto zooms with the project's manual ones, so the two lists' indices
 * differ whenever auto zoom is on.
 */

/** Project (p.zoom.segments) index of plan zoom `planIndex`, by id; -1 for a live auto zoom or a bad index. */
export function zoomDocIndex(p: ProjectConfig, planZooms: readonly ZoomSegment[], planIndex: number): number {
  const z = planZooms[planIndex];
  return z ? p.zoom.segments.findIndex((s) => s.id === z.id) : -1;
}

/** Plan zoomSegments index of project zoom `docIndex`, by id; -1 when the plan does not hold it. */
export function zoomPlanIndex(p: ProjectConfig, planZooms: readonly ZoomSegment[], docIndex: number): number {
  const id = p.zoom.segments[docIndex]?.id;
  return id === undefined ? -1 : planZooms.findIndex((z) => z.id === id);
}

// ------------------------------------------------------------------ multi-select (group) edits

/** A block on a track; zoom indices here are into p.zoom.segments (the store maps plan indices). */
export interface BlockRef {
  track: TrackKind;
  index: number;
}

/** Every track kind, in MIN_BLOCK_MS order. */
export const TRACK_KINDS = Object.keys(MIN_BLOCK_MS) as TrackKind[];

/** Only cuts (they merge) and annotations (they stack) may overlap other blocks of their track (3D motion blocks never do). */
export function canOverlap(track: TrackKind): boolean {
  return track === "cut" || track === "annotation";
}

/** Distinct, valid refs grouped per track (indices ascending). */
function byTrack(p: ProjectConfig, items: BlockRef[]): Map<TrackKind, number[]> {
  const out = new Map<TrackKind, number[]>();
  for (const track of TRACK_KINDS) {
    const n = blocksOf(p, track).length;
    const idx = [...new Set(items.filter((r) => r.track === track && Number.isInteger(r.index) && r.index >= 0 && r.index < n).map((r) => r.index))].sort((a, b) => a - b);
    if (idx.length) out.set(track, idx);
  }
  return out;
}

/** Delete several blocks at once (per track in descending index order, so indices stay valid). */
export function deleteBlocks(p: ProjectConfig, items: BlockRef[]): ProjectConfig {
  let q = p;
  for (const [track, idx] of byTrack(p, items)) for (let k = idx.length - 1; k >= 0; k--) q = deleteBlock(q, track, idx[k]!);
  return q;
}

/**
 * Clamp a group move so every selected block stays inside [0, durationMs] and, on tracks whose
 * blocks may not overlap, inside the gap between its unselected neighbours (selected blocks of one
 * track move together, so they never collide with each other). Never pushes the other way: a block
 * already overlapping a neighbour can still move by 0.
 */
export function clampGroupDelta(p: ProjectConfig, items: BlockRef[], deltaMs: number, durationMs: number): number {
  let lo = -Infinity;
  let hi = Infinity;
  for (const [track, idx] of byTrack(p, items)) {
    const blocks = blocksOf(p, track);
    const sel = new Set(idx);
    for (const i of idx) {
      const b = blocks[i]!;
      let min = 0;
      let max = durationMs;
      if (!canOverlap(track)) {
        blocks.forEach((o, j) => {
          if (sel.has(j)) return;
          if (o.endMs <= b.startMs) min = Math.max(min, o.endMs);
          else if (o.startMs >= b.endMs) max = Math.min(max, o.startMs);
        });
      }
      lo = Math.max(lo, Math.min(0, min - b.startMs));
      hi = Math.min(hi, Math.max(0, max - b.endMs));
    }
  }
  if (lo === -Infinity) return 0;
  if (lo > hi) return 0;
  return Math.min(hi, Math.max(lo, deltaMs));
}

/** Index of the (merged) cut holding srcMs. */
function cutIndexAt(p: ProjectConfig, srcMs: number): number {
  return p.edits.cuts.findIndex((c) => srcMs >= c.startMs - 0.5 && srcMs <= c.endMs + 0.5);
}

/** Merge cuts and re-point cut refs at the merged ranges (refs to other tracks unchanged). */
function normalizeWithRefs(p: ProjectConfig, refs: Array<BlockRef & { at: number }>): { project: ProjectConfig; items: BlockRef[] } {
  if (!refs.some((r) => r.track === "cut")) return { project: p, items: refs.map(({ track, index }) => ({ track, index })) };
  const q = normalizeCuts(p);
  const seen = new Set<string>();
  const items: BlockRef[] = [];
  for (const r of refs) {
    const index = r.track === "cut" ? cutIndexAt(q, r.at) : r.index;
    const key = `${r.track}:${index}`;
    if (index < 0 || seen.has(key)) continue;
    seen.add(key);
    items.push({ track: r.track, index });
  }
  return { project: q, items };
}

/**
 * Move several blocks by one (clamped) delta. Cuts are merged afterwards unless normalize is false
 * (live drag previews keep indices stable; the final commit normalizes). Returns the refs of the
 * moved blocks in the new project and the delta actually applied.
 */
export function moveBlocks(p: ProjectConfig, items: BlockRef[], deltaMs: number, durationMs: number, normalize = true): { project: ProjectConfig; items: BlockRef[]; deltaMs: number } {
  const groups = byTrack(p, items);
  const d = clampGroupDelta(p, items, deltaMs, durationMs);
  let q = p;
  const refs: Array<BlockRef & { at: number }> = [];
  for (const [track, idx] of groups) {
    const blocks = blocksOf(p, track);
    for (const i of idx) {
      const b = blocks[i]!;
      if (d) q = updateBlock(q, track, i, { startMs: b.startMs + d, endMs: b.endMs + d });
      refs.push({ track, index: i, at: b.startMs + d });
    }
  }
  if (!normalize) return { project: q, items: refs.map(({ track, index }) => ({ track, index })), deltaMs: d };
  return { ...normalizeWithRefs(q, refs), deltaMs: d };
}

function overlaps(a: Range, b: Range): boolean {
  // zero-length blocks (slides) collide when they sit on the same time
  if (a.startMs === a.endMs || b.startMs === b.endMs) return a.startMs === b.startMs || (a.startMs < b.endMs && b.startMs < a.endMs);
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

/**
 * Copy blocks, placed right after the whole selection (offset = the selection's time span, or
 * offsetMs). Copies get fresh ids; a copied step badge loses its step link. On tracks whose blocks
 * may not overlap, a copy that would collide or run past durationMs is skipped. Returns the copies'
 * refs and how many were skipped.
 */
export function duplicateBlocks(p: ProjectConfig, items: BlockRef[], durationMs: number, offsetMs?: number): { project: ProjectConfig; items: BlockRef[]; skipped: number } {
  const groups = byTrack(p, items);
  if (!groups.size) return { project: p, items: [], skipped: 0 };
  let s0 = Infinity;
  let e0 = -Infinity;
  for (const [track, idx] of groups) for (const i of idx) {
    const b = blocksOf(p, track)[i]!;
    s0 = Math.min(s0, b.startMs);
    e0 = Math.max(e0, b.endMs);
  }
  const off = offsetMs ?? Math.max(e0 - s0, MIN_BLOCK_MS.cut);
  let q = p;
  let skipped = 0;
  const added: Array<{ track: TrackKind; obj: object; at: number }> = [];
  for (const [track, idx] of groups) {
    const placed: Range[] = [...blocksOf(p, track)];
    for (const i of idx) {
      const b = blocksOf(p, track)[i]!;
      const r = { startMs: b.startMs + off, endMs: b.endMs + off };
      if (r.endMs > durationMs || r.startMs < 0 || (!canOverlap(track) && placed.some((o) => overlaps(o, r)))) {
        skipped++;
        continue;
      }
      placed.push(r);
      let obj: object;
      switch (track) {
        case "zoom": {
          const z = { ...p.zoom.segments[i]!, ...r, id: newId("zoom") };
          q = { ...q, zoom: { ...q.zoom, segments: [...q.zoom.segments, z].sort((a, b2) => a.startMs - b2.startMs) } };
          obj = z;
          break;
        }
        case "cut": {
          const c = { ...p.edits.cuts[i]!, ...r };
          q = { ...q, edits: { ...q.edits, cuts: [...q.edits.cuts, c].sort((a, b2) => a.startMs - b2.startMs) } };
          obj = c;
          break;
        }
        case "speed": {
          const sp = { ...p.edits.speed[i]!, ...r };
          q = { ...q, edits: { ...q.edits, speed: [...q.edits.speed, sp].sort((a, b2) => a.startMs - b2.startMs) } };
          obj = sp;
          break;
        }
        case "freeze": {
          const f = { ...(p.freezes ?? [])[i]!, ...r, id: newId("freeze") };
          q = { ...q, freezes: [...(q.freezes ?? []), f].sort((a, b2) => a.startMs - b2.startMs) };
          obj = f;
          break;
        }
        case "mask": {
          const m0 = p.masks[i]!;
          const m = { ...m0, ...r, id: newId("mask"), ...(m0.keys ? { keys: m0.keys.map((k) => ({ ...k, tMs: k.tMs + off })) } : {}) };
          q = { ...q, masks: [...q.masks, m].sort((a, b2) => a.startMs - b2.startMs) };
          obj = m;
          break;
        }
        case "annotation": {
          const { stepId: _step, ...a0 } = p.annotations[i]!;
          const a = { ...a0, ...r, id: newId(a0.kind) } as (typeof p.annotations)[number];
          q = { ...q, annotations: [...q.annotations, a] };
          obj = a;
          break;
        }
        case "slide": {
          const sl = { ...p.slides[i]!, atMs: r.startMs, id: newId("slide") };
          q = { ...q, slides: [...q.slides, sl] };
          obj = sl;
          break;
        }
        case "caption": {
          const c = { ...(p.captions.cues ?? [])[i]!, ...r, id: newId("cue") };
          q = { ...q, captions: { ...q.captions, cues: [...(q.captions.cues ?? []), c].sort((a, b2) => a.startMs - b2.startMs) } };
          obj = c;
          break;
        }
        case "volume": {
          const o = { ...blocksOf(p, "volume")[i]!, ...r } as (typeof p.overrides)[number];
          q = { ...q, overrides: [...q.overrides, o].sort((a, b2) => a.startMs - b2.startMs) };
          obj = o;
          break;
        }
        case "motion3d": {
          // keyframe times are fractions of the block (0..1), so they move with it unchanged
          const m = { ...p.motion3d[i]!, ...r, id: newId("m3d") };
          q = { ...q, motion3d: [...q.motion3d, m].sort((a, b2) => a.startMs - b2.startMs) };
          obj = m;
          break;
        }
      }
      added.push({ track, obj, at: r.startMs });
    }
  }
  const refs: Array<BlockRef & { at: number }> = added.map(({ track, obj, at }) => {
    const index =
      track === "slide" ? q.slides.indexOf(obj as (typeof q.slides)[number]) : (blocksOf(q, track) as object[]).indexOf(obj);
    return { track, index, at };
  });
  const out = normalizeWithRefs(q, refs);
  return { ...out, skipped };
}

/** Every block of one track, or of every track. */
export function selectAllItems(p: ProjectConfig, track?: TrackKind): BlockRef[] {
  const out: BlockRef[] = [];
  for (const t of track ? [track] : TRACK_KINDS) blocksOf(p, t).forEach((_, index) => out.push({ track: t, index }));
  return out;
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
