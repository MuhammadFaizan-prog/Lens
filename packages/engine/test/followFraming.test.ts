/**
 * Follow keeps the cursor and a fixed zoom target in frame (demand #15, docs/MultiAspect.md).
 * Bounds (set before the first run):
 *  - a Follow frame that already holds the cursor (and target) returns the old fillScreenRect result
 *    itself and no camera override;
 *  - cursor and target close enough for the Fill window: both inside the canvas with >= the margin,
 *    the screen still covers the canvas (no background);
 *  - too far apart for the Fill window: the window widens; both inside with the margin;
 *  - a sweep of the target weight 0 -> 1 moves what the canvas shows continuously: fixed source points
 *    (cursor, target) move <= 1 % of the canvas per 0.1 % step of the weight (no jump;
 *    first written as 2 % per 1 % step with the recording corners as probes too: the off-canvas corners
 *    of a fast but continuous zoom-out moved 9.8 px per step there, 3.7 px per 0.1 % step);
 *  - plan level (the multi-aspect e2e scene: 1280x720, cursor moving right from (200, 200), fixed 1.6x
 *    zoom on (900, 250) 0.6-1.5 s, 360p30, first 2 s): on 9:16 and 4:5 Follow the cursor is inside the
 *    canvas on every frame and the target inside (>= 3 % from each edge) on every frame 1.15-1.45 s.
 */
import { describe, expect, it } from "vitest";
import { buildRenderPlan, fillScreenRect, followFrame, followTargetAt, FOLLOW_MARGIN, resolveProject } from "../src/index.js";
import type { InputEvent } from "../src/types.js";

const SRC = { width: 1280, height: 720 };
const SA = 1280 / 720;
const OUT = { width: 360, height: 640 };
const view = (scale: number, cx: number, cy: number) => ({ x0: cx - 640 / scale, vw: 1280 / scale, y0: cy - 360 / scale, vh: 720 / scale });
const toOut = (r: { x: number; y: number; w: number; h: number }, v: { x0: number; vw: number; y0: number; vh: number }, p: { x: number; y: number }) => ({
  x: r.x + (p.x - v.x0) * (r.w / v.vw),
  y: r.y + (p.y - v.y0) * (r.h / v.vh),
});

describe("followFrame", () => {
  it("a frame that already holds the cursor is the old fill frame, no camera override", () => {
    const v = view(1, 640, 360);
    const old = fillScreenRect(OUT, SA, v, { x: 640, y: 360 });
    const f = followFrame(OUT, SRC, v, { x: 640, y: 360 }, { x: 650, y: 380 }, null, () => old);
    expect(f.screen).toBe(old);
    expect(f.cam).toBeNull();
  });

  it("close enough: both in frame with the margin, canvas still covered", () => {
    const v = view(1.6, 880, 300);
    const cursor = { x: 700, y: 300 }, target = { x: 900, y: 250, w: 1 };
    const f = followFrame(OUT, SRC, v, { x: 900, y: 250 }, cursor, target, () => fillScreenRect(OUT, SA, v, { x: 900, y: 250 }));
    const vv = f.cam ? view(f.cam.scale, f.cam.cx, f.cam.cy) : v;
    for (const p of [cursor, target]) {
      const o = toOut(f.screen, vv, p);
      expect(o.x).toBeGreaterThanOrEqual(OUT.width * FOLLOW_MARGIN - 0.5);
      expect(o.x).toBeLessThanOrEqual(OUT.width * (1 - FOLLOW_MARGIN) + 0.5);
    }
    expect(f.screen.x).toBeLessThanOrEqual(0.01);
    expect(f.screen.x + f.screen.w).toBeGreaterThanOrEqual(OUT.width - 0.01);
    expect(f.screen.y).toBeLessThanOrEqual(0.01);
    expect(f.screen.y + f.screen.h).toBeGreaterThanOrEqual(OUT.height - 0.01);
  });

  it("too far apart: the window widens and holds both", () => {
    const v = view(1.6, 880, 300);
    const cursor = { x: 300, y: 260 }, target = { x: 900, y: 250, w: 1 };
    const f = followFrame(OUT, SRC, v, { x: 900, y: 250 }, cursor, target, () => fillScreenRect(OUT, SA, v, { x: 900, y: 250 }));
    expect(f.cam).not.toBeNull();
    const vv = view(f.cam!.scale, f.cam!.cx, f.cam!.cy);
    for (const p of [cursor, target]) {
      const o = toOut(f.screen, vv, p);
      expect(o.x).toBeGreaterThanOrEqual(OUT.width * FOLLOW_MARGIN - 0.5);
      expect(o.x).toBeLessThanOrEqual(OUT.width * (1 - FOLLOW_MARGIN) + 0.5);
      expect(o.y).toBeGreaterThanOrEqual(0);
      expect(o.y).toBeLessThanOrEqual(OUT.height);
    }
  });

  it("continuous in the target weight (what the canvas shows: output positions of fixed source points)", () => {
    const v = view(1.6, 880, 300);
    const cursor = { x: 300, y: 260 };
    const probes = [cursor, { x: 900, y: 250 }];
    let prev: Array<{ x: number; y: number }> | null = null;
    for (let i = 0; i <= 1000; i++) {
      const f = followFrame(OUT, SRC, v, { x: 900, y: 250 }, cursor, { x: 900, y: 250, w: i / 1000 }, () => fillScreenRect(OUT, SA, v, { x: 900, y: 250 }));
      const vv = f.cam ? view(f.cam.scale, f.cam.cx, f.cam.cy) : v;
      const now = probes.map((p) => toOut(f.screen, vv, p));
      if (prev) for (let j = 0; j < now.length; j++) {
        expect(Math.abs(now[j]!.x - prev[j]!.x)).toBeLessThanOrEqual(0.01 * OUT.width);
        expect(Math.abs(now[j]!.y - prev[j]!.y)).toBeLessThanOrEqual(0.01 * OUT.height);
      }
      prev = now;
    }
  });

  it("followTargetAt: fixed zooms only, weighted with the camera, fading after the zoom", () => {
    const segs = [{ startMs: 600, endMs: 1500, scale: 1.6, focus: { x: 900, y: 250 } }, { startMs: 3000, endMs: 3500, scale: 2, focus: "follow" as const }];
    expect(followTargetAt(segs, 300, 1)).toBeNull();
    expect(followTargetAt(segs, 700, 1.15)!.w).toBeCloseTo(0.5, 5);
    expect(followTargetAt(segs, 1200, 1.6)!.w).toBe(1);
    expect(followTargetAt(segs, 1600, 1.1)!.w).toBeCloseTo(1 / 3, 5);
    expect(followTargetAt(segs, 2500, 1)).toBeNull();
    expect(followTargetAt(segs, 3200, 1.8)).toBeNull();
  });
});

