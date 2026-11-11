/**
 * Cursor types over time (demand #12: the cursor matches the UI under it).
 *
 * Where a type comes from, lowest priority first:
 *  1. "recorded": `cursor-shape` events in the log (the desktop recorder writes them where the OS
 *     reports the system cursor: Windows, GetCursorInfo);
 *  2. "inferred": when the log has none and `cursor.matchHover` is on, a conservative guess from the
 *     input alone: the I-beam over a spot the user clicked and then typed into (a text field), from the
 *     moment the cursor came to rest there until it leaves. Nothing else is guessed (a click on a
 *     native Windows button shows the arrow, a link shows the hand; the log cannot tell them apart);
 *  3. "override": a per-segment `overrides[].cursor.shape` set in the editor.
 * A change of type is drawn as a short crossfade (SHAPE_SWAP_MS) unless the project predates this
 * (matchHover absent and no shape overrides), which keeps old plans byte-identical.
 */
import type { CursorShape, InputEvent, SegmentOverride } from "./types.js";
import type { ProjectConfig } from "./project.js";

export const CURSOR_SHAPES: CursorShape[] = [
  "arrow", "pointer", "text", "grab", "grabbing", "crosshair",
  "resize-ew", "resize-ns", "resize-nwse", "resize-nesw", "move", "wait", "not-allowed",
];

export const CURSOR_SHAPE_LABELS: Record<CursorShape, string> = {
  arrow: "Arrow",
  pointer: "Hand (link / button)",
  text: "Text I-beam",
  grab: "Grab (open hand)",
  grabbing: "Grabbing",
  crosshair: "Crosshair",
  "resize-ew": "Resize ↔",
  "resize-ns": "Resize ↕",
  "resize-nwse": "Resize ⤡",
  "resize-nesw": "Resize ⤢",
  move: "Move",
  wait: "Busy",
  "not-allowed": "Not allowed",
};

/** Crossfade time between two cursor types. */
export const SHAPE_SWAP_MS = 100;

export type ShapeSource = "recorded" | "inferred" | "default" | "override";

export interface ShapeRun {
  startMs: number;
  endMs: number;
  shape: CursorShape;
  source: ShapeSource;
}

export interface ShapeChange {
  t: number;
  shape: CursorShape;
}

/** Heuristic tuning (inferCursorShapes). */
export const INFER = {
  /** Typed keys (not shortcuts) after a click that make the clicked spot a text field. */
  minKeys: 2,
  /** ... within this long after the click (and before the next click). */
  typeWindowMs: 2500,
  /** The I-beam starts when the cursor came within this radius of the click (src px) ... */
  arriveRadius: 16,
  /** ... but at most this long before the click. */
  maxLeadMs: 800,
  /** It ends when the cursor moves this far from the click point. */
  leaveRadius: 24,
};

const isTypingKey = (e: InputEvent): boolean => e.type === "key" && !e.modifiers.some((m) => m === "cmd" || m === "ctrl" || m === "alt" || m === "meta");

/** Recorded cursor-type changes in the log, in time order. */
export function recordedShapes(events: InputEvent[]): ShapeChange[] {
  return events
    .filter((e): e is Extract<InputEvent, { type: "cursor-shape" }> => e.type === "cursor-shape" && CURSOR_SHAPES.includes(e.shape))
    .map((e) => ({ t: e.t, shape: e.shape }))
    .sort((a, b) => a.t - b.t);
}

/** Conservative cursor types from the input alone (see the file header). */
export function inferCursorShapes(events: InputEvent[], durationMs = Infinity): ShapeChange[] {
  const pos = events.filter((e): e is InputEvent & { x: number; y: number } => "x" in e && "y" in e).sort((a, b) => a.t - b.t);
  const downs = events.filter((e): e is Extract<InputEvent, { type: "down" }> => e.type === "down" && e.button === "left").sort((a, b) => a.t - b.t);
  const keys = events.filter(isTypingKey).map((e) => e.t).sort((a, b) => a - b);
  const runs: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < downs.length; i++) {
    const d = downs[i]!;
    const next = downs[i + 1]?.t ?? Infinity;
    const until = Math.min(next, d.t + INFER.typeWindowMs);
    const typed = keys.filter((t) => t > d.t && t < until).length;
    if (typed < INFER.minKeys) continue;
    // arrival: the earliest time (>= click - maxLeadMs) from which every logged position stays near the click
    let start = d.t;
    for (let j = pos.length - 1; j >= 0; j--) {
      const p = pos[j]!;
      if (p.t > d.t) continue;
      if (p.t < d.t - INFER.maxLeadMs) break;
      if (Math.hypot(p.x - d.x, p.y - d.y) > INFER.arriveRadius) break;
      start = p.t;
    }
    // departure: the first position after the click that is far from it
    let end = Math.min(durationMs, Infinity);
    for (const p of pos) {
      if (p.t <= d.t) continue;
      if (Math.hypot(p.x - d.x, p.y - d.y) > INFER.leaveRadius) {
        end = p.t;
        break;
      }
    }
    // another click elsewhere also ends it
    if (next < end) {
      const n = downs[i + 1]!;
      if (Math.hypot(n.x - d.x, n.y - d.y) > INFER.leaveRadius) end = next;
    }
    if (end <= start) continue;
    const prev = runs[runs.length - 1];
    if (prev && start <= prev.end) prev.end = Math.max(prev.end, end);
    else runs.push({ start, end });
  }
  const out: ShapeChange[] = [];
  for (const r of runs) {
    out.push({ t: r.start, shape: "text" });
    if (Number.isFinite(r.end)) out.push({ t: r.end, shape: "arrow" });
  }
  return out;
}

