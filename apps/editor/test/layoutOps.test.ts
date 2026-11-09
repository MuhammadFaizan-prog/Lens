import { describe, expect, it } from "vitest";
import { canvasSize, cardRect, defaultProject, resolveProject } from "@lens/engine";
import type { ProjectConfig } from "@lens/engine";
import { aspectChoiceOf, cardCenter, cardFill, cardFit, cardReset, insetsOf, scaledRect, setAspect, setCardRect, setCropInsets, setCustomSize } from "../src/state/layoutOps";
import { resizeBoxFrom, snapBox, snapPoint, snapLines } from "../src/state/overlayGeom";

const base = (): ProjectConfig => defaultProject();
const out = { width: 1920, height: 1080 };

describe("aspect picker (feat/canvas-layout)", () => {
  it("every choice re-fits the card, drops a custom size and fits whole (never crops)", () => {
    const p0: ProjectConfig = { ...base(), card: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, output: { ...base().output, size: { w: 800, h: 600 }, fit: "fill" } };
    for (const a of ["auto", "16:9", "9:16", "1:1", "4:5", "4:3", "21:9"] as const) {
      const p = setAspect(p0, a);
      expect(p.output.aspect).toBe(a);
      expect(p.output.size).toBeNull();
      expect(p.output.fit).toBe("fit");
      expect(p.card).toBeNull();
      expect(aspectChoiceOf(p)).toBe(a);
      expect(() => resolveProject(JSON.parse(JSON.stringify(p)))).not.toThrow();
    }
  });
  it("custom W x H wins, rounds to even and re-fits", () => {
    const p = setCustomSize({ ...base(), card: { x: 0, y: 0, w: 1, h: 1 } }, 1001, 777);
    expect(p.output.size).toEqual({ w: 1002, h: 778 });
    expect(p.card).toBeNull();
    expect(aspectChoiceOf(p)).toBe("custom");
    expect(canvasSize(p.output, { width: 1920, height: 1080 })).toEqual({ width: 1002, height: 778 });
    expect(setCustomSize(p, 0, 10)).toBe(p);
  });
});

describe("screen card edits", () => {
  it("a dragged rect round-trips through project.card", () => {
    const r = { x: 192, y: 108, w: 960, h: 540 };
    const p = setCardRect(base(), r, out);
    expect(p.card).toEqual({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
    const back = cardRect(out, 16 / 9, p);
    expect(back.x).toBeCloseTo(192, 3);
    expect(back.w).toBeCloseTo(960, 3);
    expect(() => resolveProject(JSON.parse(JSON.stringify(p)))).not.toThrow();
  });
  it("clamps a card to what the project accepts", () => {
    const p = setCardRect(base(), { x: -20000, y: 0, w: 100000, h: 1 }, out);
    expect(() => resolveProject(JSON.parse(JSON.stringify(p)))).not.toThrow();
  });
  it("Fit, Fill, Center, Reset", () => {
    const p = { ...setCardRect(base(), { x: 0, y: 0, w: 960, h: 540 }, out), crop: { x: 10, y: 10, w: 800, h: 600 } };
    expect(cardFit(p).card).toBeNull();
    expect(cardFit(p).crop).toEqual(p.crop);
    expect(cardFill(p).card).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(cardCenter(p, { x: 0, y: 0, w: 960, h: 540 }, out).card).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    // centring the fitted (null) card makes it explicit at its own size
    expect(cardCenter(base(), { x: 100, y: 0, w: 960, h: 540 }, out).card).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    const r = cardReset(p);
    expect(r.card).toBeNull();
    expect(r.crop).toBeNull();
  });
  it("scale is relative to the fitted width, about the centre", () => {
    const s = scaledRect({ x: 100, y: 100, w: 400, h: 200 }, { x: 0, y: 0, w: 800, h: 450 }, 1);
    expect(s).toEqual({ x: -100, y: 0, w: 800, h: 400 });
  });
});

describe("crop insets", () => {
  const meta = { width: 1920, height: 1080 };
  it("insets <-> crop, zero = null", () => {
    const p = setCropInsets(base(), { l: 100, t: 50, r: 20, b: 30 }, meta);
    expect(p.crop).toEqual({ x: 100, y: 50, w: 1800, h: 1000 });
    expect(insetsOf(p.crop, meta)).toEqual({ l: 100, t: 50, r: 20, b: 30 });
    expect(setCropInsets(p, { l: 0, t: 0, r: 0, b: 0 }, meta).crop).toBeNull();
  });
  it("never crops the source away", () => {
    const p = setCropInsets(base(), { l: 5000, t: 0, r: 5000, b: 0 }, meta);
    expect(p.crop!.w).toBeGreaterThanOrEqual(16);
    expect(() => resolveProject(JSON.parse(JSON.stringify(p)))).not.toThrow();
  });
});

describe("screen card geometry", () => {
  it("Alt resizes about the centre, Shift keeps the aspect", () => {
    const b = { x: 100, y: 100, w: 200, h: 100 };
    expect(resizeBoxFrom(b, "se", { x: 350, y: 150 }, false, 4, true)).toEqual({ x: 50, y: 148, w: 300, h: 4 });
    const k = resizeBoxFrom(b, "se", { x: 400, y: 160 }, true, 4, true);
    expect(k.w / k.h).toBeCloseTo(2, 9);
    expect(k.x + k.w / 2).toBeCloseTo(200, 9);
    expect(k.y + k.h / 2).toBeCloseTo(150, 9);
  });
  it("snaps to thirds and the centre", () => {
    expect(snapLines(900, 600, true).xs).toEqual([0, 300, 450, 600, 900]);
    const s = snapBox({ x: 296, y: 10, w: 100, h: 100 }, 900, 600, 8, true);
    expect(s.box.x).toBe(300);
    expect(s.gx).toEqual([300]);
    expect(snapBox({ x: 296, y: 10, w: 100, h: 100 }, 900, 600, 8).box.x).toBe(296);
    expect(snapPoint({ x: 603, y: 297 }, snapLines(900, 600, true), 8)).toEqual({ p: { x: 600, y: 300 }, gx: [600], gy: [300] });
  });
});
