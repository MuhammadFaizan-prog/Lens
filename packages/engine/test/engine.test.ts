import { describe, expect, it } from "vitest";
import {
  buildCameraTrack,
  buildCursorTrack,
  buildRenderPlan,
  buildTimeline,
  captionBlocks,
  cleanupCuts,
  criticalDamping,
  cutsForDeletedWords,
  dampingRatio,
  defaultProject,
  detectTyping,
  layoutAt,
  layoutFor,
  OneEuroFilter,
  outputDuration,
  outputSize,
  outputToSource,
  overlayAvoidRect,
  parseEventLog,
  parseSrt,
  planAutoZoom,
  resolveProject,
  ProjectValidationError,
  sampleSpring,
  shortcutOverlays,
  sourceToOutput,
  springFromSettle,
  stepSpring,
  toSrt,
  avoidOverlay,
  type Word,
} from "../src/index.js";
import { META, demoSession, move, click } from "./fixtures.js";

describe("spring", () => {
  it("critically damped spring settles without overshoot", () => {
    const p = { stiffness: 200, damping: criticalDamping(200), mass: 1 };
    const s = sampleSpring((t) => (t >= 0 ? 1 : 0), 120, 60, p, { x: 0, v: 0 });
    const xs = s.map((v) => v.x);
    expect(Math.max(...xs)).toBeLessThanOrEqual(1 + 1e-9);
    expect(xs[xs.length - 1]).toBeGreaterThan(0.999);
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThanOrEqual(xs[i - 1]! - 1e-12);
  });

  it("underdamped spring overshoots, overdamped does not", () => {
    const under = sampleSpring(() => 1, 90, 60, { stiffness: 300, damping: 8, mass: 1 }, { x: 0, v: 0 });
    const over = sampleSpring(() => 1, 90, 60, { stiffness: 300, damping: 80, mass: 1 }, { x: 0, v: 0 });
    expect(Math.max(...under.map((s) => s.x))).toBeGreaterThan(1.05);
    expect(Math.max(...over.map((s) => s.x))).toBeLessThanOrEqual(1);
  });

  it("is frame-rate independent (exact solution)", () => {
    const p = springFromSettle(500, 0.8);
    let a = { x: 0, v: 0 };
    for (let i = 0; i < 30; i++) a = stepSpring(a, 1, 1000 / 30, p);
    let b = { x: 0, v: 0 };
    for (let i = 0; i < 120; i++) b = stepSpring(b, 1, 1000 / 120, p);
    expect(a.x).toBeCloseTo(b.x, 9);
    expect(a.v).toBeCloseTo(b.v, 9);
  });

  it("springFromSettle hits the requested settle time and ratio", () => {
    const p = springFromSettle(800, 1);
    expect(dampingRatio(p)).toBeCloseTo(1, 6);
    const s = sampleSpring(() => 1, 120, 60, p, { x: 0, v: 0 });
    const settleIdx = s.findIndex((v) => Math.abs(1 - v.x) < 0.01);
    expect(Math.abs((settleIdx * 1000) / 60 - 800)).toBeLessThan(40);
  });
});

describe("one euro filter", () => {
  it("removes jitter at rest and tracks fast moves", () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 0.01, dCutoff: 1 });
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 4;
    const rest = Array.from({ length: 120 }, (_, i) => f.filter(100 + rnd(), i * 8));
    const variance = rest.slice(20).reduce((acc, v) => acc + (v - 100) ** 2, 0) / 100;
    expect(variance).toBeLessThan(0.5);
    f.reset();
    let last = 0;
    for (let i = 0; i < 60; i++) last = f.filter(i * 20, i * 8);
    expect(1180 - last).toBeLessThan(60);
  });
});

