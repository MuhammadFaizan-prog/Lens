import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultProject, resolveProject, type ProjectConfig } from "@lens/engine";
import type { InputEvent, RecordingMeta } from "@lens/engine";

// the preview's font / image loader touches document.fonts; the store only needs it to resolve
vi.mock("../src/render/assets", async (orig) => ({ ...(await orig<typeof import("../src/render/assets")>()), ensurePlanAssets: async () => false, setAssetBundle: () => {} }));

import {
  addBlock,
  blocksOf,
  canOverlap,
  clampGroupDelta,
  deleteBlocks,
  duplicateBlocks,
  MIN_BLOCK_MS,
  moveBlocks,
  selectAllItems,
  TRACK_KINDS,
  zoomDocIndex,
  zoomPlanIndex,
  type TrackKind,
} from "../src/state/timelineOps";
import { EditorStore, selectedZoomDocIndex } from "../src/state/store";
import type { Bundle } from "../src/state/bundle";

const DUR = 10000;
const META: RecordingMeta = { width: 1280, height: 720, fps: 30, durationMs: DUR, pixelRatio: 1 };
function clicks(): InputEvent[] {
  const ev: InputEvent[] = [];
  for (const [t, x, y] of [[1000, 200, 200], [6000, 1100, 600]] as const) {
    ev.push({ t: t - 300, type: "move", x, y }, { t, type: "down", x, y, button: "left" }, { t: t + 90, type: "up", x, y, button: "left" });
  }
  return ev;
}

function add(p: ProjectConfig, track: TrackKind, s: number, e: number): ProjectConfig {
  return addBlock(p, track, { startMs: s, endMs: e }, 1280, 720).project;
}

/** Manual blocks on every track, auto zoom off. */
function sample(): ProjectConfig {
  let p = resolveProject({ ...defaultProject(), zoom: { ...defaultProject().zoom, auto: false } });
  p = add(p, "zoom", 1000, 2000);
  p = add(p, "zoom", 4000, 5000);
  p = add(p, "cut", 500, 700);
  p = add(p, "cut", 3000, 3200);
  p = add(p, "speed", 1000, 1500);
  p = add(p, "speed", 2000, 2500);
  p = add(p, "speed", 6000, 6500);
  p = add(p, "mask", 2000, 3000);
  p = add(p, "annotation", 1000, 2000);
  p = add(p, "annotation", 1500, 2500);
  p = add(p, "slide", 7000, 7000);
  p = add(p, "caption", 8000, 9000);
  p = add(p, "volume", 3000, 4000);
  return p;
}

