/** Annotations lane packing (demand #9 UI fix): no overlaps, label room kept, rows reused. */
import { describe, expect, it } from "vitest";
import { labelWidth, overlaps, packLane, LABEL_MIN_PX } from "../src/state/laneLayout";

function rand(seed: number) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

describe("annotations lane packing", () => {
  it("never puts two blocks (with their label room) on the same row where they overlap", () => {
    const r = rand(7);
    for (let trial = 0; trial < 50; trial++) {
      const items = Array.from({ length: 5 + Math.floor(r() * 40) }, (_, i) => {
        const s = r() * 30000;
        return { startMs: s, endMs: s + 200 + r() * 5000, label: i % 3 ? "Click Save" : "step · Open the settings page" };
      });
      for (const pps of [20, 60, 200]) {
        const p = packLane(items, pps / 1000);
        expect(overlaps(p)).toEqual([]);
        // every span holds at least the block and the label room
        p.spans.forEach(([a, b], i) => {
          expect(b - a).toBeGreaterThanOrEqual(Math.max((items[i]!.endMs - items[i]!.startMs) * (pps / 1000), labelWidth(items[i]!.label)) - 1e-9);
        });
      }
    }
  });

  it("uses one row when nothing overlaps and reuses freed rows", () => {
    const items = [0, 4000, 8000].map((s) => ({ startMs: s, endMs: s + 3000, label: "Box" }));
    expect(packLane(items, 0.1).rowCount).toBe(1);
    const stacked = [
      { startMs: 0, endMs: 5000, label: "a" },
      { startMs: 1000, endMs: 3000, label: "b" },
      { startMs: 6000, endMs: 7000, label: "c" },
    ];
    const p = packLane(stacked, 0.1);
    expect(p.rows).toEqual([0, 1, 0]);
  });

  it("a short block reserves room for its label so a neighbour cannot sit on it", () => {
    // 100 ms at 0.05 px/ms = 5 px wide; the next item starts 20 px later: same time-row would overlap the label
    const p = packLane([{ startMs: 0, endMs: 100, label: "Open Settings" }, { startMs: 400, endMs: 3000, label: "x" }], 0.05);
    expect(p.rows[0]).not.toBe(p.rows[1]);
    expect(labelWidth("x")).toBe(LABEL_MIN_PX);
  });
});
