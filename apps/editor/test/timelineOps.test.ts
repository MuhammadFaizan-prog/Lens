import { describe, expect, it } from "vitest";
import { buildRenderPlan, cutsForDeletedWords, defaultProject, resolveProject } from "@lens/engine";
import type { InputEvent, RecordingMeta } from "@lens/engine";
import {
  addBlock,
  createRange,
  deleteBlock,
  frameAt,
  frameForSource,
  freeSpan,
  freezeAutoZooms,
  moveRange,
  normalizeCuts,
  resizeRange,
  snap,
  subtractRange,
  timecode,
  unfreezeAutoZooms,
  updateBlock,
} from "../src/state/timelineOps";
import { History } from "../src/state/history";

const META: RecordingMeta = { width: 1280, height: 720, fps: 30, durationMs: 10000, pixelRatio: 1 };
function clicks(): InputEvent[] {
  const ev: InputEvent[] = [];
  for (const [t, x, y] of [[1000, 200, 200], [5000, 1100, 600]] as const) {
    ev.push({ t: t - 300, type: "move", x, y }, { t, type: "down", x, y, button: "left" }, { t: t + 90, type: "up", x, y, button: "left" });
  }
  return ev;
}

describe("snap", () => {
  it("snaps to the nearest target inside the threshold only", () => {
    expect(snap(1040, { targets: [1000, 1100], thresholdMs: 50 })).toEqual({ t: 1000, snapped: 1000 });
    expect(snap(1060, { targets: [1000, 1100], thresholdMs: 50 })).toEqual({ t: 1100, snapped: 1100 });
    expect(snap(1300, { targets: [1000, 1100], thresholdMs: 50 })).toEqual({ t: 1300, snapped: null });
    expect(snap(1300, null).snapped).toBeNull();
  });
});

describe("move / resize / create", () => {
  it("moves keeping length, clamped to bounds", () => {
    expect(moveRange({ startMs: 1000, endMs: 2000 }, 500, 0, 10000)).toMatchObject({ startMs: 1500, endMs: 2500 });
    expect(moveRange({ startMs: 1000, endMs: 2000 }, -5000, 0, 10000)).toMatchObject({ startMs: 0, endMs: 1000 });
    expect(moveRange({ startMs: 1000, endMs: 2000 }, 9000, 0, 10000)).toMatchObject({ startMs: 9000, endMs: 10000 });
  });

  it("snaps whichever edge is closer to a target while moving", () => {
    const r = moveRange({ startMs: 1000, endMs: 2000 }, 480, 0, 10000, { targets: [2500, 3000], thresholdMs: 40 });
    expect(r).toMatchObject({ startMs: 1500, endMs: 2500, snapped: 2500 });
    const r2 = moveRange({ startMs: 1000, endMs: 2000 }, 1010, 0, 10000, { targets: [2000], thresholdMs: 40 });
    expect(r2).toMatchObject({ startMs: 2000, endMs: 3000, snapped: 2000 });
  });

  it("resizes an edge with a minimum length and snapping", () => {
    expect(resizeRange({ startMs: 1000, endMs: 2000 }, "end", 2990, 300, 0, 10000, { targets: [3000], thresholdMs: 20 })).toMatchObject({ endMs: 3000, snapped: 3000 });
    expect(resizeRange({ startMs: 1000, endMs: 2000 }, "start", 1900, 300, 0, 10000)).toMatchObject({ startMs: 1700, endMs: 2000 });
    expect(resizeRange({ startMs: 1000, endMs: 2000 }, "end", 20000, 300, 0, 10000)).toMatchObject({ endMs: 10000 });
  });

  it("creates into free space and refuses inside an existing block", () => {
    const blocks = [{ startMs: 2000, endMs: 3000 }, { startMs: 5000, endMs: 6000 }];
    expect(freeSpan(blocks, 4000, 10000)).toEqual([3000, 5000]);
    expect(createRange(blocks, 4500, 1500, 10000, 300)).toEqual({ startMs: 3500, endMs: 5000 });
    expect(createRange(blocks, 2500, 1000, 10000, 300)).toBeNull();
    expect(createRange(blocks, 3100, 1000, 10000, 300)).toEqual({ startMs: 3100, endMs: 4100 });
  });
});