describe("multi-select ops", () => {
  it("covers every track kind and only cuts / annotations overlap", () => {
    expect(TRACK_KINDS.sort()).toEqual((Object.keys(MIN_BLOCK_MS) as TrackKind[]).sort());
    expect(TRACK_KINDS.filter(canOverlap).sort()).toEqual(["annotation", "cut"]);
  });

  it("deleteBlocks removes several blocks per track in one pass (indices stay valid)", () => {
    const p = sample();
    const q = deleteBlocks(p, [{ track: "speed", index: 0 }, { track: "speed", index: 2 }, { track: "speed", index: 2 }, { track: "zoom", index: 1 }, { track: "volume", index: 0 }, { track: "slide", index: 0 }, { track: "caption", index: 9 }]);
    expect(q.edits.speed.map((s) => s.startMs)).toEqual([2000]);
    expect(q.zoom.segments.map((s) => s.startMs)).toEqual([1000]);
    expect(blocksOf(q, "volume")).toHaveLength(0);
    expect(q.slides).toHaveLength(0);
    expect(q.captions.cues).toHaveLength(1); // out-of-range ref ignored
    expect(q.edits.cuts).toEqual(p.edits.cuts);
  });

  it("deleteBlocks sends a deleted step badge back to review", () => {
    let p = sample();
    p = { ...p, annotations: p.annotations.map((a, i) => (i === 0 ? { ...a, stepId: "s1" } : a)), stepLabels: { ...p.stepLabels, drafts: [{ id: "s1", state: "accepted" } as never] } };
    const q = deleteBlocks(p, [{ track: "annotation", index: 0 }]);
    expect(q.stepLabels.drafts[0]!.state).toBe("pending");
  });

  it("clampGroupDelta keeps the group inside the recording and between unselected neighbours", () => {
    const p = sample();
    // speed 1 (2000-2500) sits between speed 0 (ends 1500) and speed 2 (starts 6000)
    expect(clampGroupDelta(p, [{ track: "speed", index: 1 }], -5000, DUR)).toBe(-500);
    expect(clampGroupDelta(p, [{ track: "speed", index: 1 }], 9000, DUR)).toBe(3500);
    // selecting speed 1 and 2 together: speed 2 can run to the end, speed 1 only back to 1500
    expect(clampGroupDelta(p, [{ track: "speed", index: 1 }, { track: "speed", index: 2 }], 9000, DUR)).toBe(3500);
    // cuts and annotations may overlap: only the recording bounds clamp
    expect(clampGroupDelta(p, [{ track: "cut", index: 1 }], -2900, DUR)).toBe(-2900);
    expect(clampGroupDelta(p, [{ track: "annotation", index: 1 }], 9000, DUR)).toBe(7500);
    // the tightest block wins across tracks
    expect(clampGroupDelta(p, [{ track: "cut", index: 1 }, { track: "speed", index: 1 }], -2900, DUR)).toBe(-500);
    expect(clampGroupDelta(p, [], 100, DUR)).toBe(0);
  });

  it("moveBlocks moves a cross-track group by one delta and carries mask keys", () => {
    let p = sample();
    p = { ...p, masks: p.masks.map((m) => ({ ...m, keys: [{ tMs: 2100, rect: m.rect }] as never })) };
    const r = moveBlocks(p, [{ track: "zoom", index: 0 }, { track: "mask", index: 0 }, { track: "slide", index: 0 }, { track: "caption", index: 0 }, { track: "volume", index: 0 }], 400, DUR);
    expect(r.deltaMs).toBe(400);
    expect(r.project.zoom.segments[0]).toMatchObject({ startMs: 1400, endMs: 2400 });
    expect(r.project.masks[0]).toMatchObject({ startMs: 2400, endMs: 3400 });
    expect(r.project.masks[0]!.keys![0]!.tMs).toBe(2500);
    expect(r.project.slides[0]!.atMs).toBe(7400);
    expect(r.project.captions.cues![0]).toMatchObject({ startMs: 8400, endMs: 9400 });
    expect(blocksOf(r.project, "volume")[0]).toMatchObject({ startMs: 3400, endMs: 4400 });
    expect(r.items).toHaveLength(5);
  });

  it("moveBlocks clamps and normalizes cuts, re-pointing the refs at the merged cut", () => {
    const p = sample();
    const r = moveBlocks(p, [{ track: "cut", index: 1 }, { track: "speed", index: 0 }], -2400, DUR);
    // speed 0 can only go back to 0 (1000 ms), so the cut moves 1000 too: no merge yet
    expect(r.deltaMs).toBe(-1000);
    expect(r.project.edits.cuts).toEqual([{ startMs: 500, endMs: 700 }, { startMs: 2000, endMs: 2200 }]);
    const m = moveBlocks(p, [{ track: "cut", index: 1 }], -2400, DUR);
    expect(m.project.edits.cuts).toEqual([{ startMs: 500, endMs: 800 }]);
    expect(m.items).toEqual([{ track: "cut", index: 0 }]);
    const raw = moveBlocks(p, [{ track: "cut", index: 1 }], -2400, DUR, false);
    expect(raw.project.edits.cuts).toHaveLength(2);
  });

  it("duplicateBlocks puts copies after the selection with fresh ids, skipping copies with no room", () => {
    let p = sample();
    p = { ...p, annotations: p.annotations.map((a) => ({ ...a, stepId: "s1" })) };
    const r = duplicateBlocks(p, [{ track: "annotation", index: 0 }, { track: "annotation", index: 1 }, { track: "zoom", index: 0 }], DUR);
    // span 1000..2500 = 1500 ms
    expect(r.skipped).toBe(0);
    expect(r.project.annotations).toHaveLength(4);
    const copies = r.project.annotations.slice(2);
    expect(copies.map((a) => a.startMs)).toEqual([2500, 3000]);
    expect(copies.every((a) => a.stepId === undefined && !p.annotations.some((o) => o.id === a.id))).toBe(true);
    const z = r.project.zoom.segments.find((s) => s.startMs === 2500)!;
    expect(z.id).not.toBe(p.zoom.segments[0]!.id);
    expect(r.items).toHaveLength(3);
    for (const it of r.items) expect(blocksOf(r.project, it.track)[it.index]!.startMs).toBeGreaterThanOrEqual(2500);
    // a copy that would land on an unselected speed block, or past the end, is skipped
    expect(duplicateBlocks(p, [{ track: "speed", index: 0 }], DUR).skipped).toBe(0); // 1500-2000 only touches speed 1
    const s = duplicateBlocks(p, [{ track: "speed", index: 1 }, { track: "caption", index: 0 }], DUR, 4000);
    expect(s.skipped).toBe(2);
    expect(s.project).toBe(p);
    // cuts may overlap: a copy onto another cut merges with it
    const c = duplicateBlocks(p, [{ track: "cut", index: 0 }], DUR, 2600);
    expect(c.project.edits.cuts).toEqual([{ startMs: 500, endMs: 700 }, { startMs: 3000, endMs: 3300 }]);
    expect(c.items).toEqual([{ track: "cut", index: 1 }]);
  });

  it("selectAllItems lists one track or every track", () => {
    const p = sample();
    expect(selectAllItems(p, "speed")).toEqual([0, 1, 2].map((index) => ({ track: "speed", index })));
    const all = selectAllItems(p);
    expect(all).toHaveLength(TRACK_KINDS.reduce((n, t) => n + blocksOf(p, t).length, 0));
    expect(new Set(all.map((x) => x.track)).size).toBe(8);
  });
});

