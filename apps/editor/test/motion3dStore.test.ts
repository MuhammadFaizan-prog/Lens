/**
 * 3D motion in the editor store (feat/motion-3d): adding a block from a template, editing its
 * settings and keyframe poses, adding / deleting keyframes, Alt+Arrow nudges, undo / redo, applying
 * a template to an existing block and "Save as template" (localStorage library).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { MOTION3D_TEMPLATES, validateMotion3d } from "@lens/engine";

// a tiny in-memory localStorage for the template library
const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  length: 0,
};

const { store } = await import("../src/state/store");
const { keyCount, keyPose } = await import("../src/state/motion3dOps");

const doc = () => store.get().project;
const seg = (i = 0) => doc().motion3d[i]!;

beforeEach(() => {
  mem.clear();
  store.refreshMotion3dTemplates();
  store.openProject({});
  store.select(null);
});

describe("motion3d store", () => {
  it("lists the 13 built-in templates, then saved ones", () => {
    expect(MOTION3D_TEMPLATES).toHaveLength(13);
    expect(store.get().motion3dTemplates.map((t) => t.id)).toEqual(MOTION3D_TEMPLATES.map((t) => t.id));
  });

  it("adds a block from a template at a time, selected, as one undo step", () => {
    const i = store.addMotion3d("flip", 2000);
    expect(i).toBe(0);
    expect(store.get().selection).toEqual({ track: "motion3d", index: 0 });
    expect(seg()).toMatchObject({ startMs: 2000, endMs: 3400, template: "flip", to: { ry: 360 }, backface: "front" });
    expect(validateMotion3d(doc().motion3d)).toEqual([]);
    store.undo();
    expect(doc().motion3d).toEqual([]);
    store.redo();
    expect(doc().motion3d).toHaveLength(1);
  });

  it("a second add inside an existing block goes right after it", () => {
    store.addMotion3d("tilt-in", 1000);
    store.addMotion3d("roll", 1500);
    expect(doc().motion3d.map((m) => [m.startMs, m.endMs])).toEqual([[1000, 2000], [2000, 2900]]);
  });

  it("updates settings and removes cleared fields; undo restores", () => {
    store.addMotion3d("tilt-in", 0);
    store.updateMotion3d(0, { easing: "linear", perspective: 1200, hold: true });
    expect(seg()).toMatchObject({ easing: "linear", perspective: 1200, hold: true });
    store.updateMotion3d(0, { hold: undefined });
    expect("hold" in seg()).toBe(false);
    store.undo();
    expect(seg().hold).toBe(true);
    store.undo();
    expect(seg()).toMatchObject({ easing: "spring", perspective: 2000 });
  });

  it("edits the selected keyframe's pose (from, interior, to)", () => {
    store.addMotion3d("custom", 0); // 0..1500, identity from / to
    store.selectMotion3dKey(0);
    store.setMotion3dPose(0, { rx: 30, tz: -200 });
    expect(seg().from).toEqual({ rx: 30, tz: -200 });
    store.selectMotion3dKey(1); // "to" while there are no interior keys
    store.setMotion3dPose(0, { ry: -45 });
    expect(seg().to).toEqual({ ry: -45 });
    store.undo();
    expect(seg().to).toEqual({});
  });

  it("adds a keyframe at a time holding the current pose, selects it, deletes it", () => {
    store.addMotion3d("custom", 0);
    store.setMotion3dPose(0, { ry: 180 }, false, 1); // to: ry 180, linear for an exact mid pose
    store.updateMotion3d(0, { easing: "linear" });
    expect(store.addMotion3dKey(0, 750)).toBe(true);
    expect(seg().keys).toEqual([{ at: 0.5, pose: { ry: 90 } }]);
    expect(keyCount(seg())).toBe(3);
    expect(store.get().m3dKey).toBe(1);
    // sliders now edit the new key
    store.setMotion3dPose(0, { rx: 20 });
    expect(seg().keys![0]!.pose).toEqual({ ry: 90, rx: 20 });
    // a second key before it sorts first
    expect(store.addMotion3dKey(0, 300)).toBe(true);
    expect(seg().keys!.map((k) => k.at)).toEqual([0.2, 0.5]);
    expect(store.get().m3dKey).toBe(1);
    // outside the block, or on top of a key: refused
    expect(store.addMotion3dKey(0, 5000)).toBe(false);
    expect(store.addMotion3dKey(0, 752)).toBe(false);
    store.selectMotion3dKey(2);
    store.deleteMotion3dKey(0);
    expect(seg().keys!.map((k) => k.at)).toEqual([0.2]);
    store.selectMotion3dKey(1);
    store.deleteMotion3dKey(0);
    expect(seg().keys).toBeUndefined();
    // from / to cannot be deleted
    store.selectMotion3dKey(0);
    store.deleteMotion3dKey(0);
    expect(keyCount(seg())).toBe(2);
    expect(validateMotion3d(doc().motion3d)).toEqual([]);
    store.undo();
    store.undo();
    expect(seg().keys!.map((k) => k.at)).toEqual([0.2, 0.5]);
  });

  it("refuses keyframes on loop easing", () => {
    store.addMotion3d("float", 0);
    expect(store.addMotion3dKey(0, 1000)).toBe(false);
    expect(seg().keys).toBeUndefined();
  });

  it("Alt+Arrow nudge turns the selected key by 5 degrees, only with a 3D block selected", () => {
    expect(store.nudgeMotion3d("ry", 5)).toBe(false);
    store.addMotion3d("tilt-in", 0); // from rx 25
    expect(store.nudgeMotion3d("rx", 5)).toBe(true);
    expect(store.nudgeMotion3d("rx", 5)).toBe(true);
    expect(store.nudgeMotion3d("ry", -5)).toBe(true);
    expect(keyPose(seg(), 0)).toMatchObject({ rx: 35, ry: -5 });
    store.undo(); // one tweak gesture -> one undo step
    expect(keyPose(seg(), 0)).toMatchObject({ rx: 25, ry: 0 });
    store.select({ track: "speed", index: 0 });
    expect(store.nudgeMotion3d("rx", 5)).toBe(false);
  });

  it("applies another template to the selected block, keeping its id and start", () => {
    store.addMotion3d("tilt-in", 500);
    const id = seg().id;
    store.applyMotion3dTemplate(0, "isometric");
    expect(seg()).toMatchObject({ id, startMs: 500, endMs: 3500, template: "isometric", easing: "linear", blendMs: 600, perspective: 4000 });
    store.undo();
    expect(seg().template).toBe("tilt-in");
  });

  it("saves a block as a template, lists it after the built-ins and adds from it", () => {
    store.addMotion3d("custom", 0);
    store.setMotion3dPose(0, { rx: 40, ry: -20 }, false, 0);
    store.addMotion3dKey(0, 750);
    store.setMotion3dPose(0, { rz: 15 });
    const t = store.saveMotion3dTemplate(0, "My swoop")!;
    expect(t).toMatchObject({ id: "my-swoop", name: "My swoop", user: true, durationMs: 1500, from: { rx: 40, ry: -20 } });
    const ids = store.get().motion3dTemplates.map((x) => x.id);
    expect(ids).toHaveLength(14);
    expect(ids[13]).toBe("my-swoop");
    expect(JSON.parse(mem.get("lens.motion3d.templates.v1")!)).toHaveLength(1);
    // a second save with the same name gets a unique id
    expect(store.saveMotion3dTemplate(0, "My swoop")!.id).toBe("my-swoop-2");
    const j = store.addMotion3d("user:my-swoop", 5000);
    expect(doc().motion3d[j]).toMatchObject({ startMs: 5000, endMs: 6500, template: "user:my-swoop", from: { rx: 40, ry: -20 } });
    expect(doc().motion3d[j]!.keys).toHaveLength(1);
    store.deleteMotion3dTemplate("my-swoop-2");
    expect(store.get().motion3dTemplates).toHaveLength(14);
    expect(store.saveMotion3dTemplate(0, "  ")).toBeNull();
  });

  it("deletes the block and clears the selection; undo brings it back", () => {
    store.addMotion3d("roll", 0);
    store.deleteMotion3d(0);
    expect(doc().motion3d).toEqual([]);
    expect(store.get().selection).toBeNull();
    store.undo();
    expect(seg().template).toBe("roll");
  });
});
