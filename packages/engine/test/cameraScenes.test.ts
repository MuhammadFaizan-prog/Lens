/**
 * Camera scenes (demand #18): per-scene layout, PiP corner and transition on camera.layouts.
 * Old projects (layouts without corner / transitionMs) must plan byte-identically to the engine before
 * scenes: the golden hashes below were produced by planHashes() run against 7d1a5db's engine.
 */
import { describe, expect, it } from "vitest";
import { buildRenderPlan, layoutAt, outputSize, resolveProject, sceneAt, ProjectValidationError, type CameraLayoutSegment } from "../src/index.js";
import { demoSession, META } from "./fixtures.js";
import { planHashes } from "./cameraScenesCases.js";

const GOLDEN_7D1A5DB: Record<string, string> = {
  "no layouts, webcam on": "c5d28a789f64fc9f272db872373bca1043f6fe846b591493c0d35b134dec871f",
  "split 1-5 s": "d7d2d82de906ddaae1d8f9efef923eac28da5f0992073991163515ebdbb0b762",
  "every kind back to back": "81e5f2b90fbcaad1ef4589df41cf8a04c255cd065deed8bab25c79029f0c5c43",
  "overlapping, 9:16, no transition": "bcdddd06ee61c48b9b4725fa43ef70f4a313d9d8eb4a9b1e4c32b72b078e08de",
  "free position + zoom shrink": "f97ea0f5aa8f044f39adebb4a638c27b19c70b7d2bf17333acedf2841fc04c47",
  "webcam off with layouts": "d5956045e8fbb27b90cc87bb309d25dbcff41a7be176c7523af3bef9dc19ab43",
};

const out = outputSize("16:9", 1080);
const cfgWith = (layouts: CameraLayoutSegment[], camera: Record<string, unknown> = {}) => resolveProject({ camera: { enabled: true, corner: "bottom-right", ...camera, layouts } });
const centreOf = (r: { x: number; y: number; w: number; h: number }) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

describe("camera scenes: old projects", () => {
  it("plan byte-identically to the engine before scenes (6 golden plans)", () => {
    expect(planHashes()).toEqual(GOLDEN_7D1A5DB);
  });
});

