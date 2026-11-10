/**
 * Framing (fix/aspect-framing-014): the crop math of Fit / Fill / Follow / Custom, every window
 * clamped to the source (user crop) bounds, and old projects (no output.framing) planning exactly as
 * before: fit "fill" = framing "follow", no fit = framing "fit" (Rules.md §4).
 */
import { describe, expect, it } from "vitest";
import {
  buildRenderPlan,
  customWindow,
  fillScreenRect,
  fillWindow,
  framingMode,
  resolveProject,
  visibleWindow,
  type Rect,
} from "../src/index.js";
import { demoSession, META } from "./fixtures.js";

const plan = (patch: unknown = {}) => buildRenderPlan({ meta: META, events: demoSession(), project: resolveProject(patch) });
const inside = (r: Rect, b: Rect, eps = 1e-6) => {
  expect(r.x).toBeGreaterThanOrEqual(b.x - eps);
  expect(r.y).toBeGreaterThanOrEqual(b.y - eps);
  expect(r.x + r.w).toBeLessThanOrEqual(b.x + b.w + eps);
  expect(r.y + r.h).toBeLessThanOrEqual(b.y + b.h + eps);
};
const SRC: Rect = { x: 0, y: 0, w: 1920, h: 1080 };

describe("framingMode", () => {
  it("derives old projects' mode from fit and prefers an explicit framing", () => {
    expect(framingMode({})).toBe("fit");
    expect(framingMode({ fit: "fit" })).toBe("fit");
    expect(framingMode({ fit: "fill" })).toBe("follow");
    expect(framingMode({ fit: "fill", framing: "custom" })).toBe("custom");
    expect(framingMode({ framing: "fill" })).toBe("fill");
    expect(framingMode({ framing: "bogus" as never })).toBe("fit");
  });
});

describe("fillWindow", () => {
  it("is the largest centred window of the canvas aspect inside the crop", () => {
    const w = fillWindow(SRC, 9 / 16);
    expect(w).toEqual({ x: 656, y: 0, w: 608, h: 1080 });
    inside(w, SRC);
    const wide = fillWindow(SRC, 21 / 9);
    expect(wide.w).toBe(1920);
    expect(Math.abs(wide.w / wide.h - 21 / 9)).toBeLessThan(0.01);
    expect(Math.abs(wide.y + wide.h / 2 - 540)).toBeLessThanOrEqual(1);
    const crop = { x: 100, y: 50, w: 1200, h: 900 };
    for (const a of [9 / 16, 1, 4 / 5, 16 / 9, 21 / 9]) {
      const r = fillWindow(crop, a);
      inside(r, crop);
      expect(Math.abs(r.w / r.h - a) / a).toBeLessThan(0.01);
      expect(r.w === crop.w || r.h === crop.h).toBe(true);
    }
  });
});

describe("customWindow", () => {
  it("no rect = the fill window", () => {
    expect(customWindow(SRC, 9 / 16, null)).toEqual(fillWindow(SRC, 9 / 16));
  });
  it("keeps a valid window as is", () => {
    expect(customWindow(SRC, 9 / 16, { x: 100, y: 200, w: 450, h: 800 })).toEqual({ x: 100, y: 200, w: 450, h: 800 });
  });
  it("locks the aspect about the centre, keeping the area", () => {
    const r = customWindow(SRC, 1, { x: 400, y: 300, w: 800, h: 200 }); // 160000 px² -> 400 x 400
    expect(r).toEqual({ x: 600, y: 200, w: 400, h: 400 });
  });
  it("clamps to the source bounds: off the edge moves back in, too big shrinks to the fill window", () => {
    const off = customWindow(SRC, 9 / 16, { x: -300, y: 900, w: 450, h: 800 });
    inside(off, SRC);
    expect(off).toEqual({ x: 0, y: 280, w: 450, h: 800 });
    const big = customWindow(SRC, 9 / 16, { x: 0, y: 0, w: 4000, h: 7000 });
    // shrinks to the fill size, kept as near its centre (2000, 3500) as the source allows
    expect(big).toEqual({ x: 1312, y: 0, w: 608, h: 1080 });
    inside(big, SRC);
    const crop = { x: 300, y: 100, w: 800, h: 600 };
    for (const r of [{ x: 0, y: 0, w: 100, h: 100 }, { x: 2000, y: 2000, w: 300, h: 300 }, { x: 500, y: 300, w: 5, h: 5 }]) {
      const c = customWindow(crop, 4 / 5, r);
      inside(c, crop);
      expect(Math.min(c.w, c.h)).toBeGreaterThanOrEqual(16);
      expect(Math.abs(c.w / c.h - 4 / 5) / (4 / 5)).toBeLessThan(0.02);
    }
  });
});

