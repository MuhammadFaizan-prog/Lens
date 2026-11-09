/**
 * Annotations (demand #4): animation curves, timing, tessellation, anchoring, slides, step labels.
 * Bounds here were written before the first run (docs/Tracker.md).
 */
import { describe, expect, it } from "vitest";
import {
  animState,
  annotationFrame,
  applyStepDrafts,
  arrowPath,
  badgeNumbers,
  buildRenderPlan,
  buildTimeline,
  calloutNotch,
  easeInOutCubic,
  easeOutCubic,
  editStepLabel,
  insertSlides,
  normalizeAnnotation,
  outputToSource,
  pathLength,
  popScale,
  popSpring,
  ProjectValidationError,
  resolveProject,
  reviewSteps,
  roundRectPoints,
  sourceToOutput,
  truncatePath,
  type Annotation,
  type StepDraft,
} from "../src/index.js";
import { demoSession, META } from "./fixtures.js";

const SP = { cropX: 0, cropY: 0, width: 1920, height: 1080, resScale: 1 };

function arrow(over: Partial<Annotation> = {}): Annotation {
  return normalizeAnnotation({ id: "a1", kind: "arrow", startMs: 1000, endMs: 4000, from: { x: 100, y: 100 }, to: { x: 500, y: 100 }, ...over });
}

describe("animation curves", () => {
  it("ease curves start at 0, end at 1 and are monotonic", () => {
    for (const f of [easeOutCubic, easeInOutCubic]) {
      expect(f(0)).toBe(0);
      expect(f(1)).toBe(1);
      let prev = -1;
      for (let i = 0; i <= 100; i++) {
        const v = f(i / 100);
        expect(v).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    }
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 9);
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
  });

  it("pop spring overshoots once (10-25%), lands exactly on 1 and is continuous", () => {
    expect(popSpring(0)).toBe(0);
    expect(popSpring(1)).toBe(1);
    let peak = 0;
    let prev = 0;
    let maxStep = 0;
    for (let i = 1; i <= 1000; i++) {
      const v = popSpring(i / 1000);
      peak = Math.max(peak, v);
      maxStep = Math.max(maxStep, Math.abs(v - prev));
      prev = v;
    }
    expect(peak).toBeGreaterThan(1.1);
    expect(peak).toBeLessThan(1.25);
    expect(maxStep).toBeLessThan(0.03); // no jumps at 1000 steps
    expect(Math.abs(popSpring(0.999) - 1)).toBeLessThan(0.02);
    expect(popScale(0)).toBeCloseTo(0.4, 9);
    expect(popScale(1)).toBe(1);
  });

  it("in / out timing: fade, pop, draw, typewriter at known times", () => {
    const a = { startMs: 1000, endMs: 3000, in: { kind: "draw" as const, ms: 500 }, out: { kind: "fade" as const, ms: 400 } };
    expect(animState(a, 999)).toBeNull();
    expect(animState(a, 3000)).toBeNull();
    expect(animState(a, 1000)!.draw).toBe(0);
    expect(animState(a, 1250)!.draw).toBeCloseTo(0.5, 9);
    expect(animState(a, 1500)!.draw).toBe(1);
    expect(animState(a, 2000)).toEqual({ opacity: 1, scale: 1, draw: 1, type: 1 });
    expect(animState(a, 2800)!.opacity).toBeCloseTo(easeOutCubic(0.5), 9);
    const tw = { startMs: 0, endMs: 2000, in: { kind: "typewriter" as const, ms: 1000 }, out: { kind: "none" as const, ms: 0 } };
    expect(animState(tw, 250)!.type).toBeCloseTo(0.25, 9);
    const pop = { startMs: 0, endMs: 2000, in: { kind: "pop" as const, ms: 400 }, out: { kind: "pop" as const, ms: 400 } };
    expect(animState(pop, 200)!.scale).toBeCloseTo(popScale(0.5), 9);
    expect(animState(pop, 1900)!.scale).toBeCloseTo(popScale(0.25), 9);
    // short items: in and out shrink to half the life each
    const short = { startMs: 0, endMs: 400, in: { kind: "draw" as const, ms: 1000 }, out: { kind: "fade" as const, ms: 1000 } };
    expect(animState(short, 100)!.draw).toBeCloseTo(easeInOutCubic(0.5), 9);
    expect(animState(short, 300)!.opacity).toBeCloseTo(easeOutCubic(0.5), 9);
  });
});

