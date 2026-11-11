import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRenderPlan, defaultProject, type InputEvent, type ProjectConfig, type RecordingMeta, type RenderPlan } from "@lens/engine";
import { lanczos3, sharpenAmountAt, SHARPEN_FULL_SCALE, SHARPEN_MIN_SCALE } from "../src/render/sharpen";

// demand #22: spy on the WebGL sharpen pass (node has no WebGL); the renderer must only build it for
// zoomed frames of a plan that carries style.zoomSharpen.
const { ctor, resample, unsharp } = vi.hoisted(() => ({ ctor: vi.fn(), resample: vi.fn(), unsharp: vi.fn() }));
vi.mock("../src/render/sharpen", async (orig) => {
  const real = await orig<typeof import("../src/render/sharpen")>();
  class SharpenPass {
    constructor() {
      ctor();
    }
    resample(...a: unknown[]) {
      resample(...a);
      return { width: 1, height: 1 };
    }
    unsharp(...a: unknown[]) {
      unsharp(...a);
      return { width: 1, height: 1 };
    }
  }
  return { ...real, SharpenPass };
});

describe("sharpenAmountAt (zoom ramp)", () => {
  it("is 0 up to 1.5x, the full amount from 1.75x, smoothstep between", () => {
    expect(SHARPEN_MIN_SCALE).toBe(1.5);
    expect(SHARPEN_FULL_SCALE).toBe(1.75);
    for (const s of [1, 1.2, 1.5]) expect(sharpenAmountAt(0.6, s)).toBe(0);
    for (const s of [1.75, 2, 2.5, 4]) expect(sharpenAmountAt(0.6, s)).toBeCloseTo(0.6, 12);
    expect(sharpenAmountAt(0.6, 1.625)).toBeCloseTo(0.3, 12); // smoothstep(0.5) = 0.5
    let prev = -1;
    for (let s = 1.4; s <= 1.9; s += 0.01) {
      const v = sharpenAmountAt(1, s);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(sharpenAmountAt(0, 3)).toBe(0);
  });
});

describe("lanczos3", () => {
  it("is 1 at 0, 0 at the other integers and outside +-3, symmetric", () => {
    expect(lanczos3(0)).toBe(1);
    for (const k of [1, 2, -1, -2]) expect(Math.abs(lanczos3(k))).toBeLessThan(1e-12);
    for (const k of [3, -3, 3.5, 10]) expect(lanczos3(k)).toBe(0);
    for (const x of [0.25, 0.5, 1.3, 2.7]) expect(lanczos3(x)).toBeCloseTo(lanczos3(-x), 14);
  });
  it("its 6 taps at any phase sum to ~1 (the shader normalises the remainder)", () => {
    for (let t = 0; t < 1; t += 0.05) {
      let s = 0;
      for (let k = -2; k <= 3; k++) s += lanczos3(t - k);
      expect(Math.abs(s - 1)).toBeLessThan(0.03);
    }
  });
});

const META: RecordingMeta = { width: 1920, height: 1080, fps: 30, durationMs: 4000, pixelRatio: 1 };
const EVENTS: InputEvent[] = [{ t: 0, type: "move", x: 400, y: 300 }];

describe("renderer zoom-sharpen hook", () => {
  beforeEach(() => {
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    ctor.mockClear();
    resample.mockClear();
    unsharp.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  /** One fixed 2.5x zoom 1..3 s (output 30 fps), no motion blur unless asked. */
  const plan = (sharpen?: ProjectConfig["zoom"]["sharpen"], motionBlur = false): RenderPlan => {
    const p = defaultProject();
    const zoom = { ...p.zoom, auto: false, segments: [{ id: "z", startMs: 1000, endMs: 3000, scale: 2.5, focus: { x: 960, y: 540 }, style: "classic" as const, auto: false }], ...(sharpen ? { sharpen } : {}) };
    return buildRenderPlan({ meta: META, events: EVENTS, project: { ...p, zoom, motionBlur: { ...p.motionBlur, enabled: motionBlur }, output: { ...p.output, fps: 30 } } });
  };
  const draw = async (pl: RenderPlan, frames: number[]) => {
    const { PlanRenderer } = await import("../src/render/renderer");
    const r = new PlanRenderer();
    const g = fakeCtx() as OffscreenCanvasRenderingContext2D;
    const img = { width: 1920, height: 1080 } as unknown as CanvasImageSource;
    for (const i of frames) r.draw(g, pl, i, { screen: img });
  };

  it("a project without zoom.sharpen (every project before #22) never builds the pass", async () => {
    const pl = plan();
    expect("zoomSharpen" in pl.style).toBe(false);
    expect(pl.frames[60]!.cam[2]).toBeGreaterThan(2.4);
    await draw(pl, [0, 30, 60, 90]);
    expect(ctor).not.toHaveBeenCalled();
  });

  it("turned off (enabled false or amount 0): no pass either", async () => {
    await draw(plan({ enabled: false, amount: 0.6 }), [60]);
    await draw(plan({ enabled: true, amount: 0 }), [60]);
    expect(ctor).not.toHaveBeenCalled();
  });

  it("on: unzoomed frames are drawn as before, zoomed frames go through the Lanczos resample with the drawImage rect", async () => {
    const pl = plan({ enabled: true, amount: 0.6 });
    expect(pl.style.zoomSharpen).toEqual({ amount: 0.6 });
    await draw(pl, [0, 3]);
    expect(resample).not.toHaveBeenCalled();
    const f = pl.frames[60]!;
    expect(f.cam[2]).toBeGreaterThan(2.4);
    await draw(pl, [60]);
    expect(ctor).toHaveBeenCalledTimes(1);
    expect(resample).toHaveBeenCalledTimes(1);
    const [, ax, ay, w, h, sw, sh, amt] = resample.mock.calls[0]! as number[];
    const [cropX, cropY, srcW, srcH] = pl.source.crop;
    const [cx, cy, s] = f.cam;
    const { cardRect } = await import("../src/render/renderer");
    const [, , cw, ch] = cardRect(f);
    expect([sw, sh]).toEqual([cw, ch]);
    expect(w).toBeCloseTo(srcW / s, 9);
    expect(h).toBeCloseTo(srcH / s, 9);
    // the same source rect the bilinear drawImage uses (pixel-centre aligned like OpenCV)
    expect(ax).toBeCloseTo(cx - w / 2 + 0.5 - 0.5 / (sw / w) + cropX, 9);
    expect(ay).toBeCloseTo(cy - h / 2 + 0.5 - 0.5 / (sh / h) + cropY, 9);
    expect(amt).toBeCloseTo(sharpenAmountAt(0.6, s), 12);
  });

  it("while the camera moves fast enough for motion blur, the blurred view is only unsharp-masked", async () => {
    const pl = plan({ enabled: true, amount: 0.8 }, true);
    // frames where the zoom is past 1.5x and motion blur kicks in (the zoom-in ramp)
    const moving = pl.frames.map((f, i) => ({ f, i })).filter(({ f }) => f.cam[2] > 1.6 && Math.abs(f.camVel[2]) > 0.05).map(({ i }) => i);
    expect(moving.length).toBeGreaterThan(0);
    await draw(pl, moving);
    expect(unsharp).toHaveBeenCalled();
  });
});

/** A 2D context / canvas stand-in that accepts every call (node has no canvas). */
function fakeCtx(): unknown {
  const target = { canvas: null as unknown };
  const fn: ProxyHandler<object> = {
    get(t, k) {
      if (k in t) return (t as Record<string | symbol, unknown>)[k];
      if (k === "measureText") return () => ({ width: 0, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0 });
      if (k === "getImageData" || k === "createImageData") return (_x: number, _y: number, w = 1, h = 1) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)) });
      if (k === "createLinearGradient" || k === "createRadialGradient" || k === "createConicGradient" || k === "createPattern") return () => ({ addColorStop() {} });
      return () => undefined;
    },
    set(t, k, v) {
      (t as Record<string | symbol, unknown>)[k] = v;
      return true;
    },
  };
  return new Proxy(target, fn);
}

class FakeOffscreenCanvas {
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext(kind: string) {
    return kind === "2d" ? fakeCtx() : null;
  }
}