/** The project uses the cursor-type feature's new behaviour (crossfade); old projects stay byte-identical. */
export function shapeSwapEnabled(cfg: ProjectConfig["cursor"], overrides: SegmentOverride[]): boolean {
  return cfg.matchHover !== undefined || overrides.some((o) => o.cursor?.shape !== undefined);
}

/**
 * The base cursor type changes (before per-segment overrides) and where they came from.
 * matchHover false: the arrow throughout.
 */
export function baseShapeChanges(events: InputEvent[], cfg: ProjectConfig["cursor"], durationMs = Infinity): { changes: ShapeChange[]; source: ShapeSource } {
  if (cfg.matchHover === false) return { changes: [], source: "default" };
  const rec = recordedShapes(events);
  if (rec.length || cfg.matchHover !== true) return { changes: rec, source: rec.length ? "recorded" : "default" };
  const inf = inferCursorShapes(events, durationMs);
  return { changes: inf, source: inf.length ? "inferred" : "default" };
}

/** Cursor type runs covering [0, durationMs), overrides applied, adjacent equal runs merged. */
export function cursorShapeRuns(events: InputEvent[], durationMs: number, cfg: ProjectConfig["cursor"], overrides: SegmentOverride[] = []): ShapeRun[] {
  const { changes, source } = baseShapeChanges(events, cfg, durationMs);
  let runs: ShapeRun[] = [];
  let cur: ShapeRun = { startMs: 0, endMs: durationMs, shape: "arrow", source: "default" };
  for (const c of changes) {
    if (c.t <= 0) {
      cur.shape = c.shape;
      cur.source = source;
      continue;
    }
    if (c.t >= durationMs) break;
    if (c.shape === cur.shape) continue;
    cur.endMs = c.t;
    runs.push(cur);
    cur = { startMs: c.t, endMs: durationMs, shape: c.shape, source: c.shape === "arrow" && source === "inferred" ? "default" : source };
  }
  runs.push(cur);
  // overrides, later ones win
  for (const o of overrides) {
    const sh = o.cursor?.shape;
    if (sh === undefined) continue;
    const a = Math.max(0, o.startMs);
    const b = Math.min(durationMs, o.endMs);
    if (b <= a) continue;
    const next: ShapeRun[] = [];
    for (const r of runs) {
      if (r.endMs <= a || r.startMs >= b) {
        next.push(r);
        continue;
      }
      if (r.startMs < a) next.push({ ...r, endMs: a });
      if (r.endMs > b) next.push({ ...r, startMs: b });
    }
    next.push({ startMs: a, endMs: b, shape: sh, source: "override" });
    runs = next.sort((x, y) => x.startMs - y.startMs);
  }
  const merged: ShapeRun[] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && last.shape === r.shape && last.source === r.source && Math.abs(last.endMs - r.startMs) < 1e-6) last.endMs = r.endMs;
    else merged.push({ ...r });
  }
  return merged;
}

/** Cursor type at t, and the crossfade from the previous type while within SHAPE_SWAP_MS of a change. */
export function shapeAt(runs: ShapeRun[], t: number, swap: boolean): { shape: CursorShape; from?: CursorShape; mix?: number } {
  let i = 0;
  while (i < runs.length - 1 && runs[i + 1]!.startMs <= t) i++;
  const r = runs[i]!;
  if (!swap || i === 0) return { shape: r.shape };
  const prev = runs[i - 1]!;
  const u = (t - r.startMs) / SHAPE_SWAP_MS;
  if (prev.shape === r.shape || u >= 1 || u < 0) return { shape: r.shape };
  const s = u * u * (3 - 2 * u);
  return { shape: r.shape, from: prev.shape, mix: s };
}