describe("geometry", () => {
  it("arrow path: endpoints, curve bends to the side, truncation by arc length", () => {
    const p = arrowPath({ x: 0, y: 0 }, { x: 100, y: 0 }, 0);
    expect(pathLength(p)).toBeCloseTo(100, 6);
    const c = arrowPath({ x: 0, y: 0 }, { x: 100, y: 0 }, 0.3);
    expect(c[0]).toEqual({ x: 0, y: 0 });
    expect(c[c.length - 1]!.x).toBeCloseTo(100, 9);
    expect(c[24]!.y).toBeCloseTo(15, 6); // quadratic midpoint = half the control offset (0.3 * 100)
    const t = truncatePath(p, 40);
    expect(t[t.length - 1]!.x).toBeCloseTo(40, 6);
    expect(pathLength(t)).toBeCloseTo(40, 6);
  });

  it("arrow draw-on: the head travels with the drawn tip", () => {
    const a = arrow({ in: { kind: "draw", ms: 1000 } });
    for (const [t, frac] of [[1250, easeInOutCubic(0.25)], [1500, 0.5], [1750, easeInOutCubic(0.75)], [2500, 1]] as const) {
      const f = annotationFrame(a, t, SP, new Map())!;
      expect(f.anim.draw).toBeCloseTo(frac, 3);
      const head = f.ops.find((o) => o.op === "fill")!;
      expect(head.op).toBe("fill");
      if (head.op === "fill") expect(head.pts[0]).toBeCloseTo(100 + 400 * frac, 0); // triangle's first point is the tip
    }
  });

  it("rounded rect polygon stays inside its rect and a callout notch reaches the tip", () => {
    const r = { x: 10, y: 20, w: 200, h: 80 };
    const pts = roundRectPoints(r, 12);
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(10 - 1e-9);
      expect(p.x).toBeLessThanOrEqual(210 + 1e-9);
      expect(p.y).toBeGreaterThanOrEqual(20 - 1e-9);
      expect(p.y).toBeLessThanOrEqual(100 + 1e-9);
    }
    const n = calloutNotch(r, 12, { x: 300, y: 60 }, 24)!;
    expect(n.side).toBe("right");
    const withNotch = roundRectPoints(r, 12, n);
    expect(withNotch.some((p) => p.x === 300 && p.y === 60)).toBe(true);
    expect(calloutNotch(r, 12, { x: 50, y: 50 }, 24)).toBeUndefined();
    expect(calloutNotch(r, 12, { x: 100, y: 400 }, 24)!.side).toBe("bottom");
  });

  it("screen anchor subtracts the crop; frame anchor scales with output size", () => {
    const box = normalizeAnnotation({ id: "b", kind: "rect", startMs: 0, endMs: 1000, rect: { x: 300, y: 200, w: 100, h: 50 }, in: { kind: "none", ms: 0 } });
    const f = annotationFrame(box, 500, { ...SP, cropX: 100, cropY: 50 }, new Map())!;
    const stroke = f.ops.find((o) => o.op === "stroke")!;
    const xs = stroke.op === "stroke" ? stroke.pts.filter((_, i) => i % 2 === 0) : [];
    expect(Math.min(...xs)).toBeCloseTo(200, 6);
    const fr = normalizeAnnotation({ id: "c", kind: "rect", anchor: "frame", startMs: 0, endMs: 1000, rect: { x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, in: { kind: "none", ms: 0 } });
    const g = annotationFrame(fr, 500, { cropX: 0, cropY: 0, width: 1280, height: 720, resScale: 720 / 1080 }, new Map())!;
    const s2 = g.ops.find((o) => o.op === "stroke")!;
    if (s2.op === "stroke") {
      expect(Math.min(...s2.pts.filter((_, i) => i % 2 === 0))).toBeCloseTo(320, 6);
      expect(s2.width).toBeCloseTo(5 * (720 / 1080), 2);
    }
  });

  it("typewriter reveals characters in order; layout text stays whole", () => {
    const t = normalizeAnnotation({ id: "t", kind: "text", startMs: 0, endMs: 3000, rect: { x: 10, y: 10, w: 0, h: 0 }, text: "Click Save", in: { kind: "typewriter", ms: 1000 } });
    const f = annotationFrame(t, 500, SP, new Map())!;
    const op = f.ops.find((o) => o.op === "text")!;
    expect(op.op === "text" && op.text).toBe("Click Save");
    expect(op.op === "text" && op.chars).toBe(5);
    expect(annotationFrame(t, 1500, SP, new Map())!.anim.chars).toBe(-1);
  });
});

