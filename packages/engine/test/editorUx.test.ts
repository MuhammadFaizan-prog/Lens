import { describe, expect, it } from "vitest";
import { buildRenderPlan, fillScreenRect, resolveProject, toSrt, watermarkRect, defaultBrand, layoutFor, defaultProject } from "../src/index.js";
import type { InputEvent } from "../src/index.js";

const meta = { width: 1280, height: 720, fps: 30, durationMs: 4000, pixelRatio: 1 };
const moves = (x: number, y: number): InputEvent[] => Array.from({ length: 40 }, (_, i) => ({ t: i * 100, type: "move", x, y }) as InputEvent);

describe("9:16 fill and follow (Windows bug #8)", () => {
  it("fill covers the output and centres the focus, clamped at the edges", () => {
    const view = { x0: 0, vw: 1280, y0: 0, vh: 720 };
    const r = fillScreenRect({ width: 1080, height: 1920 }, 16 / 9, view, { x: 900, y: 360 });
    expect(r.h).toBe(1920);
    expect(r.w).toBeCloseTo(1920 * 16 / 9, 6);
    expect(r.x + (900 / 1280) * r.w).toBeCloseTo(540, 6);
    const edge = fillScreenRect({ width: 1080, height: 1920 }, 16 / 9, view, { x: 1279, y: 360 });
    expect(edge.x + edge.w).toBeCloseTo(1080, 6);
  });
  it("Social Vertical follows the cursor; fit keeps the letterbox", () => {
    const fill = resolveProject({ output: { aspect: "9:16", resolution: 360, fps: 30, fit: "fill" }, zoom: { auto: false } });
    const plan = buildRenderPlan({ meta, events: moves(1100, 360), project: fill });
    const f = plan.frames[plan.frames.length - 1]!;
    const [sx, , sw, sh] = f.layout.screen;
    expect(sh).toBe(plan.output.height);
    expect(Math.abs(sx + (1100 / 1280) * sw - plan.output.width / 2)).toBeLessThan(plan.output.width * 0.3);
    const fit = buildRenderPlan({ meta, events: moves(1100, 360), project: resolveProject({ output: { aspect: "9:16", resolution: 360, fps: 30 }, zoom: { auto: false } }) });
    expect(fit.frames[0]!.layout.screen[2]).toBeLessThanOrEqual(fit.output.width);
  });
  it("a fixed zoom target is the crop centre in fill mode", () => {
    const p = resolveProject({ output: { aspect: "9:16", resolution: 360, fps: 30, fit: "fill" }, zoom: { auto: false, segments: [{ id: "z", startMs: 0, endMs: 4000, scale: 2, focus: { x: 900, y: 250 }, style: "classic", auto: false }] } });
    const plan = buildRenderPlan({ meta, events: moves(200, 600), project: p });
    const f = plan.frames[plan.frames.length - 1]!;
    const [cx, cy, s] = f.cam;
    expect([Math.round(cx), Math.round(cy), s]).toEqual([900, 250, 2]);
    const [sx, sy, sw, sh] = f.layout.screen;
    const vw = 1280 / s, vh = 720 / s;
    expect(sx + ((900 - (cx - vw / 2)) / vw) * sw).toBeCloseTo(plan.output.width / 2, 0);
    expect(sy + ((250 - (cy - vh / 2)) / vh) * sh).toBeCloseTo(plan.output.height / 2, 0);
  });
});

