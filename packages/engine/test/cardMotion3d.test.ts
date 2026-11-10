/**
 * Integration (integrate/0.1.3): 3D motion composes on the screen card rect from layout
 * (feat/canvas-layout x feat/motion-3d). The plan's m3d is built from f.layout.screen, which is the
 * custom card rect when one is set, so the GL pass tilts the card where the user placed it.
 */
import { describe, expect, it } from "vitest";
import { buildRenderPlan, defaultProject, type Motion3DSegment, type ProjectConfig } from "../src/index.js";
import { demoSession, META } from "./fixtures.js";

const seg: Motion3DSegment = { id: "m", startMs: 0, endMs: 60_000, template: "custom", from: { ry: 20 }, to: { ry: 20 }, easing: "linear", perspective: 2000 };

describe("3D motion on a custom card", () => {
  it("m3d origin is the centre of the card rect; flat frames unchanged", () => {
    const base = defaultProject() as ProjectConfig;
    const card = { x: 0.1, y: 0.2, w: 0.4, h: 0.4 };
    const project: ProjectConfig = { ...base, card, motion3d: [seg] };
    const p = buildRenderPlan({ meta: META, events: demoSession(), project });
    const f = p.frames[5]!;
    expect(f.layout.screen[0]).toBeCloseTo(0.1 * 1920, 1);
    expect(f.layout.screen[1]).toBeCloseTo(0.2 * 1080, 1);
    expect(f.layout.screen[2]).toBeCloseTo(0.4 * 1920, 1);
    expect(f.m3d).toBeTruthy();
    const [sx, sy, sw, sh] = f.layout.screen.map(Math.round) as [number, number, number, number];
    expect(f.m3d!.o[0]).toBeCloseTo(sx + sw / 2, 0);
    expect(f.m3d!.o[1]).toBeCloseTo(sy + sh / 2, 0);
    // the tilted quad stays around the card, not the default fitted rect
    const xs = [f.m3d!.quad[0], f.m3d!.quad[2], f.m3d!.quad[4], f.m3d!.quad[6]];
    expect(Math.min(...xs)).toBeLessThan(0.1 * 1920 + 0.4 * 1920 * 0.25);
    expect(Math.max(...xs)).toBeLessThan(0.5 * 1920 + 0.4 * 1920 * 0.25);
    const flat = buildRenderPlan({ meta: META, events: demoSession(), project: { ...base, card } });
    expect(flat.frames[5]!.m3d).toBeUndefined();
    expect(flat.frames[5]!.layout.screen).toEqual(f.layout.screen);
  });
});