describe("badges and step labels", () => {
  const draft = (id: string, clickMs: number, label: string): StepDraft => ({ id, clickMs, x: 100, y: 100 + clickMs / 10, label, target: label.split(" ").slice(1).join(" "), verb: "Click", confidence: 0.9, state: "pending" });

  it("auto badges number 1, 2, 3 by click time whatever the order they were accepted in", () => {
    let p = resolveProject({});
    p = applyStepDrafts(p, [draft("s3", 9000, "Click Export"), draft("s1", 1000, "Open Settings"), draft("s2", 5000, "Click Save")]);
    p = reviewSteps(p, ["s3"], "accepted");
    p = reviewSteps(p, ["s1"], "accepted");
    p = reviewSteps(p, ["s2"], "accepted");
    const nums = badgeNumbers(p.annotations);
    const byStep = Object.fromEntries(p.annotations.map((a) => [a.stepId, nums.get(a.id)]));
    expect(byStep).toEqual({ s1: 1, s2: 2, s3: 3 });
    // dismissing one renumbers the rest
    p = reviewSteps(p, ["s2"], "dismissed");
    const n2 = badgeNumbers(p.annotations);
    expect(Object.fromEntries(p.annotations.map((a) => [a.stepId, n2.get(a.id)]))).toEqual({ s1: 1, s3: 2 });
    // editing a label follows into the badge; a re-run keeps state and edited label
    p = editStepLabel(p, "s3", "Export the video");
    expect(p.annotations.find((a) => a.stepId === "s3")!.text).toBe("Export the video");
    p = applyStepDrafts(p, [draft("x1", 1000, "Open Settings"), draft("x2", 5000, "Click Save"), draft("x3", 9000, "Click Export")]);
    expect(p.stepLabels.drafts.map((d) => [d.state, d.label])).toEqual([["accepted", "Open Settings"], ["dismissed", "Click Save"], ["accepted", "Export the video"]]);
    expect(p.annotations.length).toBe(2);
  });

  it("explicit badge numbers are kept", () => {
    const a = normalizeAnnotation({ id: "b1", kind: "badge", startMs: 5000, endMs: 6000, at: { x: 0, y: 0 }, number: 7 });
    const b = normalizeAnnotation({ id: "b2", kind: "badge", startMs: 0, endMs: 1000, at: { x: 0, y: 0 } });
    const n = badgeNumbers([a, b]);
    expect(n.get("b1")).toBe(7);
    expect(n.get("b2")).toBe(1);
  });
});

