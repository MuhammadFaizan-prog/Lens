import { clicks, detectTyping, rawCursorAt, DEFAULT_TYPING } from "./events.js";
import type { InputEvent, RecordingMeta, ZoomSegment } from "./types.js";
import type { ProjectConfig } from "./project.js";

interface Activity {
  t: number;
  tEnd: number;
  x: number;
  y: number;
  kind: "click" | "typing";
}

/**
 * Auto-zoom planner (B01). Turns clicks and typing stretches into zoom segments:
 * 1. collect activities, 2. cluster by time gap and by whether the cluster still fits a zoomed
 * viewport, 3. pick the largest scale (<= defaultScale) that keeps the whole cluster in view,
 * 4. add lead-in and hold, 5. let adjacent zooms hand off with a pan instead of zooming out,
 * 6. drop auto zooms that overlap user-placed (manual) zooms.
 */
export function planAutoZoom(events: InputEvent[], meta: RecordingMeta, cfg: ProjectConfig["zoom"]): ZoomSegment[] {
  const acts: Activity[] = [];
  for (const c of clicks(events)) acts.push({ t: c.t, tEnd: c.t, x: c.x, y: c.y, kind: "click" });
  for (const r of detectTyping(events, DEFAULT_TYPING)) {
    const p = rawCursorAt(events, r.startMs) ?? { x: meta.width / 2, y: meta.height / 2 };
    acts.push({ t: r.startMs, tEnd: r.endMs, x: p.x, y: p.y, kind: "typing" });
  }
  acts.sort((a, b) => a.t - b.t);

  const margin = 1.35; // breathing room around the cluster
  const fitScale = (minX: number, minY: number, maxX: number, maxY: number) => {
    const w = Math.max(1, (maxX - minX) * margin);
    const h = Math.max(1, (maxY - minY) * margin);
    return Math.min(cfg.defaultScale, meta.width / w, meta.height / h);
  };

  const clusters: Activity[][] = [];
  let cur: Activity[] = [];
  let bbox = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let lastEnd = -Infinity;
  for (const a of acts) {
    const nb = cur.length
      ? { minX: Math.min(bbox.minX, a.x), minY: Math.min(bbox.minY, a.y), maxX: Math.max(bbox.maxX, a.x), maxY: Math.max(bbox.maxY, a.y) }
      : { minX: a.x, minY: a.y, maxX: a.x, maxY: a.y };
    const tooLate = a.t - lastEnd > cfg.mergeGapMs;
    const tooWide = fitScale(nb.minX, nb.minY, nb.maxX, nb.maxY) < cfg.minScale;
    if (cur.length && (tooLate || tooWide)) {
      clusters.push(cur);
      cur = [a];
      bbox = { minX: a.x, minY: a.y, maxX: a.x, maxY: a.y };
    } else {
      cur.push(a);
      bbox = nb;
    }
    lastEnd = Math.max(lastEnd, a.tEnd);
  }
  if (cur.length) clusters.push(cur);

  const values: number[] = [];
  let segs: ZoomSegment[] = clusters.map((cl, i) => {
    values.push(clusterValue(cl));
    const xs = cl.map((a) => a.x);
    const ys = cl.map((a) => a.y);
    const scale = Math.max(cfg.minScale, fitScale(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)));
    const start = Math.max(0, cl[0]!.t - cfg.leadMs);
    let end = Math.min(meta.durationMs, Math.max(...cl.map((a) => a.tEnd)) + cfg.holdMs);
    if (end - start < cfg.minDurationMs) end = Math.min(meta.durationMs, start + cfg.minDurationMs);
    return { id: `auto-${i + 1}`, startMs: start, endMs: end, scale: round2(scale), focus: "follow", style: cfg.style, auto: true };
  });

  if (cfg.budget?.enabled) segs = applyZoomBudget(segs, values, cfg.budget, meta.durationMs);

  // Hand-off: when one zoom's hold runs into the next zoom's lead, pan directly (no zoom out).
  for (let i = 0; i + 1 < segs.length; i++) {
    const a = segs[i]!;
    const b = segs[i + 1]!;
    if (a.endMs > b.startMs) a.endMs = b.startMs;
  }
  segs = segs.filter((s) => s.endMs - s.startMs > 100);

  const manual = cfg.segments.filter((s) => !s.auto);
  const overlaps = (a: ZoomSegment, b: ZoomSegment) => a.startMs < b.endMs && b.startMs < a.endMs;
  return segs.filter((s) => !manual.some((m) => overlaps(s, m)));
}

