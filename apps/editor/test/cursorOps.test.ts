import { describe, expect, it } from "vitest";
import { cursorShapeRuns, resolveProject } from "@lens/engine";
import { setShapeOverride, shapeOverrideCount } from "../src/state/cursorOps";
import { SHAPE_PRIMS, SPRITE_SHAPES } from "../src/render/cursorSprite";
import { CURSOR_SHAPES } from "@lens/engine";

describe("cursor type overrides (demand #12)", () => {
  const p = resolveProject({ overrides: [{ startMs: 500, endMs: 900, cursor: { size: 3 } }, { startMs: 0, endMs: 400, volume: 0.5 }] });

  it("adds, replaces (newest wins, no pile-up) and clears with Auto", () => {
    let q = setShapeOverride(p, 1000, 3000, "pointer");
    expect(shapeOverrideCount(q)).toBe(1);
    q = setShapeOverride(q, 2000, 2500, "text");
    // pointer split around the new text range
    expect(q.overrides.filter((o) => o.cursor?.shape).map((o) => [o.startMs, o.endMs, o.cursor!.shape])).toEqual([[1000, 2000, "pointer"], [2000, 2500, "text"], [2500, 3000, "pointer"]]);
    const runs = cursorShapeRuns([], 5000, { ...q.cursor, matchHover: true }, q.overrides);
    expect(runs.map((r) => [r.startMs, r.endMs, r.shape])).toEqual([[0, 1000, "arrow"], [1000, 2000, "pointer"], [2000, 2500, "text"], [2500, 3000, "pointer"], [3000, 5000, "arrow"]]);
    q = setShapeOverride(q, 0, 5000, "auto");
    expect(shapeOverrideCount(q)).toBe(0);
    // overrides that are not about the type are untouched
    expect(q.overrides).toEqual(p.overrides.slice().sort((a, b) => a.startMs - b.startMs));
  });

  it("keeps the other fields of a mixed override", () => {
    const m = resolveProject({ overrides: [{ startMs: 0, endMs: 1000, cursor: { hidden: false, shape: "wait" } }] });
    const q = setShapeOverride(m, 0, 1000, "auto");
    expect(q.overrides).toEqual([{ startMs: 0, endMs: 1000, cursor: { hidden: false } }]);
  });

  it("has art for every engine cursor type", () => {
    for (const s of CURSOR_SHAPES) expect(SPRITE_SHAPES, s).toContain(s);
    for (const def of Object.values(SHAPE_PRIMS)) {
      for (const pr of def.prims) {
        const pts = "poly" in pr ? pr.poly : "ring" in pr ? [[pr.ring[0] - pr.ring[2], pr.ring[1] - pr.ring[2]], [pr.ring[0] + pr.ring[2], pr.ring[1] + pr.ring[2]]] : [[pr.capsule[0], pr.capsule[1]], [pr.capsule[2], pr.capsule[3]]];
        for (const [x, y] of pts) {
          expect(x).toBeGreaterThanOrEqual(0.05);
          expect(x).toBeLessThanOrEqual(0.95);
          expect(y).toBeGreaterThanOrEqual(0.05);
          expect(y).toBeLessThanOrEqual(0.95);
        }
      }
    }
  });
});
