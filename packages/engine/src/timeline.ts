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

/** Where a text slide sits on the output clock: [outStart, outEnd), holding source time srcAt. */
export interface SlideSpan {
  id: string;
  outStart: number;
  outEnd: number;
  srcAt: number;
}

/**
 * Insert full-frame slides into the edit timeline (demand #4 text slides). Each slide goes in at its
 * source time (inside a cut: where the cut is, i.e. before the next kept source); the piece there is
 * split and everything after it moves later by the slide's duration. Audio pieces are derived from
 * these pieces, so the audio after a slide shifts by exactly the same amount and stays in sync, and
 * the slide itself is silent. outputToSource holds the slide's source time during the slide.
 */
export function insertSlides(pieces: TimelinePiece[], slides: Array<{ id: string; atMs: number; durationMs: number }>): { pieces: TimelinePiece[]; spans: SlideSpan[] } {
  let ps = pieces.map((p) => ({ ...p }));
  const spans: SlideSpan[] = [];
  const order = slides.map((s, i) => ({ s, i })).sort((a, b) => a.s.atMs - b.s.atMs || a.i - b.i);
  for (const { s } of order) {
    const d = Math.max(0, s.durationMs);
    let idx = ps.findIndex((p) => s.atMs < p.srcEnd);
    let outAt: number;
    let srcAt: number;
    if (idx < 0) {
      // after the last kept source: at the end of the output
      const last = ps[ps.length - 1];
      outAt = Math.max(last ? last.outEnd : 0, spans.length ? spans[spans.length - 1]!.outEnd : 0);
      srcAt = last ? last.srcEnd : s.atMs;
      idx = ps.length;
    } else {
      const p = ps[idx]!;
      if (s.atMs > p.srcStart) {
        // split the piece at the slide
        const mid = p.outStart + (s.atMs - p.srcStart) / p.rate;
        const a = { ...p, srcEnd: s.atMs, outEnd: mid };
        const b = { ...p, srcStart: s.atMs, outStart: mid };
        ps.splice(idx, 1, a, b);
        idx += 1;
        outAt = mid;
        srcAt = s.atMs;
      } else {
        outAt = p.outStart;
        srcAt = p.srcStart;
      }
    }
    ps = ps.map((p, j) => (j >= idx ? { ...p, outStart: p.outStart + d, outEnd: p.outEnd + d } : p));
    for (const sp of spans) if (sp.outStart >= outAt) {
      sp.outStart += d;
      sp.outEnd += d;
    }
    spans.push({ id: s.id, outStart: outAt, outEnd: outAt + d, srcAt });
  }
  spans.sort((a, b) => a.outStart - b.outStart);
  return { pieces: ps, spans };
}
