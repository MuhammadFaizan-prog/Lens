/**
 * Per-segment cursor type overrides (demand #12). A type override is a SegmentOverride carrying only
 * `cursor.shape`; setting a range removes (trims / splits) the type part of any override under it, so
 * the newest choice wins and nothing piles up.
 */
import type { CursorShape, ProjectConfig, SegmentOverride } from "@lens/engine";

export function setShapeOverride(p: ProjectConfig, startMs: number, endMs: number, shape: CursorShape | "auto"): ProjectConfig {
  const a = Math.max(0, Math.round(startMs));
  const b = Math.round(endMs);
  if (b <= a) return p;
  const out: SegmentOverride[] = [];
  for (const o of p.overrides) {
    if (o.cursor?.shape === undefined || o.endMs <= a || o.startMs >= b) {
      out.push(o);
      continue;
    }
    // the part of o under [a, b) loses its shape; other fields (hidden, size, volume) stay on the whole range
    const { shape: _drop, ...restCursor } = o.cursor;
    const hasOther = Object.keys(restCursor).length > 0 || o.volume !== undefined;
    if (hasOther) out.push({ ...o, cursor: Object.keys(restCursor).length ? restCursor : undefined } as SegmentOverride);
    if (o.startMs < a) out.push({ startMs: o.startMs, endMs: a, cursor: { shape: o.cursor.shape } });
    if (o.endMs > b) out.push({ startMs: b, endMs: o.endMs, cursor: { shape: o.cursor.shape } });
  }
  if (shape !== "auto") out.push({ startMs: a, endMs: b, cursor: { shape } });
  const clean = out.map((o) => {
    if (o.cursor === undefined) {
      const { cursor: _c, ...r } = o;
      return r as SegmentOverride;
    }
    return o;
  });
  return { ...p, overrides: clean.sort((x, y) => x.startMs - y.startMs) };
}

/** Number of type overrides in the project. */
export function shapeOverrideCount(p: ProjectConfig): number {
  return p.overrides.filter((o) => o.cursor?.shape !== undefined).length;
}
