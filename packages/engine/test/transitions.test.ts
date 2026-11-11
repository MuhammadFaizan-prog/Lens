import { describe, expect, it } from "vitest";
import {
  animState,
  buildRenderPlan,
  cameraEnterExit,
  cutJoins,
  ease,
  layoutAt,
  layoutFor,
  resolveProject,
  slideFrame,
  transitionLayers,
  type PlanFrame,
  type RenderPlan,
} from "../src/index.js";
import { buildTimeline } from "../src/timeline.js";
import { META, demoSession } from "./fixtures.js";
import { goldenProjects, planHash } from "./transitionsGolden.js";

const plan = (project: unknown): RenderPlan => buildRenderPlan({ meta: META, events: demoSession(), project: resolveProject(project) });
const CUTS = [{ startMs: 1000, endMs: 1500 }, { startMs: 3000, endMs: 4000 }];
const base = { output: { resolution: 360, fps: 30 }, edits: { cuts: CUTS } };

describe("easing", () => {
  it("every curve runs 0 -> 1, ease-in-out is symmetric, spring overshoots once", () => {
    for (const k of ["linear", "ease-in", "ease-out", "ease-in-out", "spring"] as const) {
      expect(ease(k, 0)).toBeCloseTo(0, 6);
      expect(ease(k, 1)).toBeCloseTo(1, 6);
    }
    expect(ease("ease-in-out", 0.5)).toBeCloseTo(0.5, 6);
    expect(ease("ease-in", 0.5)).toBeLessThan(0.5);
    expect(ease("ease-out", 0.5)).toBeGreaterThan(0.5);
    let peak = 0;
    for (let u = 0; u <= 1; u += 0.01) peak = Math.max(peak, ease("spring", u));
    expect(peak).toBeGreaterThan(1.05);
  });
});

