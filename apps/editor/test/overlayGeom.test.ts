import { describe, expect, it } from "vitest";
import { clampedNormCentre, clampZoomCentre, fromNorm, moveBox, resizeBox, snapBox, toNorm, zoomRect, zoomTarget } from "../src/state/overlayGeom";
import { clampLayout, defaultLayout, MIN_CENTER_W } from "../src/state/uiLayout";

describe("normalized overlay coords (Windows bug #12)", () => {
  it("round-trips output px <-> fractions at any aspect", () => {
    for (const [W, H] of [[1920, 1080], [1080, 1920], [1080, 1080]] as const) {
      const p = { x: W * 0.31, y: H * 0.77 };
      const n = toNorm(p, W, H);
      const q = fromNorm(n, W, H);
      expect(q.x).toBeCloseTo(p.x, 9);
      expect(q.y).toBeCloseTo(p.y, 9);
    }
  });
  it("a stored position survives an aspect change (same fraction of the new frame)", () => {
    const n = toNorm({ x: 1600, y: 900 }, 1920, 1080);
    expect(fromNorm(n, 1080, 1920)).toEqual({ x: 900, y: 1600 });
  });
  it("clamps a dragged box inside the frame", () => {
    expect(clampedNormCentre({ x: -50, y: 2000 }, 200, 100, 1920, 1080)).toEqual({ x: 100 / 1920, y: 1030 / 1080 });
  });
  it("moves and resizes with handles (aspect kept, opposite corner fixed)", () => {
    const b = { x: 100, y: 100, w: 200, h: 100 };
    expect(moveBox(b, 5, -7)).toEqual({ x: 105, y: 93, w: 200, h: 100 });
    const r = resizeBox(b, "se", { x: 500, y: 150 }, true);
    expect(r.x).toBe(100);
    expect(r.y).toBe(100);
    expect(r.w / r.h).toBeCloseTo(2, 9);
    expect(r.w).toBe(400);
    const nw = resizeBox(b, "nw", { x: 250, y: 120 }, false, 4);
    expect(nw).toEqual({ x: 250, y: 120, w: 50, h: 80 });
  });
  it("snaps to the frame centre lines within the threshold", () => {
    const s = snapBox({ x: 853, y: 6, w: 200, h: 100 }, 1920, 1080, 8);
    expect(s.box.x + s.box.w / 2).toBe(960);
    expect(s.gx).toEqual([960]);
    expect(s.box.y).toBe(0);
  });
});

describe("responsive layout (Windows bug #11)", () => {
  it("keeps the centre column usable at 1024 and the stage at 640 tall", () => {
    for (const [vw, vh] of [[1024, 640], [1280, 720], [1366, 768], [3840, 2160]] as Array<[number, number]>) {
      const l = clampLayout({ ...defaultLayout(vw, vh), leftW: 480, rightW: 520 }, vw, vh);
      const used = (l.leftOpen ? l.leftW : 0) + (l.rightOpen ? l.rightW : 0);
      expect(vw - used - 10).toBeGreaterThanOrEqual(MIN_CENTER_W - 1);
      expect(vh - 52 - 5 - l.tlH).toBeGreaterThanOrEqual(240);
    }
  });
});