/** How much a cluster is worth zooming for: each click counts 1, typing counts 1 per second typed (min 1). */
function clusterValue(cl: Activity[]): number {
  return cl.reduce((v, a) => v + (a.kind === "click" ? 1 : Math.max(1, (a.tEnd - a.t) / 1000)), 0);
}

export interface ZoomBudget {
  enabled: boolean;
  /** At most this many zooms may start inside any 60 s window. */
  maxPerMinute: number;
  /** Every zoom stays in for at least this long (ms); zooms that would overlap merge into one framing. */
  minHoldMs: number;
}

/**
 * Zoom budget ("calm camera", demand report #2). Applied to auto zooms only, in source time:
 * 1. every zoom is held for at least minHoldMs;
 * 2. zooms that now overlap merge into one framing (the wider of the two scales, values add up);
 * 3. the most valuable zooms are kept while no 60 s window holds more than maxPerMinute starts.
 * Pure and deterministic; ties keep the earlier zoom.
 */
export function applyZoomBudget(segs: ZoomSegment[], values: number[], budget: ZoomBudget, durationMs: number): ZoomSegment[] {
  const items = segs
    .map((s, i) => ({ seg: { ...s }, value: values[i] ?? 1 }))
    .sort((a, b) => a.seg.startMs - b.seg.startMs);
  for (const it of items) it.seg.endMs = Math.min(durationMs, Math.max(it.seg.endMs, it.seg.startMs + budget.minHoldMs));
  const merged: typeof items = [];
  for (const it of items) {
    const last = merged[merged.length - 1];
    if (last && it.seg.startMs < last.seg.endMs) {
      last.seg.endMs = Math.max(last.seg.endMs, it.seg.endMs);
      last.seg.scale = Math.min(last.seg.scale, it.seg.scale);
      last.value += it.value;
    } else merged.push(it);
  }
  const max = Math.max(0, Math.floor(budget.maxPerMinute));
  const order = merged.map((m, i) => i).sort((a, b) => merged[b]!.value - merged[a]!.value || a - b);
  const kept: number[] = [];
  const fits = (start: number) => {
    const starts = [...kept.map((i) => merged[i]!.seg.startMs), start];
    // Any 60 s window containing `start` begins at one of the starts in (start - 60 s, start].
    for (const w of starts) {
      if (w > start || w <= start - 60000) continue;
      if (starts.filter((s) => s >= w && s < w + 60000).length > max) return false;
    }
    return true;
  };
  for (const i of order) if (fits(merged[i]!.seg.startMs)) kept.push(i);
  return kept.sort((a, b) => a - b).map((i, n) => ({ ...merged[i]!.seg, id: `auto-${n + 1}` }));
}

/** Count zoom starts in the busiest 60 s window. */
export function maxZoomsPerMinute(segs: Array<{ startMs: number }>): number {
  let best = 0;
  for (const a of segs) best = Math.max(best, segs.filter((b) => b.startMs >= a.startMs && b.startMs < a.startMs + 60000).length);
  return best;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** All zoom segments in effect: manual segments plus auto segments when auto zoom is on. */
export function effectiveZoomSegments(events: InputEvent[], meta: RecordingMeta, cfg: ProjectConfig["zoom"]): ZoomSegment[] {
  const manual = cfg.segments.filter((s) => !s.auto);
  const auto = cfg.auto ? planAutoZoom(events, meta, cfg) : cfg.segments.filter((s) => s.auto);
  return [...manual, ...auto].sort((a, b) => a.startMs - b.startMs);
}