// ------------------------------------------------------------------ store

function storeWith(p: ProjectConfig): EditorStore {
  const st = new EditorStore();
  const bundle = { dir: "", name: "t", isNew: false, meta: META, events: clicks(), project: p, transcript: null, screen: { frames: 300, fps: 30 }, camera: null } as unknown as Bundle;
  (st as unknown as { s: object }).s = { ...st.get(), bundle, status: "ready" };
  st.openProject(p);
  return st;
}

const keys = (st: EditorStore) => st.get().multi.map((x) => `${x.track}:${x.index}`).sort();

describe("store multi-select", () => {
  let st: EditorStore;
  beforeEach(() => {
    st = storeWith(sample());
  });

  it("select() resets the group; toggleSelect adds and removes, keeping a primary", () => {
    st.select({ track: "speed", index: 0 });
    expect(keys(st)).toEqual(["speed:0"]);
    st.toggleSelect({ track: "cut", index: 1 });
    expect(keys(st)).toEqual(["cut:1", "speed:0"]);
    expect(st.get().selection).toEqual({ track: "cut", index: 1 });
    st.toggleSelect({ track: "cut", index: 1 });
    expect(keys(st)).toEqual(["speed:0"]);
    expect(st.get().selection).toEqual({ track: "speed", index: 0 });
    st.toggleSelect({ track: "speed", index: 0 });
    expect(st.get().multi).toEqual([]);
    expect(st.get().selection).toBeNull();
    st.toggleSelect({ track: "mask", index: 0 });
    st.select({ track: "caption", index: 0 });
    expect(keys(st)).toEqual(["caption:0"]);
    st.select(null);
    expect(st.get().multi).toEqual([]);
  });

  it("setSelection drops duplicates and invalid refs", () => {
    st.setSelection([{ track: "speed", index: 0 }, { track: "speed", index: 0 }, { track: "speed", index: 42 }, { track: "mask", index: 0 }], { track: "speed", index: 0 });
    expect(keys(st)).toEqual(["mask:0", "speed:0"]);
    expect(st.get().selection).toEqual({ track: "speed", index: 0 });
  });

  it("selectRange spans the primary's track in time; another track just adds", () => {
    st.select({ track: "speed", index: 0 });
    st.selectRange({ track: "speed", index: 2 });
    expect(keys(st)).toEqual(["speed:0", "speed:1", "speed:2"]);
    expect(st.get().selection).toEqual({ track: "speed", index: 0 });
    st.selectRange({ track: "cut", index: 0 });
    expect(keys(st)).toEqual(["cut:0", "speed:0", "speed:1", "speed:2"]);
  });

  it("selectAll selects one track or everything", () => {
    st.selectAll("annotation");
    expect(keys(st)).toEqual(["annotation:0", "annotation:1"]);
    st.selectAll();
    expect(st.get().multi).toHaveLength(13); // 2 zoom, 2 cut, 3 speed, 1 mask, 2 annotation, 1 slide, 1 caption, 1 volume
  });

  it("deleteSelected is one undo step that restores every block", () => {
    const before = st.get().project;
    st.setSelection([{ track: "speed", index: 0 }, { track: "speed", index: 2 }, { track: "cut", index: 0 }, { track: "annotation", index: 1 }, { track: "zoom", index: 1 }, { track: "slide", index: 0 }, { track: "volume", index: 0 }]);
    expect(st.deleteSelected()).toBe(7);
    const p = st.get().project;
    expect(p.edits.speed).toHaveLength(1);
    expect(p.edits.cuts).toHaveLength(1);
    expect(p.annotations).toHaveLength(1);
    expect(p.zoom.segments).toHaveLength(1);
    expect(p.slides).toHaveLength(0);
    expect(st.get().multi).toEqual([]);
    expect(st.get().selection).toBeNull();
    st.undo();
    expect(st.get().project).toEqual(before);
    expect(st.get().canUndo).toBe(false);
    st.redo();
    expect(st.get().project.edits.speed).toHaveLength(1);
  });

  it("moveSelected / nudge move the group as one undo step and keep it selected", () => {
    const before = st.get().project;
    st.setSelection([{ track: "speed", index: 1 }, { track: "mask", index: 0 }, { track: "caption", index: 0 }], { track: "mask", index: 0 });
    expect(st.moveSelected(5000)).toBe(1000); // tightest: caption 8000-9000 can only go 1000 (speed 1: 3500, mask: 7000)
    const p = st.get().project;
    expect(p.edits.speed[1]).toMatchObject({ startMs: 3000, endMs: 3500 });
    expect(p.masks[0]).toMatchObject({ startMs: 3000, endMs: 4000 });
    expect(p.captions.cues![0]).toMatchObject({ startMs: 9000, endMs: 10000 });
    expect(keys(st)).toEqual(["caption:0", "mask:0", "speed:1"]);
    expect(st.get().selection).toEqual({ track: "mask", index: 0 });
    expect(st.nudge(-1)).toBeCloseTo(-1000 / st.get().plan!.output.fps); // one output frame
    expect(st.get().project.masks[0]!.startMs).toBeCloseTo(3000 - 1000 / st.get().plan!.output.fps);
    st.undo();
    st.undo();
    expect(st.get().project).toEqual(before);
    expect(st.moveSelected(0)).toBe(0);
  });

  it("a group drag previews live and commits one undo step (cuts merge at the end)", () => {
    const before = st.get().project;
    st.setSelection([{ track: "cut", index: 1 }, { track: "caption", index: 0 }]);
    st.beginMoveSelected();
    st.previewMoveSelected(-1000);
    expect(st.get().project.edits.cuts).toHaveLength(2);
    st.previewMoveSelected(-2400);
    expect(st.get().project.edits.cuts[1]).toMatchObject({ startMs: 600, endMs: 800 }); // not merged during the drag
    st.endMoveSelected();
    const p = st.get().project;
    expect(p.edits.cuts).toEqual([{ startMs: 500, endMs: 800 }]);
    expect(p.captions.cues![0]).toMatchObject({ startMs: 5600, endMs: 6600 });
    expect(keys(st)).toEqual(["caption:0", "cut:0"]);
    st.undo();
    expect(st.get().project).toEqual(before);
    expect(st.get().canUndo).toBe(false);
  });

  it("duplicateSelected is one undo step and selects the copies", () => {
    const before = st.get().project;
    st.setSelection([{ track: "speed", index: 0 }, { track: "annotation", index: 1 }]);
    expect(st.duplicateSelected()).toBe(2); // span 1000-2500: copies at 2500 (speed) and 3000 (annotation)
    const p = st.get().project;
    expect(p.edits.speed).toHaveLength(4);
    expect(p.annotations).toHaveLength(3);
    expect(st.get().multi.map((x) => blocksOf(p, x.track)[x.index]!.startMs).sort()).toEqual([2500, 3000]);
    // speed 1 (2000-2500) again: its copy (2500-3000) would land on the first copy, so nothing is added and no undo step
    st.setSelection([{ track: "speed", index: 1 }]);
    expect(st.duplicateSelected()).toBe(0);
    expect(st.get().undoLabel).toBe("Duplicate 2 blocks");
    st.undo();
    expect(st.get().project).toEqual(before);
  });

  it("zoom items with auto zoom on freeze inside the same undo step", () => {
    let p = resolveProject({ ...defaultProject(), zoom: { ...defaultProject().zoom, auto: true } });
    p = add(p, "speed", 100, 400);
    st = storeWith(p);
    const autos = st.get().plan!.zoomSegments;
    expect(autos.length).toBeGreaterThanOrEqual(2);
    st.setSelection([{ track: "zoom", index: 0 }, { track: "speed", index: 0 }]);
    expect(st.deleteSelected()).toBe(2);
    const q = st.get().project;
    expect(q.zoom.auto).toBe(false);
    expect(q.zoom.segments).toHaveLength(autos.length - 1);
    expect(q.edits.speed).toHaveLength(0);
    st.undo();
    expect(st.get().project).toEqual(p);
    expect(st.get().project.zoom.auto).toBe(true);

    // a move keeps the moved auto zoom selected by its new plan index
    st.setSelection([{ track: "zoom", index: 1 }]);
    const z = autos[1]!;
    const d = st.moveSelected(200);
    expect(d).toBeGreaterThan(0);
    const sel = st.get().selection!;
    expect(sel.track).toBe("zoom");
    expect(st.get().plan!.zoomSegments[sel.index]).toMatchObject({ startMs: z.startMs + d, endMs: z.endMs + d });
    st.undo();
    expect(st.get().project).toEqual(p);
  });
});