describe("project edits", () => {
  it("adds, updates and deletes blocks on every track", () => {
    let p = defaultProject();
    for (const track of ["zoom", "cut", "speed", "mask"] as const) {
      const r = addBlock(p, track, { startMs: 1000, endMs: 2000 }, 1280, 720);
      p = r.project;
      expect(r.index).toBe(0);
      p = updateBlock(p, track, 0, { startMs: 1200 });
    }
    expect(p.zoom.segments[0]).toMatchObject({ startMs: 1200, endMs: 2000, auto: false, scale: 2 });
    expect(p.edits.cuts[0]).toEqual({ startMs: 1200, endMs: 2000 });
    expect(p.edits.speed[0]).toMatchObject({ startMs: 1200, rate: 2 });
    expect(p.masks[0]).toMatchObject({ startMs: 1200, kind: "blur" });
    expect(() => resolveProject(p)).not.toThrow();
    for (const track of ["zoom", "cut", "speed", "mask"] as const) p = deleteBlock(p, track, 0);
    expect(p.zoom.segments).toHaveLength(0);
    expect(p.edits.cuts).toHaveLength(0);
    expect(p.masks).toHaveLength(0);
  });

  it("merges overlapping cuts and subtracts a restored range", () => {
    let p = defaultProject();
    p = { ...p, edits: { ...p.edits, cuts: [{ startMs: 1000, endMs: 2000 }, { startMs: 1500, endMs: 2500 }, { startMs: 4000, endMs: 4200 }] } };
    expect(normalizeCuts(p).edits.cuts).toEqual([{ startMs: 1000, endMs: 2500 }, { startMs: 4000, endMs: 4200 }]);
    expect(subtractRange([{ startMs: 1000, endMs: 2500 }], { startMs: 1500, endMs: 1800 })).toEqual([{ startMs: 1000, endMs: 1500 }, { startMs: 1800, endMs: 2500 }]);
  });

  it("deleting transcript words becomes cuts that shorten the plan", () => {
    const words = [{ text: "a", startMs: 1000, endMs: 1300 }, { text: "um", startMs: 1400, endMs: 1700 }, { text: "b", startMs: 1800, endMs: 2100 }];
    const cuts = cutsForDeletedWords(words, [1]);
    expect(cuts).toEqual([{ startMs: 1350, endMs: 1750 }]);
    const p0 = resolveProject({ output: { fps: 30, resolution: 360 } });
    const p1 = { ...p0, edits: { ...p0.edits, cuts } };
    const a = buildRenderPlan({ meta: META, events: clicks(), project: p0 });
    const b = buildRenderPlan({ meta: META, events: clicks(), project: p1 });
    expect(a.output.frames - b.output.frames).toBe(12); // 400 ms at 30 fps
  });

  it("freezes auto zooms so editing one does not bring it back, and unfreezes", () => {
    const p0 = resolveProject({ output: { fps: 30, resolution: 360 } });
    const plan = buildRenderPlan({ meta: META, events: clicks(), project: p0 });
    expect(plan.zoomSegments.length).toBe(2);
    const frozen = freezeAutoZooms(p0, plan.zoomSegments);
    expect(frozen.zoom.auto).toBe(false);
    expect(frozen.zoom.segments.every((s) => s.auto)).toBe(true);
    const moved = updateBlock(frozen, "zoom", 0, { startMs: 2000, endMs: 3500 });
    const plan2 = buildRenderPlan({ meta: META, events: clicks(), project: moved });
    expect(plan2.zoomSegments.map((s) => [s.startMs, s.endMs])).toEqual([[2000, 3500], [plan.zoomSegments[1]!.startMs, plan.zoomSegments[1]!.endMs]]);
    const back = unfreezeAutoZooms(moved);
    expect(back.zoom.auto).toBe(true);
    expect(back.zoom.segments).toHaveLength(0);
  });
});