describe("events", () => {
  it("parses JSONL, skips comments, sorts by time", () => {
    const ev = parseEventLog(`# header\n{"t":20,"type":"move","x":1,"y":2}\n\n{"t":10,"type":"move","x":0,"y":0}`);
    expect(ev.map((e) => e.t)).toEqual([10, 20]);
    expect(() => parseEventLog("{bad")).toThrow(/line 1/);
  });

  it("detects typing but ignores shortcuts", () => {
    const ev = demoSession();
    const typing = detectTyping(ev);
    expect(typing).toHaveLength(1);
    expect(typing[0]!.startMs).toBe(1800);
    expect(shortcutOverlays(ev, 1200).map((s) => s.label)).toEqual(["⌘ S"]);
  });
});

describe("cursor", () => {
  const cfg = defaultProject().cursor;

  it("smooths jitter and still reaches click targets", () => {
    const ev = [...move([100, 100], [900, 500], 0, 500, 4), ...click(900, 500, 900)];
    const track = buildCursorTrack(ev, { ...META, durationMs: 2000 }, cfg, 60);
    const atClick = track[Math.round(0.9 * 60)]!;
    expect(Math.hypot(atClick.x - 900, atClick.y - 500)).toBeLessThan(6);
    // Smoothed path has much lower frame-to-frame acceleration than the jittery raw path.
    const acc = (xs: number[]) => xs.slice(2).reduce((a, x, i) => a + Math.abs(x - 2 * xs[i + 1]! + xs[i]!), 0);
    const raw = track.map((s) => s.x);
    expect(acc(raw)).toBeLessThan(2000);
  });

  it("fades out when idle and back in on movement", () => {
    const ev = [...move([0, 0], [10, 10], 0, 100), ...move([10, 10], [400, 400], 6000, 300)];
    const track = buildCursorTrack(ev, { ...META, durationMs: 7000 }, cfg, 60);
    expect(track[Math.round(1.0 * 60)]!.opacity).toBe(1);
    expect(track[Math.round(4.0 * 60)]!.opacity).toBe(0);
    expect(track[Math.round(6.5 * 60)]!.opacity).toBe(1);
  });

  it("loops back to the starting position", () => {
    const ev = move([200, 200], [1500, 800], 0, 800);
    const track = buildCursorTrack(ev, { ...META, durationMs: 3000 }, { ...cfg, loopToStart: true, hideWhenIdle: false }, 60);
    const last = track[track.length - 1]!;
    expect(Math.hypot(last.x - track[0]!.x, last.y - track[0]!.y)).toBeLessThan(1);
  });

  it("shrinks while pressed", () => {
    const ev = [...move([0, 0], [50, 50], 0, 100), { t: 500, type: "down" as const, x: 50, y: 50, button: "left" as const }, { t: 900, type: "up" as const, x: 50, y: 50, button: "left" as const }];
    const track = buildCursorTrack(ev, { ...META, durationMs: 1500 }, cfg, 60);
    expect(track[Math.round(0.75 * 60)]!.scale).toBeCloseTo(cfg.pressScale, 5);
    expect(track[Math.round(1.3 * 60)]!.scale).toBe(1);
  });
});

describe("auto zoom", () => {
  const cfg = defaultProject().zoom;

  it("zooms on activity with lead and hold, and splits far-apart actions", () => {
    const segs = planAutoZoom(demoSession(), META, cfg);
    expect(segs.length).toBe(2);
    expect(segs[0]!.startMs).toBe(900 - cfg.leadMs);
    expect(segs[0]!.scale).toBeGreaterThanOrEqual(cfg.minScale);
    expect(segs[0]!.scale).toBeLessThanOrEqual(cfg.defaultScale);
    expect(segs[1]!.startMs).toBe(6000 - cfg.leadMs);
    expect(segs[1]!.endMs).toBe(6000 + cfg.holdMs);
  });

  it("manual zooms suppress overlapping auto zooms", () => {
    const manual = { id: "m1", startMs: 500, endMs: 3000, scale: 3, focus: { x: 400, y: 300 }, style: "classic" as const, auto: false };
    const segs = planAutoZoom(demoSession(), META, { ...cfg, segments: [manual] });
    expect(segs.every((s) => s.startMs >= 3000 || s.endMs <= 500)).toBe(true);
  });

  it("reduces scale so a wide cluster stays in view", () => {
    const ev = [...click(300, 500, 1000), ...click(1200, 520, 1800)];
    const segs = planAutoZoom(ev, META, cfg);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.scale).toBeLessThan(cfg.defaultScale);
    expect(META.width / segs[0]!.scale).toBeGreaterThan(900);
  });
});