describe("follow window", () => {
  it("the visible part of a follow frame stays inside the source for any focus", () => {
    const out = { width: 1080, height: 1920 };
    const view = { x0: 0, vw: 1920, y0: 0, vh: 1080 };
    for (const fx of [-500, 0, 300, 960, 1700, 1920, 3000]) {
      const s = fillScreenRect(out, 16 / 9, view, { x: fx, y: 540 });
      const v = visibleWindow(s, out, view);
      inside(v, SRC, 0.01);
      expect(Math.abs(v.w / v.h - 9 / 16)).toBeLessThan(0.01);
      expect(s.h).toBeCloseTo(1920, 3); // covers the canvas
    }
    // zoomed in 2x around (400, 300): still inside the zoomed viewport
    const zv = { x0: 0, vw: 960, y0: 0, vh: 540 };
    const v = visibleWindow(fillScreenRect(out, 16 / 9, zv, { x: 50, y: 50 }), out, zv);
    inside(v, { x: 0, y: 0, w: 960, h: 540 }, 0.01);
  });
});

describe("plans", () => {
  it("old projects plan exactly as before: fit fill == framing follow, no fit == framing fit", () => {
    expect(plan({ output: { aspect: "9:16", fit: "fill" } })).toEqual(plan({ output: { aspect: "9:16", fit: "fill", framing: "follow" } }));
    expect(plan({ output: { aspect: "9:16" } })).toEqual(plan({ output: { aspect: "9:16", framing: "fit" } }));
  });
  it("fit is centred on the canvas", () => {
    const p = plan({ output: { aspect: "9:16" } });
    const [x, y, w, h] = p.frames[0]!.layout.screen;
    expect(Math.abs(x + w / 2 - p.output.width / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(y + h / 2 - p.output.height / 2)).toBeLessThanOrEqual(1);
  });
  it("fill covers the canvas with the centred window, square corners, no shadow", () => {
    const p = plan({ output: { aspect: "9:16", framing: "fill" } });
    expect(p.source.crop).toEqual([656, 0, 608, 1080]);
    for (const f of [p.frames[0]!, p.frames[200]!]) expect(f.layout.screen).toEqual([0, 0, p.output.width, p.output.height]);
    expect(p.style.radius).toBe(0);
    expect(p.style.shadow.opacity).toBe(0);
  });
  it("custom shows the stored window (aspect-locked, clamped) and a free card still wins", () => {
    const p = plan({ output: { aspect: "9:16", framing: "custom", framingRect: { x: 1500, y: 100, w: 450, h: 800 } } });
    expect(p.source.crop).toEqual([1470, 100, 450, 800]);
    expect(p.frames[0]!.layout.screen).toEqual([0, 0, p.output.width, p.output.height]);
    const free = plan({ output: { aspect: "9:16", framing: "custom", framingRect: { x: 0, y: 0, w: 450, h: 800 } }, card: { x: 0.1, y: 0.1, w: 0.5, h: 0.3 } });
    expect(free.frames[0]!.layout.screen[0]).toBeCloseTo(0.1 * free.output.width, 0);
    expect(free.style.radius).toBeGreaterThan(0);
  });
  it("follow pans: the screen rect moves with the cursor and covers the canvas", () => {
    const p = plan({ output: { aspect: "9:16", framing: "follow" } });
    const xs = new Set(p.frames.map((f) => Math.round(f.layout.screen[0])));
    expect(xs.size).toBeGreaterThan(3);
    for (const f of p.frames) {
      const [x, y, w, h] = f.layout.screen;
      expect(x).toBeLessThanOrEqual(0.01);
      expect(y).toBeLessThanOrEqual(0.01);
      expect(x + w).toBeGreaterThanOrEqual(p.output.width - 0.02);
      expect(y + h).toBeGreaterThanOrEqual(p.output.height - 0.02);
    }
  });
  it("validates framing and framingRect", () => {
    expect(() => resolveProject({ output: { framing: "zoom" } })).toThrow(/framing/);
    expect(() => resolveProject({ output: { framingRect: { x: 0, y: 0, w: 0, h: 5 } } })).toThrow(/framingRect/);
    expect(() => resolveProject({ output: { framing: "custom", framingRect: null } })).not.toThrow();
  });
});