describe("zoom selection index (plain click and multi-select agree, by segment id)", () => {
  /** Auto zoom on (two live autos from the clicks) plus one manual zoom after them. */
  function mixed(): { p: ProjectConfig; st: EditorStore; manualId: string } {
    let p = resolveProject({ ...defaultProject(), zoom: { ...defaultProject().zoom, auto: true } });
    p = add(p, "zoom", 8600, 9400);
    const st = storeWith(p);
    return { p, st, manualId: p.zoom.segments[0]!.id };
  }

  it("maps plan and project indices by id, not by position", () => {
    const { p, st, manualId } = mixed();
    const plan = st.get().plan!.zoomSegments;
    const pi = plan.findIndex((z) => z.id === manualId);
    expect(pi).toBeGreaterThan(0); // live autos come first: plan index != project index 0
    expect(zoomDocIndex(p, plan, pi)).toBe(0);
    expect(zoomPlanIndex(p, plan, 0)).toBe(pi);
    expect(zoomDocIndex(p, plan, 0)).toBe(-1); // a live auto zoom has no project segment
    expect(zoomDocIndex(p, plan, 99)).toBe(-1);
    expect(zoomPlanIndex(p, plan, 5)).toBe(-1);
  });

  it("a plain-click selection (selectZoom by project index) is the same item multi-select uses", () => {
    const { st, manualId } = mixed();
    const pi = st.get().plan!.zoomSegments.findIndex((z) => z.id === manualId);
    st.selectZoom(0); // what a plain click / add does with the project index
    expect(st.get().selection).toEqual({ track: "zoom", index: pi });
    expect(st.isSelected({ track: "zoom", index: pi })).toBe(true);
    expect(selectedZoomDocIndex(st.get())).toBe(0);
    // Ctrl+click of the same block toggles it off: both paths name the same item
    st.toggleSelect({ track: "zoom", index: pi });
    expect(st.get().multi).toEqual([]);
    // select it again: Delete removes exactly the manual zoom, not the live auto at project index 0
    st.selectZoom(0);
    expect(st.deleteSelected()).toBe(1);
    const q = st.get().project;
    expect(q.zoom.segments.some((s) => s.id === manualId)).toBe(false);
    expect(q.zoom.segments.filter((s) => s.auto)).toHaveLength(pi); // the autos survive (frozen)
  });

  it("after a plain click freezes auto zooms, the selection still names the clicked block", () => {
    const { st } = mixed();
    const z = st.get().plan!.zoomSegments[1]!; // a live auto zoom
    const idx = st.freezeZoomsFor(z.startMs, z.endMs);
    expect(idx).toBeGreaterThanOrEqual(0);
    st.selectZoom(idx);
    const sel = st.get().selection!;
    expect(st.get().plan!.zoomSegments[sel.index]).toMatchObject({ startMs: z.startMs, endMs: z.endMs });
    expect(st.get().project.zoom.segments[selectedZoomDocIndex(st.get())]).toMatchObject({ startMs: z.startMs, endMs: z.endMs });
    st.toggleSelect(sel);
    expect(st.get().multi).toEqual([]);
  });
});