describe("camera", () => {
  const project = defaultProject();

  it("animates into the zoom, keeps viewport inside the screen, and returns home", () => {
    const ev = demoSession();
    const cursor = buildCursorTrack(ev, META, project.cursor, 60);
    const segs = planAutoZoom(ev, META, project.zoom);
    const cam = buildCameraTrack(cursor, segs, META, { spring: project.zoom.spring, followDeadzone: 0.5 });
    const at = (ms: number) => cam[Math.round((ms / 1000) * 60)]!;
    expect(at(0).scale).toBeCloseTo(1, 5);
    expect(at(2000).scale).toBeGreaterThan(1.5);
    expect(at(11900).scale).toBeLessThan(1.02);
    for (const c of cam) {
      const halfW = META.width / (2 * c.scale);
      const halfH = META.height / (2 * c.scale);
      expect(c.cx - halfW).toBeGreaterThanOrEqual(-1e-6);
      expect(c.cx + halfW).toBeLessThanOrEqual(META.width + 1e-6);
      expect(c.cy - halfH).toBeGreaterThanOrEqual(-1e-6);
      expect(c.cy + halfH).toBeLessThanOrEqual(META.height + 1e-6);
    }
  });

  it("smart framing moves the cursor out from under the webcam", () => {
    const avoid = { x: 0.7, y: 0.65, w: 0.28, h: 0.33 };
    const center = { x: 960, y: 540 };
    const scale = 2;
    const cursor = { x: 960 + 0.3 * 480, y: 540 + 0.3 * 270 }; // inside the overlay region
    const moved = avoidOverlay(center, cursor, scale, META, avoid);
    const vw = META.width / scale;
    const vh = META.height / scale;
    const u = (cursor.x - (moved.x - vw / 2)) / vw;
    const v = (cursor.y - (moved.y - vh / 2)) / vh;
    const inside = u > avoid.x && u < avoid.x + avoid.w && v > avoid.y && v < avoid.y + avoid.h;
    expect(inside).toBe(false);
  });
});

describe("timeline", () => {
  it("removes cuts and applies speed ranges", () => {
    const tl = buildTimeline(10000, [{ startMs: 2000, endMs: 3000 }], [{ startMs: 5000, endMs: 7000, rate: 4 }]);
    expect(outputDuration(tl)).toBeCloseTo(10000 - 1000 - 2000 + 500, 6);
    expect(outputToSource(tl, 1999)).toBeCloseTo(1999, 6);
    expect(outputToSource(tl, 2000)).toBeCloseTo(3000, 6);
    expect(sourceToOutput(tl, 2500)).toBeNull();
    expect(sourceToOutput(tl, 6000)).toBeCloseTo(4000 + 250, 6);
  });
});

describe("transcript", () => {
  const words: Word[] = [
    { text: "So", startMs: 0, endMs: 200 },
    { text: "um", startMs: 300, endMs: 600 },
    { text: "this", startMs: 700, endMs: 900 },
    { text: "is", startMs: 950, endMs: 1050 },
    { text: "Lens.", startMs: 1100, endMs: 1500 },
    { text: "Next", startMs: 4000, endMs: 4300 },
  ];

  it("cuts fillers and shortens long pauses", () => {
    const cuts = cleanupCuts(words, 5000);
    expect(cuts.some((c) => c.startMs >= 300 && c.endMs <= 600)).toBe(true);
    expect(cuts.some((c) => c.startMs >= 1500 && c.endMs <= 4000 && c.endMs - c.startMs > 2000)).toBe(true);
  });

  it("deleting words produces merged cuts", () => {
    const cuts = cutsForDeletedWords(words, [2, 3]);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.startMs).toBeCloseTo(650, 6);
    expect(cuts[0]!.endMs).toBeCloseTo(1075, 6);
  });

  it("builds caption blocks and round-trips SRT", () => {
    const blocks = captionBlocks(words, 7, 2800);
    expect(blocks[0]!.text).toBe("So um this is Lens.");
    const srt = toSrt(blocks);
    const back = parseSrt(srt);
    expect(back[1]!.startMs).toBe(4000);
    expect(back[0]!.text).toBe("So um this is Lens.");
  });
});