describe("Follow in the plan: cursor and zoom target in frame (the multi-aspect e2e scene)", () => {
  const events: InputEvent[] = [];
  for (let t = 0; t <= 6000; t += 100) events.push({ t, type: "move", x: 200 + 0.12 * t, y: 200 + 0.1 * t } as InputEvent);
  const meta = { width: 1280, height: 720, fps: 30, durationMs: 6000, pixelRatio: 1 };
  const project = (aspect: string, framing: string) => resolveProject({
    output: { aspect, resolution: 360, fps: 30, framing, fit: framing === "follow" ? "fill" : "fit" },
    cursor: { visible: true, clickEffect: "none" },
    edits: { cuts: [{ startMs: 2000, endMs: 6000 }] },
    zoom: { auto: false, segments: [{ id: "zm", startMs: 600, endMs: 1500, scale: 1.6, focus: { x: 900, y: 250 }, style: "classic", auto: false }] },
  });
  const map = (plan: any, f: any, x: number, y: number) => {
    const [cropX, cropY, srcW, srcH] = plan.source.crop;
    const [cx, cy, sc] = f.cam;
    const [lx, ly, lw, lh] = f.layout.screen;
    const vw = srcW / sc, vh = srcH / sc;
    return { x: lx + (x - cropX - (cx - vw / 2)) * (lw / vw), y: ly + (y - cropY - (cy - vh / 2)) * (lh / vh) };
  };
  for (const aspect of ["9:16", "4:5"]) {
    it(`${aspect} Follow: cursor in frame on every frame, target in frame through the zoom's hold`, () => {
      const plan = buildRenderPlan({ meta, events, project: project(aspect, "follow") }) as any;
      const W = plan.output.width, H = plan.output.height;
      let out = 0, tout = 0;
      for (const f of plan.frames) {
        const c = map(plan, f, f.cur[0], f.cur[1]);
        if (c.x < 0 || c.y < 0 || c.x > W || c.y > H) out++;
        const z = map(plan, f, 900, 250);
        if (f.src >= 1150 && f.src <= 1450 && !(z.x >= 0.03 * W && z.x <= 0.97 * W && z.y >= 0.03 * H && z.y <= 0.97 * H)) tout++;
      }
      expect(out).toBe(0);
      expect(tout).toBe(0);
    });
  }
});
