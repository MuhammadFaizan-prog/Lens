import { describe, expect, it } from "vitest";
import {
  buildCursorTrack,
  buildRenderPlan,
  cursorShapeRuns,
  defaultProject,
  inferCursorShapes,
  resolveProject,
  SHAPE_SWAP_MS,
  type InputEvent,
  type ProjectConfig,
} from "../src/index.js";
import { META, click, move, typing } from "./fixtures.js";
import { goldenCases, planHashOf } from "./cursorShapesGolden.js";

// computed from main 7d1a5db with the same cases (cursorShapesGolden.ts)
const GOLDEN: Record<string, string> = {
  "no types": "16aacac37bb0e438c382c4fea387ae96651b580c26407c74583e2b8b7aa28f3a",
  "logged types (legacy)": "bcfcafbeac2248f7536678c80b652085888c11f9f229b90db38837ede5dac9cc",
  "fixed shape": "7f1441f2cd3ce7f9434b11e37aef2167071119b05712efc04b7ff671a9c7f5cb",
  "overrides without shape": "a62efc2d04d851aa79db015048c6fa983b81c53a5396ec99c6b59f7a7762cd01",
};

const cfg = (patch: Partial<ProjectConfig["cursor"]> = {}): ProjectConfig["cursor"] => ({ ...defaultProject().cursor, hideWhenIdle: false, ...patch });

/** Click a field at (400, 300) at 1000 ms, type, then leave to (900, 600) at 3000 ms; a plain click on (1200, 200) at 5000 ms. */
function fieldSession(): InputEvent[] {
  return [
    ...move([100, 100], [400, 300], 0, 600),
    ...click(400, 300, 1000),
    ...typing("hello", 1300),
    ...move([400, 300], [900, 600], 3000, 400),
    ...move([900, 600], [1200, 200], 4000, 600),
    ...click(1200, 200, 5000),
  ].sort((a, b) => a.t - b.t);
}