describe("layout", () => {
  const p = defaultProject();
  it("computes output sizes per aspect", () => {
    expect(outputSize("16:9", 1080)).toEqual({ width: 1920, height: 1080 });
    expect(outputSize("9:16", 1080)).toEqual({ width: 1080, height: 1920 });
    expect(outputSize("1:1", 1080)).toEqual({ width: 1080, height: 1080 });
  });

  it("keeps screen aspect in every layout and aspect ratio", () => {
    for (const aspect of ["16:9", "1:1", "9:16", "4:5"]) {
      const out = outputSize(aspect, 1080);
      for (const kind of ["screen-only", "camera-overlay", "split", "fullscreen-camera", "camera-cutout"] as const) {
        const l = layoutFor(kind, out, 16 / 9, p);
        expect(l.screen.w / l.screen.h).toBeCloseTo(16 / 9, 3);
        expect(l.screen.x).toBeGreaterThanOrEqual(0);
        expect(l.screen.x + l.screen.w).toBeLessThanOrEqual(out.width + 1e-6);
      }
    }
  });

  it("animates between layouts", () => {
    const cfg = { ...p, camera: { ...p.camera, enabled: true, layouts: [{ startMs: 1000, endMs: 5000, kind: "split" as const }] } };
    const out = outputSize("16:9", 1080);
    const before = layoutAt(900, cfg.camera.layouts, out, 16 / 9, cfg);
    const mid = layoutAt(1250, cfg.camera.layouts, out, 16 / 9, cfg);
    const after = layoutAt(2000, cfg.camera.layouts, out, 16 / 9, cfg);
    expect(before.kind).toBe("camera-overlay");
    expect(after.kind).toBe("split");
    expect(mid.screen.w).toBeLessThan(before.screen.w);
    expect(mid.screen.w).toBeGreaterThan(after.screen.w);
    expect(overlayAvoidRect(before)).not.toBeNull();
  });
});

describe("project", () => {
  it("merges partial config and rejects invalid values", () => {
    const p = resolveProject({ zoom: { defaultScale: 2.5 } });
    expect(p.zoom.defaultScale).toBe(2.5);
    expect(p.zoom.minScale).toBe(1.25);
    expect(() => resolveProject({ output: { aspect: "wide" } })).toThrow(ProjectValidationError);
  });
});

describe("render plan", () => {
  it("builds a deterministic plan with every overlay wired", () => {
    const project = resolveProject({ output: { fps: 30 }, edits: { speedUpTyping: { enabled: true, rate: 3 } } });
    const plan = buildRenderPlan({ meta: META, events: demoSession(), project });
    const again = buildRenderPlan({ meta: META, events: demoSession(), project });
    expect(JSON.stringify(plan)).toBe(JSON.stringify(again));
    expect(plan.output.durationMs).toBeLessThan(META.durationMs); // typing sped up
    expect(plan.frames.some((f) => f.clicks.length > 0)).toBe(true);
    expect(plan.frames.some((f) => f.shortcut === "⌘ S")).toBe(true);
    expect(plan.frames.some((f) => f.cam[2] > 1.5)).toBe(true);
    expect(plan.frames.some((f) => f.cur === null)).toBe(true); // idle fade at the end
  });
});
