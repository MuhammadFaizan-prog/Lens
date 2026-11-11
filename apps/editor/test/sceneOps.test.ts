/**
 * Camera scenes (demand #18): the Scenes lane's block operations on project.camera.layouts and the
 * scene inspector's edits.
 */
import { describe, expect, it } from "vitest";
import { defaultProject, resolveProject, type ProjectConfig } from "@lens/engine";
import { addBlock, blocksOf, deleteBlock, deleteBlocks, duplicateBlocks, moveBlocks, selectAllItems, updateBlock } from "../src/state/timelineOps";
import { sceneLabel, setSceneCorner, setSceneKind, setSceneTransition, withCameraForScenes } from "../src/state/sceneOps";

const base = (): ProjectConfig => ({ ...defaultProject(), camera: { ...defaultProject().camera, enabled: true } });

describe("Scenes lane blocks", () => {
  it("add keeps scenes sorted, defaults to Camera full with a block id, and the project stays valid", () => {
    let p = base();
    p = addBlock(p, "scene", { startMs: 4000, endMs: 6000 }).project;
    const r = addBlock(p, "scene", { startMs: 1000, endMs: 2500 });
    p = r.project;
    expect(r.index).toBe(0);
    expect(p.camera.layouts.map((s) => s.startMs)).toEqual([1000, 4000]);
    expect(p.camera.layouts[0]!.kind).toBe("fullscreen-camera");
    expect(p.camera.layouts[0]!.id).toMatch(/^scene-/);
    expect(blocksOf(p, "scene")).toBe(p.camera.layouts);
    expect(() => resolveProject(p)).not.toThrow();
  });

  it("move / resize / delete / duplicate / select-all act on camera.layouts", () => {
    let p = addBlock(addBlock(base(), "scene", { startMs: 1000, endMs: 2000 }).project, "scene", { startMs: 5000, endMs: 6000 }).project;
    p = updateBlock(p, "scene", 0, { startMs: 1500, endMs: 3000 });
    expect(p.camera.layouts[0]).toMatchObject({ startMs: 1500, endMs: 3000, kind: "fullscreen-camera" });
    const moved = moveBlocks(p, [{ track: "scene", index: 1 }], 1000, 10_000);
    expect(moved.project.camera.layouts[1]).toMatchObject({ startMs: 6000, endMs: 7000 });
    const dup = duplicateBlocks(p, [{ track: "scene", index: 0 }], 10_000);
    expect(dup.project.camera.layouts).toHaveLength(3);
    expect(new Set(dup.project.camera.layouts.map((s) => s.id)).size).toBe(3);
    expect(selectAllItems(p, "scene")).toEqual([{ track: "scene", index: 0 }, { track: "scene", index: 1 }]);
    expect(deleteBlock(p, "scene", 0).camera.layouts.map((s) => s.startMs)).toEqual([5000]);
    expect(deleteBlocks(p, [{ track: "scene", index: 0 }, { track: "scene", index: 1 }]).camera.layouts).toEqual([]);
    // nothing else in the project changes
    expect(deleteBlock(p, "scene", 0).zoom).toBe(p.zoom);
  });
});

describe("scene inspector edits", () => {
  it("kind, corner and transition", () => {
    let p = addBlock(base(), "scene", { startMs: 0, endMs: 3000 }).project;
    p = setSceneKind(p, 0, "camera-overlay");
    p = setSceneCorner(p, 0, "top-left");
    expect(p.camera.layouts[0]).toMatchObject({ kind: "camera-overlay", corner: "top-left" });
    expect(sceneLabel(p.camera.layouts[0]!)).toBe("PiP ↖");
    // a corner only makes sense for picture-in-picture: switching to Side by side drops it
    const split = setSceneKind(p, 0, "split");
    expect(split.camera.layouts[0]!.corner).toBeUndefined();
    expect(sceneLabel(split.camera.layouts[0]!)).toBe("Side by side");
    // null = the Webcam tab's corner
    expect("corner" in setSceneCorner(p, 0, null).camera.layouts[0]!).toBe(false);
    expect(setSceneTransition(p, 0, 1234).camera.layouts[0]!.transitionMs).toBe(1234);
    expect(setSceneTransition(p, 0, 9000).camera.layouts[0]!.transitionMs).toBe(2000);
    expect(setSceneTransition(p, 0, -3).camera.layouts[0]!.transitionMs).toBe(0);
    expect("transitionMs" in setSceneTransition(setSceneTransition(p, 0, 400), 0, null).camera.layouts[0]!).toBe(false);
    expect(() => resolveProject(setSceneTransition(p, 0, 1234))).not.toThrow();
  });

  it("adding a scene turns the webcam on only when the recording has a camera", () => {
    const off = { ...base(), camera: { ...base().camera, enabled: false } };
    expect(withCameraForScenes(off, true).camera.enabled).toBe(true);
    expect(withCameraForScenes(off, false)).toBe(off);
    const on = base();
    expect(withCameraForScenes(on, true)).toBe(on);
  });
});
