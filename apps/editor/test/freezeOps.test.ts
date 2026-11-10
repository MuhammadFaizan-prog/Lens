/**
 * Freeze lane edits (demand #20): add / move / resize / delete / duplicate / select-all of hold
 * freezes go through the same block ops as every other lane, and freezes never overlap each other.
 */
import { describe, expect, it } from "vitest";
import { buildRenderPlan, defaultProject, resolveProject, videoTime } from "@lens/engine";
import type { RecordingMeta } from "@lens/engine";
import { addBlock, blocksOf, canOverlap, deleteBlock, duplicateBlocks, moveBlocks, selectAllItems, updateBlock } from "../src/state/timelineOps";

const META: RecordingMeta = { width: 1280, height: 720, fps: 30, durationMs: 10000, pixelRatio: 1 };

describe("freeze lane", () => {
  it("adds a live-cursor hold at the range, sorted by start", () => {
    let p = defaultProject();
    p = addBlock(p, "freeze", { startMs: 5000, endMs: 7000 }).project;
    const r = addBlock(p, "freeze", { startMs: 1000, endMs: 2000 });
    expect(r.index).toBe(0);
    expect(r.project.freezes!.map((f) => [f.startMs, f.endMs, f.cursor])).toEqual([[1000, 2000, "live"], [5000, 7000, "live"]]);
    expect(blocksOf(r.project, "freeze")).toHaveLength(2);
    expect(canOverlap("freeze")).toBe(false);
  });

  it("move, resize, delete, duplicate and select-all", () => {
    let p = addBlock(defaultProject(), "freeze", { startMs: 1000, endMs: 2000 }).project;
    p = updateBlock(p, "freeze", 0, { endMs: 2500, cursor: "hide" });
    expect(p.freezes![0]).toMatchObject({ startMs: 1000, endMs: 2500, cursor: "hide" });
    const m = moveBlocks(p, [{ track: "freeze", index: 0 }], 500, 10000);
    expect(m.project.freezes![0]).toMatchObject({ startMs: 1500, endMs: 3000 });
    const d = duplicateBlocks(m.project, [{ track: "freeze", index: 0 }], 10000);
    expect(d.skipped).toBe(0);
    expect(d.project.freezes!.map((f) => [f.startMs, f.endMs])).toEqual([[1500, 3000], [3000, 4500]]);
    expect(new Set(d.project.freezes!.map((f) => f.id)).size).toBe(2);
    expect(selectAllItems(d.project, "freeze")).toHaveLength(2);
    expect(deleteBlock(d.project, "freeze", 0).freezes!.map((f) => f.startMs)).toEqual([3000]);
  });

  it("an edited project plans the hold (editor plan == engine plan)", () => {
    const p = resolveProject(addBlock(defaultProject(), "freeze", { startMs: 1000, endMs: 3000 }).project);
    const plan = buildRenderPlan({ meta: META, events: [], project: p });
    const held = plan.frames.filter((f) => f.src >= 1000 && f.src < 3000);
    expect(held.length).toBe(2 * plan.output.fps);
    expect(held.every((f) => videoTime(f) === 1000)).toBe(true);
    expect(plan.output.durationMs).toBe(10000);
  });
});
