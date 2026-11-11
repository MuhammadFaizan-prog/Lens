/**
 * Several export sizes from one project (demand #15, docs/MultiAspect.md): targets, switching, the
 * project each target exports, crop keyframes, and old projects planning exactly as before.
 *
 * Bounds (set before the first run): canvas sizes exact at 360p (640x360, 360x640, 360x360, 360x450);
 * a keyed window maps edge to edge onto the canvas at each key time (corners within 0.5 output px, no
 * zoom); between keys the window centre moves monotonically; framingKeys absent / empty and an
 * exportTargets block on the active target leave the plan identical (deep equal) to the plan without.
 */
import { describe, expect, it } from "vitest";
import {
  buildRenderPlan,
  customWindow,
  disableTargets,
  enableTargets,
  enabledTargets,
  framingKeyRect,
  projectForTarget,
  removeFramingKey,
  resolveProject,
  setFramingKey,
  switchTarget,
  updateTarget,
  windowScreenRect,
  type ProjectConfig,
  type Rect,
} from "../src/index.js";
import { demoSession, META } from "./fixtures.js";

const planOf = (p: ProjectConfig) => buildRenderPlan({ meta: META, events: demoSession(), project: p });
const base = (patch: Record<string, unknown> = {}) => resolveProject({ output: { aspect: "16:9", resolution: 360, fps: 30 }, ...patch });

/** Output px of source point (x, y) on plan frame f (screen rect through the camera). */
function srcToOut(plan: ReturnType<typeof planOf>, i: number, x: number, y: number) {
  const f = plan.frames[i]!;
  const [cropX, cropY, srcW, srcH] = plan.source.crop as [number, number, number, number];
  const [cx, cy, sc] = f.cam;
  const [lx, ly, lw, lh] = f.layout.screen;
  const vw = srcW / sc, vh = srcH / sc;
  return { x: lx + (x - cropX - (cx - vw / 2)) * (lw / vw), y: ly + (y - cropY - (cy - vh / 2)) * (lh / vh) };
}

describe("export targets (demand #15)", () => {
  it("one target per shape, exact canvas sizes, active = the current aspect", () => {
    const p = enableTargets(base());
    expect(p.exportTargets!.items.map((t) => t.aspect)).toEqual(["16:9", "9:16", "1:1", "4:5"]);
    expect(p.exportTargets!.active).toBe("t16x9");
    const sizes = enabledTargets(p).map((t) => planOf(projectForTarget(p, t.id)).output).map((o) => `${o.width}x${o.height}`);
    expect(sizes).toEqual(["640x360", "360x640", "360x360", "360x450"]);
    // non-source shapes start on Follow
    expect(p.exportTargets!.items.slice(1).every((t) => t.framing === "follow")).toBe(true);
    expect(() => resolveProject(p)).not.toThrow();
  });

  it("an aspect outside the four becomes an extra first target", () => {
    const p = enableTargets(base({ output: { aspect: "4:3", resolution: 360, fps: 30 } }));
    expect(p.exportTargets!.items.map((t) => t.aspect)).toEqual(["4:3", "16:9", "9:16", "1:1", "4:5"]);
    expect(p.exportTargets!.active).toBe(p.exportTargets!.items[0]!.id);
  });

  it("switching saves the shown target's framing and loads the other's; round trip is lossless", () => {
    let p = enableTargets(base());
    p = updateTarget(p, "t9x16", { framing: "custom", framingRect: { x: 700, y: 0, w: 400, h: 711 } });
    p = switchTarget(p, "t1x1");
    expect(p.output.aspect).toBe("1:1");
    expect(p.output.framing).toBe("follow");
    expect(p.output.fit).toBe("fill");
    p = { ...p, output: { ...p.output, framing: "fill", fit: "fit" } }; // edited while shown
    p = switchTarget(p, "t9x16");
    expect(p.output).toMatchObject({ aspect: "9:16", framing: "custom", framingRect: { x: 700, y: 0, w: 400, h: 711 } });
    expect(p.exportTargets!.items.find((t) => t.id === "t1x1")!.framing).toBe("fill");
    p = switchTarget(p, "t16x9");
    expect(p.output).toMatchObject({ aspect: "16:9", framing: "fit" });
    expect(disableTargets(p).exportTargets).toBeUndefined();
  });

  it("disabled targets are left out of the batch", () => {
    const p = updateTarget(enableTargets(base()), "t4x5", { enabled: false });
    expect(enabledTargets(p).map((t) => t.aspect)).toEqual(["16:9", "9:16", "1:1"]);
  });

  it("old projects: no targets / no keys / the active target plan exactly as before", () => {
    const p0 = base({ output: { aspect: "9:16", resolution: 360, fps: 30, framing: "custom", framingRect: { x: 500, y: 100, w: 300, h: 533 } } });
    const ref = JSON.stringify(planOf(p0));
    expect(JSON.stringify(planOf({ ...p0, output: { ...p0.output, framingKeys: [] } }))).toBe(ref);
    const withTargets = enableTargets(p0);
    expect(JSON.stringify(planOf(withTargets))).toBe(ref);
    expect(JSON.stringify(planOf(projectForTarget(withTargets, withTargets.exportTargets!.active)))).toBe(ref);
    const follow = base({ output: { aspect: "9:16", resolution: 360, fps: 30, fit: "fill" } });
    expect(JSON.stringify(planOf(enableTargets(follow)))).toBe(JSON.stringify(planOf(follow)));
  });
});

