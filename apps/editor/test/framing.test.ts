/**
 * Framing edits (fix/aspect-framing-014): picking a mode, the custom window from the numeric fields,
 * the on-preview edit view geometry and dragging a filled screen to pan. All windows stay inside the
 * source and keep the canvas aspect.
 */
import { describe, expect, it } from "vitest";
import { buildRenderPlan, defaultProject, fillWindow, resolveProject } from "@lens/engine";
import type { ProjectConfig, Rect } from "@lens/engine";
import { editFramingField, framingChoiceOf, framingWindowOf, resetFramingRect, setAspect, setCardRect, setFraming, setFramingRect } from "../src/state/layoutOps";
import { boxToWindow, editViewRect, framingEditPlan, windowFromDraggedScreen, windowToBox } from "../src/state/framingEdit";

const meta = { width: 1280, height: 720 };
const out = { width: 1080, height: 1920 }; // 9:16
const base = (): ProjectConfig => ({ ...defaultProject(), output: { ...defaultProject().output, aspect: "9:16" } });
const src: Rect = { x: 0, y: 0, w: 1280, h: 720 };
const inside = (r: Rect, b: Rect) => {
  expect(r.x).toBeGreaterThanOrEqual(b.x);
  expect(r.y).toBeGreaterThanOrEqual(b.y);
  expect(r.x + r.w).toBeLessThanOrEqual(b.x + b.w);
  expect(r.y + r.h).toBeLessThanOrEqual(b.y + b.h);
};

describe("setFraming", () => {
  it("each mode clears the free card, keeps fit in step and validates", () => {
    const p0 = setCardRect(base(), { x: 10, y: 900, w: 500, h: 300 }, out);
    expect(framingChoiceOf(p0)).toBe("free");
    for (const m of ["fit", "fill", "follow", "custom"] as const) {
      const p = setFraming(p0, m, meta, out);
      expect(p.card).toBeNull();
      expect(p.output.framing).toBe(m);
      expect(p.output.fit).toBe(m === "follow" ? "fill" : "fit");
      expect(framingChoiceOf(p)).toBe(m);
      expect(() => resolveProject(JSON.parse(JSON.stringify(p)))).not.toThrow();
    }
  });
  it("custom starts from the centred fill window and keeps one already set", () => {
    const p = setFraming(base(), "custom", meta, out);
    expect(p.output.framingRect).toEqual(fillWindow(src, 9 / 16));
    const q = setFraming({ ...p, output: { ...p.output, framingRect: { x: 0, y: 0, w: 270, h: 480 } } }, "custom", meta, out);
    expect(q.output.framingRect).toEqual({ x: 0, y: 0, w: 270, h: 480 });
  });
  it("an aspect change keeps the mode and re-centres (card null)", () => {
    const p = setAspect(setFraming(base(), "follow", meta, out), "1:1");
    expect(p.output.framing).toBe("follow");
    expect(p.card).toBeNull();
  });
});

describe("custom window edits", () => {
  const p0 = setFraming(base(), "custom", meta, out);
  it("x / y move it inside the source, w / h resize it about its centre with the aspect locked", () => {
    const mx = editFramingField(p0, "x", 5000, meta, out);
    const wx = framingWindowOf(mx, meta, out);
    expect(wx.x + wx.w).toBe(1280);
    inside(wx, src);
    const my = editFramingField(p0, "y", -50, meta, out);
    expect(framingWindowOf(my, meta, out).y).toBe(0);
    const rw = framingWindowOf(editFramingField(p0, "w", 270, meta, out), meta, out);
    expect(rw.w).toBe(270);
    expect(rw.h).toBe(480);
    const c0 = framingWindowOf(p0, meta, out);
    expect(Math.abs(rw.x + rw.w / 2 - (c0.x + c0.w / 2))).toBeLessThanOrEqual(1);
    const rh = framingWindowOf(editFramingField(p0, "h", 9999, meta, out), meta, out);
    inside(rh, src);
    expect(Math.abs(rh.w / rh.h - 9 / 16)).toBeLessThan(0.01);
  });
  it("setFramingRect clamps and locks the aspect; reset goes back to the centred fill", () => {
    const p = setFramingRect(p0, { x: -100, y: -100, w: 300, h: 300 }, meta, out);
    const w = p.output.framingRect!;
    inside(w, src);
    expect(Math.abs(w.w / w.h - 9 / 16)).toBeLessThan(0.01);
    expect(resetFramingRect(p, meta, out).output.framingRect).toEqual(fillWindow(src, 9 / 16));
  });
});

describe("edit view geometry", () => {
  const p = setFraming(base(), "custom", meta, out);
  it("the whole recording sits fitted and centred; window <-> box round-trips", () => {
    const view = editViewRect(p, meta, out);
    expect(Math.abs(view.y + view.h / 2 - 960)).toBeLessThan(1);
    expect(Math.abs(view.w / view.h - 16 / 9)).toBeLessThan(0.01);
    const win = { x: 300, y: 100, w: 270, h: 480 };
    const b = windowToBox(win, src, view);
    const back = boxToWindow(b, src, view);
    for (const k of ["x", "y", "w", "h"] as const) expect(back[k]).toBeCloseTo(win[k], 6);
  });
  it("the edit plan frame shows the full crop, unzoomed, no cursor", () => {
    const plan = buildRenderPlan({ meta: { ...meta, fps: 30, durationMs: 2000, pixelRatio: 1 }, events: [], project: resolveProject(JSON.parse(JSON.stringify(p))) });
    const view = editViewRect(p, meta, out);
    const ep = framingEditPlan(plan, 5, src, view);
    expect(ep.source.crop).toEqual([0, 0, 1280, 720]);
    expect(ep.frames[5]!.cam).toEqual([640, 360, 1]);
    expect(ep.frames[5]!.cur).toBeNull();
    expect(ep.frames[5]!.layout.screen).toEqual([view.x, view.y, view.w, view.h]);
    const fw = fillWindow(src, 9 / 16);
    expect(plan.source.crop).toEqual([fw.x, fw.y, fw.w, fw.h]);
  });
  it("dragging a filled screen pans the window the other way; growing it zooms in", () => {
    const win = { x: 336, y: 0, w: 405, h: 720 };
    const moved = windowFromDraggedScreen(win, { x: 108, y: 0, w: 1080, h: 1920 }, out);
    expect(moved.x).toBeCloseTo(336 - 108 * (405 / 1080), 6);
    expect(moved.w).toBeCloseTo(405, 6);
    const zoomed = windowFromDraggedScreen(win, { x: -540, y: -960, w: 2160, h: 3840 }, out);
    expect(zoomed.w).toBeCloseTo(202.5, 6);
    expect(zoomed.x + zoomed.w / 2).toBeCloseTo(win.x + win.w / 2, 6);
  });
});