describe("old projects", () => {
  it("plans are byte-identical to main 7d1a5db (hashes computed there)", () => {
    const want: Record<string, string> = {
      "cuts+speed": "6579c5a766b7df34a1f3186df7aa3b6d2d1989dd96e27d23315c6d85e4357c99",
      "slides+brand+camera+annotations": "cdd97e349809e0b4b491b42742c972a68b9b222cb36d388e4d8c178c9f78cdab",
    };
    for (const g of goldenProjects()) expect(planHash(g.project), g.name).toBe(want[g.name]);
  });

  it("no transitions config = no tr on any frame; kind none = same plan", () => {
    const a = plan(base);
    expect(a.frames.some((f) => f.tr)).toBe(false);
    const b = plan({ ...base, transitions: { kind: "none", durationMs: 500, easing: "ease-in-out", scope: "all" } });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe("cut transitions", () => {
  const p = plan({ ...base, transitions: { kind: "crossfade", durationMs: 400, easing: "linear", scope: "manual" } });
  const joinFrames = (pl: RenderPlan) => pl.frames.map((f, i) => ({ f, i })).filter(({ f }) => f.tr);

  it("marks frames within ±d/2 of each join, other side held, progress 0..1", () => {
    // joins at output 1000 ms (source 1000 -> 1500) and 2500 ms (source 3000 -> 4000)
    const tr = joinFrames(p);
    // 400 ms at 30 fps: 12 frames per join
    expect(tr.length).toBe(24);
    const first = tr.filter(({ f }) => f.t < 1800);
    for (const { f, i } of first) {
      expect(Math.abs(f.t - 1000)).toBeLessThanOrEqual(200 + 1e-6);
      expect(f.tr!.incoming).toBe(f.t >= 1000);
      expect(f.tr!.other).toBe(f.tr!.incoming ? 29 : 30);
      const raw = (f.t - 800) / 400;
      expect(f.tr!.u).toBeCloseTo(raw, 3);
      expect(i).toBeGreaterThan(0);
    }
    expect(p.frames[30]!.src).toBeCloseTo(1500, 0);
    expect(p.frames[29]!.src).toBeLessThan(1000);
  });

  it("per-cut override wins (kind / duration), none disables one cut", () => {
    const q = plan({
      ...base,
      edits: { cuts: [{ ...CUTS[0], transition: { kind: "push", durationMs: 200 } }, { ...CUTS[1], transition: { kind: "none" } }] },
      transitions: { kind: "crossfade", durationMs: 400, easing: "linear", scope: "manual" },
    });
    const tr = joinFrames(q);
    expect(tr.length).toBe(6);
    expect(tr.every(({ f }) => f.tr!.kind === "push")).toBe(true);
    // a cut's own transition works without a project default
    const r = plan({ ...base, edits: { cuts: [{ ...CUTS[0], transition: { kind: "zoom" } }, CUTS[1]] } });
    const tz = joinFrames(r);
    expect(tz.length).toBeGreaterThan(0);
    expect(tz.every(({ f }) => f.tr!.kind === "zoom" && Math.abs(f.t - 1000) <= 250)).toBe(true);
  });

  it("scope manual skips cleanup / speed joins; durations clamp to the neighbouring pieces", () => {
    const pieces = buildTimeline(12000, [{ startMs: 1000, endMs: 1500 }, { startMs: 1600, endMs: 2000 }], []);
    const cfg = { kind: "crossfade" as const, durationMs: 1000, easing: "linear" as const, scope: "manual" as const };
    // only the first cut is manual
    const j = cutJoins(pieces, [{ startMs: 1000, endMs: 1500 }], cfg);
    expect(j.length).toBe(1);
    expect(j[0]!.durationMs).toBeCloseTo(100, 6); // the 1500..1600 piece is 100 ms long
    expect(cutJoins(pieces, [{ startMs: 1000, endMs: 1500 }], { ...cfg, scope: "all" }).length).toBe(2);
    // speed boundaries are continuous: no join
    expect(cutJoins(buildTimeline(12000, [], [{ startMs: 2000, endMs: 3000, rate: 2 }]), [], { ...cfg, scope: "all" }).length).toBe(0);
  });

  it("no transition across a slide placed at the cut, and none in partial plans", () => {
    const q = plan({
      ...base,
      transitions: { kind: "crossfade", durationMs: 400, easing: "linear", scope: "manual" },
      slides: [{ id: "s", atMs: 1200, durationMs: 1000, title: "T", subtitle: "", background: "#000000", textColor: "#ffffff", accent: null, fadeMs: 0, titleSize: 84, subtitleSize: 40 }],
    });
    expect(q.frames.filter((f) => f.tr).length).toBe(12); // only the second join
    const part = buildRenderPlan({ meta: META, events: demoSession(), project: resolveProject({ ...base, transitions: { kind: "crossfade", durationMs: 400, easing: "linear", scope: "manual" } }), onlyFrames: [29, 30] });
    expect(part.frames.some((f: PlanFrame) => f.tr)).toBe(false);
  });

  it("composite layers: crossfade midpoint is half / half, push moves both one width", () => {
    expect(transitionLayers("crossfade", 0.5).b.alpha).toBeCloseTo(0.5, 6);
    const push = transitionLayers("push", 0.25);
    expect(push.a.dx).toBeCloseTo(-0.25, 6);
    expect(push.b.dx).toBeCloseTo(0.75, 6);
    expect(transitionLayers("blur", 0.5).a.blur).toBeGreaterThan(0.02);
    expect(transitionLayers("blur", 0).a.blur).toBeCloseTo(0, 6);
    expect(transitionLayers("zoom", 1).b).toEqual({ alpha: 1, scale: 1, dx: 0, blur: 0 });
  });

  it("validation", () => {
    expect(() => resolveProject({ transitions: { kind: "wipe", durationMs: 400, easing: "linear", scope: "manual" } })).toThrow(/transitions.kind/);
    expect(() => resolveProject({ edits: { cuts: [{ startMs: 0, endMs: 10, transition: { durationMs: 10 } }] } })).toThrow(/durationMs/);
    expect(() => resolveProject({ transitions: { kind: "push", durationMs: 400, easing: "bouncy", scope: "manual" } })).toThrow(/easing/);
  });
});

describe("enter / exit", () => {
  const sl = { id: "s", atMs: 0, durationMs: 2000, title: "T", subtitle: "", background: "#000000", textColor: "#ffffff", accent: null, fadeMs: 250, titleSize: 84, subtitleSize: 40 };

  it("slides without enter / exit keep the fadeMs cross-fade and no fx", () => {
    const f = slideFrame(sl, 100, 1920, 1080, 1);
    expect(f.fx).toBeUndefined();
    expect(f.opacity).toBeCloseTo(1 - (1 - 100 / 250) ** 3, 3);
  });

  it("slide-up enters from below, exits out the top; zoom scales; blur blurs; settled = no fx", () => {
    const s = { ...sl, enter: { kind: "slide-up" as const, ms: 400, easing: "linear" as const }, exit: { kind: "slide-up" as const, ms: 400, easing: "linear" as const } };
    expect(slideFrame(s, 0, 1920, 1080, 1).fx![1]).toBeCloseTo(1080, 1);
    expect(slideFrame(s, 200, 1920, 1080, 1).fx![1]).toBeCloseTo(540, 1);
    expect(slideFrame(s, 1000, 1920, 1080, 1).fx).toBeUndefined();
    expect(slideFrame(s, 1000, 1920, 1080, 1).opacity).toBe(1);
    expect(slideFrame(s, 1800, 1920, 1080, 1).fx![1]).toBeCloseTo(-540, 1);
    const z = slideFrame({ ...sl, enter: { kind: "zoom", ms: 400, easing: "linear" } }, 200, 1920, 1080, 1);
    expect(z.fx![2]).toBeCloseTo(0.9, 3);
    expect(z.opacity).toBeCloseTo(0.5, 3);
    // the exit side without its own animation keeps the fadeMs fade
    expect(slideFrame({ ...sl, enter: { kind: "zoom", ms: 400 } }, 1900, 1920, 1080, 1).opacity).toBeCloseTo(1 - (1 - 100 / 250) ** 3, 3);
    expect(slideFrame({ ...sl, enter: { kind: "blur", ms: 400, easing: "linear" } }, 0, 1920, 1080, 1).fx![3]).toBeCloseTo(32.4, 1);
  });

  it("brand title cards carry their enter / exit into the plan", () => {
    const q = plan({ output: { resolution: 360, fps: 30 }, brand: { enabled: true, intro: { enabled: true, title: "Hi", subtitle: "", durationMs: 1000, logo: false, enter: { kind: "slide-left", ms: 300, easing: "linear" } } } });
    expect(q.frames[0]!.slide!.fx![0]).toBeCloseTo(640, 0);
    expect(q.frames[15]!.slide!.fx).toBeUndefined();
  });

  it("webcam enter / exit: pop scales from the centre, slide comes from the side, fade fades", () => {
    const out = { width: 1920, height: 1080 };
    const cfg = resolveProject({ camera: { enabled: true } });
    const off = layoutFor("screen-only", out, 16 / 9, cfg);
    const on = layoutFor("camera-overlay", out, 16 / 9, cfg);
    const cam = on.camera!;
    const pop = cameraEnterExit(off, on, { kind: "pop", ms: 400, easing: "linear" }, 200, out);
    expect(pop.camera!.w).toBeCloseTo(cam.w * 0.7, 3);
    expect(pop.camera!.x + pop.camera!.w / 2).toBeCloseTo(cam.x + cam.w / 2, 3);
    const slide = cameraEnterExit(off, on, { kind: "slide", ms: 400, easing: "linear" }, 0, out);
    expect(slide.camera!.x).toBeCloseTo(1920, 3); // bottom-right corner: in from the right edge
    const fadeOut = cameraEnterExit(on, off, { kind: "fade", ms: 400, easing: "linear" }, 100, out);
    expect(fadeOut.cameraOpacity).toBeCloseTo(0.75, 3);
    expect(cameraEnterExit(off, on, { kind: "fade", ms: 400 }, 400, out)).toEqual(on);
    // through layoutAt: the segment hides the camera at 1 s, exit animates after it
    const p2 = resolveProject({ camera: { enabled: true, layouts: [{ startMs: 1000, endMs: 3000, kind: "screen-only" }], exit: { kind: "fade", ms: 400, easing: "linear" } } });
    expect(layoutAt(1100, p2.camera.layouts, out, 16 / 9, p2).cameraOpacity).toBeCloseTo(0.75, 3);
    // camera.enter absent: the comeback at 3 s uses the legacy transition
    const legacy = layoutAt(3100, p2.camera.layouts, out, 16 / 9, p2);
    const plain = layoutAt(3100, p2.camera.layouts, out, 16 / 9, resolveProject({ camera: { enabled: true, layouts: [{ startMs: 1000, endMs: 3000, kind: "screen-only" }] } }));
    expect(legacy).toEqual(plain);
  });

  it("annotation easing changes the curve; absent keeps the old one", () => {
    const a = { startMs: 0, endMs: 2000, in: { kind: "fade" as const, ms: 400 }, out: { kind: "none" as const, ms: 0 } };
    expect(animState(a, 200)!.opacity).toBeCloseTo(1 - 0.5 ** 3, 4);
    expect(animState({ ...a, in: { ...a.in, easing: "linear" } }, 200)!.opacity).toBeCloseTo(0.5, 4);
    expect(animState({ ...a, in: { kind: "pop", ms: 400, easing: "ease-in" } }, 200)!.scale).toBeCloseTo(0.4 + 0.6 * 0.125, 4);
    expect(() => resolveProject({ annotations: [{ id: "x", kind: "rect", startMs: 0, endMs: 1000, rect: { x: 0, y: 0, w: 10, h: 10 }, in: { kind: "fade", ms: 200, easing: "wobble" } }] })).toThrow(/easing/);
  });
});