describe("camera scenes: layout", () => {
  it("a PiP scene's corner replaces the project corner inside it only", () => {
    const cfg = cfgWith([{ startMs: 1000, endMs: 3000, kind: "camera-overlay", corner: "top-left" }]);
    const inside = layoutAt(2500, cfg.camera.layouts, out, 16 / 9, cfg);
    const outside = layoutAt(5000, cfg.camera.layouts, out, 16 / 9, cfg);
    expect(inside.corner).toBe("top-left");
    expect(centreOf(inside.camera!).x).toBeLessThan(out.width / 2);
    expect(centreOf(inside.camera!).y).toBeLessThan(out.height / 2);
    expect(outside.corner).toBeUndefined();
    expect(centreOf(outside.camera!).x).toBeGreaterThan(out.width / 2);
    expect(centreOf(outside.camera!).y).toBeGreaterThan(out.height / 2);
    // same size as the project's bubble, mirrored placement
    expect(inside.camera!.w).toBeCloseTo(outside.camera!.w, 6);
    expect(inside.camera!.x).toBeCloseTo(out.width - outside.camera!.x - outside.camera!.w, 6);
  });

  it("a scene corner beats a free (dragged) webcam position", () => {
    const cfg = cfgWith([{ startMs: 0, endMs: 3000, kind: "camera-overlay", corner: "top-right" }], { position: { x: 0.2, y: 0.8 } });
    const l = layoutAt(2000, cfg.camera.layouts, out, 16 / 9, cfg);
    expect(centreOf(l.camera!).x).toBeGreaterThan(out.width / 2);
    expect(centreOf(l.camera!).y).toBeLessThan(out.height / 2);
  });

  it("each scene eases in over its own transition, then holds", () => {
    const cfg = cfgWith([{ startMs: 1000, endMs: 4000, kind: "fullscreen-camera", transitionMs: 1000 }], { transitionMs: 300 });
    const at = (t: number) => layoutAt(t, cfg.camera.layouts, out, 16 / 9, cfg);
    const start = at(999).camera!, mid = at(1500).camera!, end = at(2000).camera!, hold = at(3000).camera!;
    expect(end).toEqual(hold);
    expect(mid.w).toBeGreaterThan(start.w);
    expect(mid.w).toBeLessThan(end.w);
    // easeInOutCubic(0.5) = 0.5: the midpoint is halfway
    expect(mid.w).toBeCloseTo((start.w + end.w) / 2, 6);
    // 300 ms in (the project default) the 1 s transition is still running
    expect(at(1300).camera!.w).toBeLessThan(end.w - 1);
    // leaving the scene uses its transition too (back to the default overlay)
    const back = at(4500).camera!;
    expect(back.w).toBeGreaterThan(start.w + 1);
    expect(back.w).toBeLessThan(end.w - 1);
  });

  it("transition 0 cuts, and the entering scene's transition wins at a shared edge", () => {
    const cfg = cfgWith([
      { startMs: 1000, endMs: 2000, kind: "split", transitionMs: 0 },
      { startMs: 2000, endMs: 4000, kind: "fullscreen-camera", transitionMs: 800 },
    ]);
    const at = (t: number) => layoutAt(t, cfg.camera.layouts, out, 16 / 9, cfg);
    expect(at(1000).camera).toEqual(at(1900).camera);
    expect(at(1000).kind).toBe("split");
    const mid = at(2400).camera!;
    expect(mid.w).toBeGreaterThan(at(1900).camera!.w + 1);
    expect(mid.w).toBeLessThan(at(2800).camera!.w - 1);
  });

  it("switching only the corner between two PiP scenes animates the bubble across", () => {
    const cfg = cfgWith([
      { startMs: 0, endMs: 2000, kind: "camera-overlay", corner: "top-left" },
      { startMs: 2000, endMs: 4000, kind: "camera-overlay", corner: "bottom-right", transitionMs: 600 },
    ]);
    const at = (t: number) => centreOf(layoutAt(t, cfg.camera.layouts, out, 16 / 9, cfg).camera!);
    const a = at(1900), m = at(2300), b = at(3000);
    expect(m.x).toBeGreaterThan(a.x + 10);
    expect(m.x).toBeLessThan(b.x - 10);
  });

  it("sceneAt finds the active scene, none with the webcam off", () => {
    const L: CameraLayoutSegment[] = [{ startMs: 1000, endMs: 2000, kind: "split" }, { startMs: 1500, endMs: 1800, kind: "screen-only" }];
    expect(sceneAt(L, 500)).toBeNull();
    expect(sceneAt(L, 1200)?.kind).toBe("split");
    expect(sceneAt(L, 1600)?.kind).toBe("screen-only");
    expect(sceneAt(L, 1600, false)).toBeNull();
  });
});

describe("camera scenes: plan", () => {
  it("the zoom shrink of a PiP scene stays anchored in the scene's corner", () => {
    const project = resolveProject({ output: { resolution: 360, fps: 30 }, camera: { enabled: true, corner: "bottom-right", zoomedSize: 0.5, layouts: [{ startMs: 0, endMs: 60_000, kind: "camera-overlay", corner: "top-left" }] } });
    const plan = buildRenderPlan({ meta: META, events: demoSession(), project });
    // frames after the scene's entry transition (it starts at 0 and eases in from the project corner over 500 ms)
    const cams = plan.frames.filter((f) => f.src >= 600).map((f) => f.layout.camera!).filter(Boolean);
    const widths = cams.map((c) => c[2]);
    expect(Math.min(...widths)).toBeLessThan(Math.max(...widths) * 0.8); // the shrink happens
    const x0 = cams[0]![0], y0 = cams[0]![1];
    for (const c of cams) {
      expect(Math.abs(c[0] - x0)).toBeLessThan(0.02);
      expect(Math.abs(c[1] - y0)).toBeLessThan(0.02);
    }
  });

  it("validates scene fields", () => {
    expect(() => resolveProject({ camera: { layouts: [{ startMs: 0, endMs: 1000, kind: "split", corner: "middle" }] } })).toThrow(ProjectValidationError);
    expect(() => resolveProject({ camera: { layouts: [{ startMs: 0, endMs: 1000, kind: "split", transitionMs: -5 }] } })).toThrow(ProjectValidationError);
    expect(() => resolveProject({ camera: { layouts: [{ startMs: 1000, endMs: 500, kind: "split" }] } })).toThrow(ProjectValidationError);
    expect(() => resolveProject({ camera: { layouts: [{ startMs: 0, endMs: 1000, kind: "camera-overlay", corner: "top-left", transitionMs: 250, id: "scene-1" }] } })).not.toThrow();
  });
});