describe("text slides on the timeline", () => {
  it("insert a slide: later pieces shift by its duration, source holds during it", () => {
    const base = buildTimeline(10000, [{ startMs: 2000, endMs: 3000 }], []);
    const { pieces, spans } = insertSlides(base, [{ id: "s", atMs: 5000, durationMs: 1500 }]);
    expect(spans).toEqual([{ id: "s", outStart: 4000, outEnd: 5500, srcAt: 5000 }]);
    expect(outputToSource(pieces, 3999)).toBeCloseTo(4999, 6);
    expect(outputToSource(pieces, 4500)).toBe(5000);
    expect(outputToSource(pieces, 5500)).toBe(5000);
    expect(outputToSource(pieces, 6500)).toBe(6000);
    expect(sourceToOutput(pieces, 6000)).toBe(6500);
    expect(pieces[pieces.length - 1]!.outEnd).toBe(10500);
  });

  it("a slide inside a cut lands where the cut is; two slides stack in list order; one at the end", () => {
    const base = buildTimeline(10000, [{ startMs: 2000, endMs: 3000 }], []);
    const { spans } = insertSlides(base, [
      { id: "a", atMs: 2500, durationMs: 1000 },
      { id: "b", atMs: 2500, durationMs: 500 },
      { id: "z", atMs: 10000, durationMs: 800 },
    ]);
    expect(spans).toEqual([
      { id: "a", outStart: 2000, outEnd: 3000, srcAt: 3000 },
      { id: "b", outStart: 3000, outEnd: 3500, srcAt: 3000 },
      { id: "z", outStart: 10500, outEnd: 11300, srcAt: 10000 },
    ]);
  });

  it("plan: slide frames, exact output length, no clicks or caption during the slide, audio pieces shifted", () => {
    const project = resolveProject({
      output: { fps: 30, resolution: 720 },
      slides: [{ id: "intro", atMs: 0, durationMs: 2000, title: "Hello" }, { id: "mid", atMs: 5000, durationMs: 1000, title: "Part 2" }],
      audio: { tracks: [{ id: "mic", kind: "mic", path: "mic.wav", offsetMs: 0, volume: 1, muted: false }] },
    });
    const plain = buildRenderPlan({ meta: META, events: demoSession(), project: resolveProject({ output: { fps: 30, resolution: 720 } }) });
    const plan = buildRenderPlan({ meta: META, events: demoSession(), project });
    expect(plan.output.frames - plain.output.frames).toBe(90); // 3 s at 30 fps exactly
    const slideFrames = plan.frames.filter((f) => f.slide);
    expect(slideFrames.length).toBe(90);
    expect(plan.frames.slice(0, 60).every((f) => f.slide?.id === "intro" && f.src === 0)).toBe(true);
    expect(plan.frames[60]!.slide).toBeNull();
    expect(slideFrames.every((f) => f.clicks.length === 0 && f.caption === null && f.camVel.every((v) => v === 0))).toBe(true);
    expect(plan.slides.map((s) => [s.id, s.outStart, s.outEnd])).toEqual([["intro", 0, 2000], ["mid", 7000, 8000]]);
    // audio: nothing plays during the slides; source 6000 plays at output 9000
    const pcs = plan.audio!.pieces;
    for (const s of plan.slides) expect(pcs.some((p) => p.outStart < s.outEnd - 1e-6 && p.outEnd > s.outStart + 1e-6)).toBe(false);
    const p6 = pcs.find((p) => p.srcStart <= 6000 && p.srcEnd > 6000)!;
    expect(p6.outStart + (6000 - p6.srcStart)).toBeCloseTo(9000, 6);
    // the frame showing source 6000 is output frame 270 (9 s)
    expect(plan.frames[270]!.src).toBeCloseTo(6000, 1);
  });
});

describe("plan + validation", () => {
  it("annotations appear on their frames with ops and are validated", () => {
    const project = resolveProject({ output: { fps: 30, resolution: 720 }, annotations: [
      { id: "a", kind: "arrow", startMs: 1000, endMs: 3000, from: { x: 100, y: 100 }, to: { x: 400, y: 300 } },
      { id: "t", kind: "text", role: "title", anchor: "frame", startMs: 0, endMs: 2000, rect: { x: 0.1, y: 0.1, w: 0.8, h: 0 }, text: "Welcome" },
    ] });
    const plan = buildRenderPlan({ meta: META, events: demoSession(), project });
    expect(plan.frames[0]!.annotations).toEqual([]); // fade-in starts at opacity 0
    expect(plan.frames[3]!.annotations.map((a) => a.id)).toEqual(["t"]);
    expect(plan.frames[45]!.annotations.map((a) => a.id)).toEqual(["a", "t"]);
    expect(plan.frames[75]!.annotations.map((a) => a.id)).toEqual(["a"]);
    expect(() => resolveProject({ annotations: [{ id: "x", kind: "arrow", startMs: 0, endMs: 100 }] })).toThrow(ProjectValidationError);
    expect(() => resolveProject({ annotations: [{ id: "x", kind: "blob", startMs: 0, endMs: 100 }] })).toThrow(/unknown kind/);
    expect(() => resolveProject({ annotations: [{ id: "x", kind: "rect", startMs: 0, endMs: 100, rect: { x: 0, y: 0, w: 10, h: 10 }, style: { color: "red" } }] })).toThrow(/#rrggbb/);
    expect(() => resolveProject({ slides: [{ id: "s", atMs: 0, durationMs: 0 }] })).toThrow(/durationMs/);
  });
});
