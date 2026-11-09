/**
 * Annotations lane layout: overlapping items stack into sub-rows so no two blocks ever overlap,
 * and each block keeps room for a readable label.
 *
 * Packing happens in pixels at the current timeline zoom: an item occupies [x(start), x(start) +
 * max(width, label width)] plus a gap, so a short block's label (drawn after it when it does not
 * fit inside) never runs into the next block. Greedy by start time into the first free row.
 */

export const ROW_H = 20;
export const ROW_GAP = 2;
/** Label space a block reserves: about 7 px per character + padding, at least MIN, at most MAX. */
export const LABEL_MIN_PX = 44;
export const LABEL_MAX_PX = 150;
export const GAP_PX = 4;

export function labelWidth(label: string): number {
  return Math.max(LABEL_MIN_PX, Math.min(LABEL_MAX_PX, Math.round(label.length * 6.6 + 20)));
}

export interface LaneItem {
  startMs: number;
  endMs: number;
  label: string;
}

export interface PackedLane {
  /** Row of each item (input order). */
  rows: number[];
  rowCount: number;
  /** Occupied pixel span of each item: [x0, x1) including its label room (input order). */
  spans: Array<[number, number]>;
}

export function packLane(items: LaneItem[], pxPerMs: number): PackedLane {
  const spans = items.map((a): [number, number] => {
    const x0 = a.startMs * pxPerMs;
    const w = Math.max(4, (a.endMs - a.startMs) * pxPerMs);
    return [x0, x0 + Math.max(w, labelWidth(a.label))];
  });
  const order = items.map((_, i) => i).sort((i, j) => spans[i]![0] - spans[j]![0] || i - j);
  const ends: number[] = [];
  const rows = new Array<number>(items.length).fill(0);
  for (const i of order) {
    const [x0, x1] = spans[i]!;
    let r = ends.findIndex((e) => e + GAP_PX <= x0);
    if (r < 0) {
      r = ends.length;
      ends.push(x1);
    } else ends[r] = x1;
    rows[i] = r;
  }
  return { rows, rowCount: Math.max(1, ends.length), spans };
}

/** True when two packed items on the same row overlap (used by tests). */
export function overlaps(p: PackedLane): Array<[number, number]> {
  const bad: Array<[number, number]> = [];
  for (let i = 0; i < p.rows.length; i++)
    for (let j = i + 1; j < p.rows.length; j++) {
      if (p.rows[i] !== p.rows[j]) continue;
      const [a0, a1] = p.spans[i]!;
      const [b0, b1] = p.spans[j]!;
      if (a0 < b1 && b0 < a1) bad.push([i, j]);
    }
  return bad;
}
