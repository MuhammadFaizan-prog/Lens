import type { SpeedRange, TimeRange } from "./types.js";

/** One contiguous piece of kept source time and the rate it plays at (E01, E04). */
export interface TimelinePiece {
  srcStart: number;
  srcEnd: number;
  rate: number;
  outStart: number;
  outEnd: number;
}

export function mergeRanges(ranges: TimeRange[]): TimeRange[] {
  const sorted = [...ranges].filter((r) => r.endMs > r.startMs).sort((a, b) => a.startMs - b.startMs);
  const out: TimeRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.startMs <= last.endMs) last.endMs = Math.max(last.endMs, r.endMs);
    else out.push({ ...r });
  }
  return out;
}

/**
 * Build the edit timeline: remove cuts, then apply speed ranges (later ranges win on overlap).
 * Pure function; the plan builder uses it to map each output frame to a source time.
 */
export function buildTimeline(durationMs: number, cuts: TimeRange[], speed: SpeedRange[]): TimelinePiece[] {
  const cutList = mergeRanges(cuts.map((c) => ({ startMs: Math.max(0, c.startMs), endMs: Math.min(durationMs, c.endMs) })));
  const kept: TimeRange[] = [];
  let cursor = 0;
  for (const c of cutList) {
    if (c.startMs > cursor) kept.push({ startMs: cursor, endMs: c.startMs });
    cursor = Math.max(cursor, c.endMs);
  }
  if (cursor < durationMs) kept.push({ startMs: cursor, endMs: durationMs });

  // Boundaries from speed ranges split kept pieces.
  const bounds = new Set<number>();
  for (const s of speed) {
    bounds.add(s.startMs);
    bounds.add(s.endMs);
  }
  const pieces: TimelinePiece[] = [];
  let out = 0;
  for (const k of kept) {
    const cuts2 = [k.startMs, ...[...bounds].filter((b) => b > k.startMs && b < k.endMs).sort((a, b) => a - b), k.endMs];
    for (let i = 0; i + 1 < cuts2.length; i++) {
      const a = cuts2[i]!;
      const b = cuts2[i + 1]!;
      const mid = (a + b) / 2;
      let rate = 1;
      for (const s of speed) if (mid >= s.startMs && mid < s.endMs) rate = s.rate;
      const len = (b - a) / rate;
      pieces.push({ srcStart: a, srcEnd: b, rate, outStart: out, outEnd: out + len });
      out += len;
    }
  }
  return pieces;
}

export function outputDuration(pieces: TimelinePiece[]): number {
  return pieces.length ? pieces[pieces.length - 1]!.outEnd : 0;
}

export function outputToSource(pieces: TimelinePiece[], outMs: number): number {
  if (pieces.length === 0) return 0;
  for (const p of pieces) {
    if (outMs < p.outEnd) return p.srcStart + Math.max(0, outMs - p.outStart) * p.rate;
  }
  const last = pieces[pieces.length - 1]!;
  return last.srcEnd;
}

/** Map a source time to output time, or null if that moment was cut. */
export function sourceToOutput(pieces: TimelinePiece[], srcMs: number): number | null {
  for (const p of pieces) if (srcMs >= p.srcStart && srcMs < p.srcEnd) return p.outStart + (srcMs - p.srcStart) / p.rate;
  return null;
}
