import { describe, expect, it } from "vitest";
import { applyStepDrafts, resolveProject, reviewSteps } from "@lens/engine";
import { addBlock, blocksOf, deleteBlock, updateBlock } from "../src/state/timelineOps";

describe("annotation + slide timeline ops", () => {
  it("adds a frame-anchored text block, moves it, deletes it", () => {
    const p0 = resolveProject({});
    const { project, index } = addBlock(p0, "annotation", { startMs: 1000, endMs: 4000 });
    expect(project.annotations[index]!.kind).toBe("text");
    expect(project.annotations[index]!.anchor).toBe("frame");
    const moved = updateBlock(project, "annotation", index, { startMs: 2000, endMs: 5000 });
    expect(blocksOf(moved, "annotation")[index]).toMatchObject({ startMs: 2000, endMs: 5000 });
    expect(() => resolveProject(moved)).not.toThrow();
    expect(deleteBlock(moved, "annotation", index).annotations).toHaveLength(0);
  });

  it("deleting an accepted step badge sends its draft back to review", () => {
    let p = resolveProject({});
    p = applyStepDrafts(p, [{ id: "s1", clickMs: 1000, x: 10, y: 10, label: "Click Save", target: "Save", verb: "Click", confidence: 0.9 }]);
    p = reviewSteps(p, null, "accepted");
    expect(p.annotations).toHaveLength(1);
    const q = deleteBlock(p, "annotation", 0);
    expect(q.annotations).toHaveLength(0);
    expect(q.stepLabels.drafts[0]!.state).toBe("pending");
  });

  it("slides are point blocks: moving one changes atMs, the duration stays", () => {
    const { project, index } = addBlock(resolveProject({}), "slide", { startMs: 3000, endMs: 3000 });
    expect(blocksOf(project, "slide")[index]).toEqual({ startMs: 3000, endMs: 3000 });
    const m = updateBlock(project, "slide", index, { startMs: 4500, endMs: 4500 });
    expect(m.slides[index]!.atMs).toBe(4500);
    expect(m.slides[index]!.durationMs).toBe(project.slides[index]!.durationMs);
  });
});
