import { describe, expect, it } from "vitest";
import { resolveProject } from "@lens/engine";
import { effectiveCutTransition, projectTransitions, setCutTransition, setProjectTransitions } from "../src/state/transitionOps";
import { normalizeCuts } from "../src/state/timelineOps";

describe("transition ops (demand #14)", () => {
  const p = resolveProject({ edits: { cuts: [{ startMs: 1000, endMs: 2000 }, { startMs: 4000, endMs: 5000 }] } });

  it("absent config reads as hard cuts; the first change starts from the default", () => {
    expect(projectTransitions(p).kind).toBe("none");
    const q = setProjectTransitions(p, { kind: "push" });
    expect(q.transitions).toEqual({ kind: "push", durationMs: 500, easing: "ease-in-out", scope: "manual" });
    expect(effectiveCutTransition(q, 1)).toEqual({ kind: "push", durationMs: 500, easing: "ease-in-out", own: false });
    expect(() => resolveProject(q)).not.toThrow();
  });

  it("per-cut transition patches, clears back to the default, and survives normalizeCuts", () => {
    let q = setCutTransition(setProjectTransitions(p, { kind: "crossfade" }), 0, { kind: "blur" });
    q = setCutTransition(q, 0, { durationMs: 300 });
    expect(q.edits.cuts[0]!.transition).toEqual({ kind: "blur", durationMs: 300 });
    expect(effectiveCutTransition(q, 0)).toEqual({ kind: "blur", durationMs: 300, easing: "ease-in-out", own: true });
    expect(normalizeCuts(q).edits.cuts[0]!.transition).toEqual({ kind: "blur", durationMs: 300 });
    const r = setCutTransition(q, 0, null);
    expect("transition" in r.edits.cuts[0]!).toBe(false);
    expect(effectiveCutTransition(r, 0).kind).toBe("crossfade");
    expect(() => resolveProject(r)).not.toThrow();
  });
});