describe("crop keyframes (demand #15)", () => {
  const A: Rect = { x: 100, y: 300, w: 400, h: 400 };
  const B: Rect = { x: 1300, y: 100, w: 600, h: 600 };

  it("hold before / after, smoothstep between", () => {
    const keys = [{ srcMs: 1000, rect: A }, { srcMs: 3000, rect: B }];
    expect(framingKeyRect(keys, 0)).toEqual(A);
    expect(framingKeyRect(keys, 5000)).toEqual(B);
    const m = framingKeyRect(keys, 2000)!;
    expect(m.x).toBeCloseTo((A.x + B.x) / 2, 6);
    expect(m.w).toBeCloseTo((A.w + B.w) / 2, 6);
    expect(framingKeyRect([], 10)).toBeNull();
  });

  it("each key's window fills the canvas edge to edge; between keys the window glides", () => {
    // no zoom: the auto-zoom would magnify inside the window
    let p = base({ output: { aspect: "1:1", resolution: 360, fps: 30 }, zoom: { auto: false, segments: [] } });
    p = setFramingKey(p, 500, A);
    p = setFramingKey(p, 3000, B);
    expect(p.output.framing).toBe("custom");
    expect(() => resolveProject(p)).not.toThrow();
    const plan = planOf(p);
    expect(plan.style.radius).toBe(0);
    for (const [ms, r] of [[500, A], [3000, B]] as const) {
      const i = plan.frames.findIndex((f) => Math.abs(f.src - ms) < 1);
      expect(i).toBeGreaterThanOrEqual(0);
      const w = customWindow({ x: 0, y: 0, w: META.width, h: META.height }, 1, r);
      const tl = srcToOut(plan, i, w.x, w.y);
      const br = srcToOut(plan, i, w.x + w.w, w.y + w.h);
      expect(Math.abs(tl.x)).toBeLessThan(0.5);
      expect(Math.abs(tl.y)).toBeLessThan(0.5);
      expect(Math.abs(br.x - 360)).toBeLessThan(0.5);
      expect(Math.abs(br.y - 360)).toBeLessThan(0.5);
    }
    // the window centre (source x) shown at the canvas centre moves right monotonically 0.5 s -> 3 s
    let last = -Infinity;
    for (const f of plan.frames.filter((f) => f.src >= 500 && f.src <= 3000)) {
      const [lx, , lw] = f.layout.screen;
      const srcX = ((180 - lx) / lw) * META.width;
      expect(srcX).toBeGreaterThanOrEqual(last - 1e-6);
      last = srcX;
    }
    // every frame covers the canvas
    for (const f of plan.frames) {
      const [x, y, w, h] = f.layout.screen;
      expect(x).toBeLessThanOrEqual(1e-6);
      expect(y).toBeLessThanOrEqual(1e-6);
      expect(x + w).toBeGreaterThanOrEqual(360 - 1e-6);
      expect(y + h).toBeGreaterThanOrEqual(360 - 1e-6);
    }
    expect(removeFramingKey(removeFramingKey(p, 500), 3000).output.framingKeys).toBeUndefined();
  });

  it("windowScreenRect: a zoom magnifies about the window centre, clamped to the source", () => {
    const out = { width: 360, height: 360 };
    const src = { width: 1920, height: 1080 };
    const win = { x: 800, y: 300, w: 400, h: 400 };
    const s1 = windowScreenRect(out, src, win, { x0: 0, vw: 1920, y0: 0, vh: 1080 });
    expect(s1).toEqual({ x: -720, y: -270, w: 1728, h: 972 });
    // camera 2x about the window centre: the centre stays put
    const s2 = windowScreenRect(out, src, win, { x0: 520, vw: 960, y0: 230, vh: 540 });
    expect(s2.x + ((1000 - 520) / 960) * s2.w).toBeCloseTo(180, 6);
  });

  it("validation", () => {
    expect(() => resolveProject(({ output: { aspect: "1:1", resolution: 360, fps: 30, framing: "custom", framingKeys: [{ srcMs: -1, rect: A }] } }))).toThrow(/framingKeys/);
    const p = enableTargets(base());
    expect(() => resolveProject({ ...p, exportTargets: { ...p.exportTargets!, active: "nope" } })).toThrow(/active/);
    expect(() => resolveProject({ ...p, exportTargets: { active: "a", items: [{ id: "a", aspect: "wide", framing: "fit", enabled: true }] } })).toThrow(/exportTargets/);
  });
});