describe("time mapping", () => {
  const p = resolveProject({ output: { fps: 30, resolution: 360 }, edits: { cuts: [{ startMs: 2000, endMs: 3000 }] } });
  const plan = buildRenderPlan({ meta: META, events: clicks(), project: p });

  it("maps source time to the first output frame showing it, skipping cuts", () => {
    expect(frameForSource(plan, 0)).toBe(0);
    expect(frameForSource(plan, 1000)).toBe(30);
    const f = frameForSource(plan, 2500);
    expect(plan.frames[f]!.src).toBeGreaterThanOrEqual(3000);
    expect(plan.frames[f - 1]!.src).toBeLessThan(2000);
    expect(frameForSource(plan, 1e9)).toBe(plan.frames.length - 1);
  });

  it("frameAt and timecode are frame exact", () => {
    expect(frameAt(plan, 1000)).toBe(30);
    expect(frameAt(plan, 1033.4)).toBe(31);
    expect(frameAt(plan, -5)).toBe(0);
    expect(timecode(1000, 30)).toBe("00:01.00");
    expect(timecode(61 * 1000 + 500, 30)).toBe("01:01.15");
  });
});

describe("history", () => {
  it("undo / redo single commits", () => {
    const h = new History({ n: 0 });
    h.commit({ n: 1 }, "one");
    h.commit({ n: 2 }, "two");
    expect(h.undoLabel).toBe("two");
    expect(h.undo()).toBe(true);
    expect(h.doc.n).toBe(1);
    expect(h.redoLabel).toBe("two");
    expect(h.redo()).toBe(true);
    expect(h.doc.n).toBe(2);
    h.undo();
    h.commit({ n: 9 }, "branch");
    expect(h.canRedo).toBe(false);
  });

  it("a gesture of many previews is one undo step; cancel restores", () => {
    const h = new History({ n: 0 });
    h.beginGesture();
    for (let i = 1; i <= 10; i++) h.preview({ n: i });
    h.endGesture("drag");
    expect(h.size.past).toBe(1);
    h.undo();
    expect(h.doc.n).toBe(0);
    h.beginGesture();
    h.preview({ n: 5 });
    h.cancelGesture();
    expect(h.doc.n).toBe(0);
    expect(h.size.past).toBe(0);
  });

  it("ignores no-op commits and caps its length", () => {
    const d = { n: 0 };
    const h = new History(d, 3);
    h.commit(d, "same");
    expect(h.canUndo).toBe(false);
    for (let i = 1; i <= 5; i++) h.commit({ n: i }, String(i));
    expect(h.size.past).toBe(3);
  });
});

describe("tracked (privacy) masks on the timeline", () => {
  const keys = [{ tMs: 1000, rect: { x: 10, y: 50, w: 80, h: 20 } }, { tMs: 1033.33, rect: { x: 10, y: 40, w: 80, h: 20 } }];
  const p = resolveProject({ masks: [{ id: "pd1-1", kind: "blur", rect: keys[0]!.rect, keys, startMs: 1000, endMs: 3000, feather: 2, fadeMs: 0, privacyId: "pd1" }] });
  it("moving a tracked mask carries its keys", () => {
    const q = updateBlock(p, "mask", 0, { startMs: 1500, endMs: 3500 });
    expect(q.masks[0]!.keys!.map((k) => k.tMs)).toEqual([1500, 1533.33]);
  });
  it("resizing keeps the keys in place", () => {
    const q = updateBlock(p, "mask", 0, { startMs: 1000, endMs: 2000 });
    expect(q.masks[0]!.keys!.map((k) => k.tMs)).toEqual([1000, 1033.33]);
  });
});