describe("cursor types (demand #12)", () => {
  it("plans of projects without the feature are byte-identical to main 7d1a5db", () => {
    for (const c of goldenCases()) expect(planHashOf(c.project, c.events), c.name).toBe(GOLDEN[c.name]);
  });

  it("infers the I-beam only where the user clicked and typed", () => {
    const ch = inferCursorShapes(fieldSession(), 8000);
    expect(ch.map((c) => c.shape)).toEqual(["text", "arrow"]);
    // starts once the cursor is within 16 px of the click (the eased move gets there before it ends at
    // 600 ms), never more than 800 ms before the click; leaves on the first move > 24 px
    expect(ch[0]!.t).toBeGreaterThanOrEqual(200);
    expect(ch[0]!.t).toBeLessThanOrEqual(600);
    expect(ch[0]!.t).toBeLessThanOrEqual(1000);
    expect(ch[1]!.t).toBeGreaterThan(3000);
    expect(ch[1]!.t).toBeLessThan(3150);
    // a click with no typing after it guesses nothing
    expect(inferCursorShapes([...click(1200, 200, 5000)])).toEqual([]);
    // shortcuts are not typing
    const sc: InputEvent[] = [...click(10, 10, 100), { t: 300, type: "key", key: "s", modifiers: ["ctrl"] }, { t: 400, type: "key", key: "c", modifiers: ["ctrl"] }];
    expect(inferCursorShapes(sc)).toEqual([]);
  });

  it("recorded types win over inference; matchHover false is the arrow; absent = recorded only", () => {
    const rec: InputEvent[] = [...fieldSession(), { t: 4500, type: "cursor-shape", shape: "pointer" }, { t: 5500, type: "cursor-shape", shape: "arrow" }];
    const on = cursorShapeRuns(rec, 8000, cfg({ matchHover: true }));
    expect(on.map((r) => [r.shape, r.source])).toEqual([["arrow", "default"], ["pointer", "recorded"], ["arrow", "recorded"]]);
    expect(cursorShapeRuns(rec, 8000, cfg({ matchHover: false })).map((r) => r.shape)).toEqual(["arrow"]);
    // absent (old projects): logged types as before, never a guess
    expect(cursorShapeRuns(fieldSession(), 8000, cfg()).map((r) => r.shape)).toEqual(["arrow"]);
    const inf = cursorShapeRuns(fieldSession(), 8000, cfg({ matchHover: true }));
    expect(inf.map((r) => [r.shape, r.source])).toEqual([["arrow", "default"], ["text", "inferred"], ["arrow", "default"]]);
  });

  it("per-segment overrides split runs and win over everything", () => {
    const rec: InputEvent[] = [{ t: 0, type: "move", x: 0, y: 0 }, { t: 2000, type: "cursor-shape", shape: "pointer" }, { t: 6000, type: "cursor-shape", shape: "arrow" }];
    const runs = cursorShapeRuns(rec, 8000, cfg({ matchHover: true }), [
      { startMs: 3000, endMs: 4000, cursor: { shape: "resize-ew" } },
      { startMs: 3500, endMs: 5000, cursor: { shape: "wait" } },
      { startMs: 7000, endMs: 7500, cursor: { size: 2 } },
    ]);
    expect(runs.map((r) => [r.startMs, r.endMs, r.shape, r.source])).toEqual([
      [0, 2000, "arrow", "default"],
      [2000, 3000, "pointer", "recorded"],
      [3000, 3500, "resize-ew", "override"],
      [3500, 5000, "wait", "override"],
      [5000, 6000, "pointer", "recorded"],
      [6000, 8000, "arrow", "recorded"],
    ]);
  });

  it("swaps with a crossfade of SHAPE_SWAP_MS, monotonic, only on projects using the feature", () => {
    const ev: InputEvent[] = [{ t: 0, type: "move", x: 500, y: 500 }, { t: 1000, type: "cursor-shape", shape: "pointer" }];
    const meta = { ...META, durationMs: 2000 };
    const fps = 60;
    const tr = buildCursorTrack(ev, meta, cfg({ matchHover: true }), fps);
    const swap = tr.filter((s) => s.fromShape !== undefined);
    expect(swap.length).toBe(Math.ceil((SHAPE_SWAP_MS / 1000) * fps));
    expect(swap.every((s) => s.fromShape === "arrow" && s.shape === "pointer")).toBe(true);
    for (let i = 1; i < swap.length; i++) expect(swap[i]!.mix!).toBeGreaterThan(swap[i - 1]!.mix!);
    expect(swap[0]!.t).toBeCloseTo(1000, 0);
    // legacy (matchHover absent, no shape overrides): hard swap exactly as before
    expect(buildCursorTrack(ev, meta, cfg(), fps).some((s) => s.fromShape !== undefined)).toBe(false);
    // the plan carries the two extra fields only inside the swap
    const plan = buildRenderPlan({ meta, events: ev, project: resolveProject({ output: { resolution: 360, fps: 30 }, cursor: { matchHover: true, hideWhenIdle: false } }) });
    const long = plan.frames.filter((f) => f.cur && f.cur.length === 7);
    expect(long.length).toBeGreaterThanOrEqual(2);
    expect(long.length).toBeLessThanOrEqual(4);
    for (const f of long) {
      expect(f.cur![5]).toBe("arrow");
      expect(f.cur![4]).toBe("pointer");
    }
    expect(plan.frames.filter((f) => f.cur && f.cur.length === 5 && f.src > 1200).every((f) => f.cur![4] === "pointer")).toBe(true);
  });

  it("theme goes to the plan style only when set; shapes are validated", () => {
    const p = buildRenderPlan({ meta: { ...META, durationMs: 500 }, events: [], project: resolveProject({ output: { resolution: 360, fps: 30 }, cursor: { theme: "light" } }) });
    expect(p.style.cursorTheme).toBe("light");
    const q = buildRenderPlan({ meta: { ...META, durationMs: 500 }, events: [], project: resolveProject({ output: { resolution: 360, fps: 30 } }) });
    expect("cursorTheme" in q.style).toBe(false);
    expect(() => resolveProject({ overrides: [{ startMs: 0, endMs: 10, cursor: { shape: "banana" } }] })).toThrow(/shape banana/);
    expect(() => resolveProject({ cursor: { theme: "neon" } })).toThrow(/theme neon/);
  });
});
