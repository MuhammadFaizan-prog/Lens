import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRenderPlan, defaultProject, type InputEvent, type Motion3DSegment, type RecordingMeta, type RenderPlan } from "@lens/engine";
import { applyH, homographyRectToQuad, invert3, type Mat3 } from "../src/render/gl3d";

// Spy on the GL pass: the renderer must only construct it for frames that carry m3d.
const { glCtor, glRender } = vi.hoisted(() => ({ glCtor: vi.fn(), glRender: vi.fn() }));
vi.mock("../src/render/gl3d", async (orig) => {
  const real = await orig<typeof import("../src/render/gl3d")>();
  class Gl3dPass {
    constructor() {
      glCtor();
    }
    render(...args: unknown[]) {
      glRender(...args);
      return { width: 1, height: 1 };
    }
  }
  return { ...real, Gl3dPass };
});

const close = (a: [number, number], b: [number, number]) => {
  expect(a[0]).toBeCloseTo(b[0], 9);
  expect(a[1]).toBeCloseTo(b[1], 9);
};

describe("homographyRectToQuad", () => {
  it("maps rect corners onto a translated quad (affine case) and the centre onto its centre", () => {
    // 100x50 rect moved by (10, 20): corners and centre worked out by hand
    const H = homographyRectToQuad(100, 50, [10, 20, 110, 20, 110, 70, 10, 70]);
    close(applyH(H, 0, 0), [10, 20]);
    close(applyH(H, 100, 0), [110, 20]);
    close(applyH(H, 100, 50), [110, 70]);
    close(applyH(H, 0, 50), [10, 70]);
    close(applyH(H, 50, 25), [60, 45]);
    expect(H[6]).toBeCloseTo(0, 12);
    expect(H[7]).toBeCloseTo(0, 12);
  });

  it("maps rect corners onto a trapezoid (projective case); the centre lands on the diagonal intersection", () => {
    // TL(0,0) TR(100,0) BR(80,50) BL(20,50). Diagonals (0,0)-(80,50) and (100,0)-(20,50) meet at
    // t = 0.625: (50, 31.25). A projective map sends the rect centre (diagonal crossing) there.
    const q = [0, 0, 100, 0, 80, 50, 20, 50];
    const H = homographyRectToQuad(200, 100, q);
    close(applyH(H, 0, 0), [0, 0]);
    close(applyH(H, 200, 0), [100, 0]);
    close(applyH(H, 200, 100), [80, 50]);
    close(applyH(H, 0, 100), [20, 50]);
    close(applyH(H, 100, 50), [50, 31.25]);
    expect(Math.abs(H[6]) + Math.abs(H[7])).toBeGreaterThan(1e-6);
  });

  it("maps a general (rotated, foreshortened) quad's corners exactly", () => {
    const q = [312.5, 140.25, 1601.75, 98.5, 1655, 990.125, 270, 1012];
    const H = homographyRectToQuad(1440, 810, q);
    const corners: Array<[number, number]> = [[0, 0], [1440, 0], [1440, 810], [0, 810]];
    corners.forEach(([u, v], i) => {
      const [x, y] = applyH(H, u, v);
      expect(x).toBeCloseTo(q[2 * i]!, 6);
      expect(y).toBeCloseTo(q[2 * i + 1]!, 6);
    });
  });
});

describe("invert3", () => {
  const mul = (a: Mat3, b: Mat3): number[] => {
    const r: number[] = [];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r.push(a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!);
    return r;
  };

  it("H * inv(H) = I and points round-trip through H then inv(H)", () => {
    const H = homographyRectToQuad(1440, 810, [312.5, 140.25, 1601.75, 98.5, 1655, 990.125, 270, 1012]);
    const inv = invert3(H);
    const I = mul(H, inv);
    const s = I[8]!;
    [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, k) => expect(I[k]! / s).toBeCloseTo(v, 9));
    for (const [u, v] of [[0, 0], [720, 405], [1440, 810], [13.5, 777]] as Array<[number, number]>) {
      const [x, y] = applyH(H, u, v);
      close(applyH(inv, x, y), [u, v]);
    }
  });

  it("inverts a hand-checked matrix exactly and rejects a singular one", () => {
    // diag(2, 4, 1) with translation (6, 8): inverse is diag(1/2, 1/4, 1) with translation (-3, -2)
    const inv = invert3([2, 0, 6, 0, 4, 8, 0, 0, 1]);
    [0.5, 0, -3, 0, 0.25, -2, 0, 0, 1].forEach((v, k) => expect(inv[k]).toBeCloseTo(v, 12));
    expect(() => invert3([1, 2, 3, 2, 4, 6, 0, 0, 1])).toThrow(/degenerate/);
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

const META: RecordingMeta = { width: 1920, height: 1080, fps: 60, durationMs: 4000, pixelRatio: 1 };
const EVENTS: InputEvent[] = [
  { t: 0, type: "move", x: 400, y: 300 },
  { t: 800, type: "move", x: 900, y: 500 },
  { t: 1200, type: "down", x: 900, y: 500, button: "left" },
  { t: 1290, type: "up", x: 900, y: 500, button: "left" },
  { t: 2500, type: "move", x: 1300, y: 700 },
];

describe("renderer 3D hook", () => {
  beforeEach(() => {
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    glCtor.mockClear();
    glRender.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  const seg = (o: Partial<Motion3DSegment>): Motion3DSegment => ({ id: "m", startMs: 1000, endMs: 3000, template: "custom", from: {}, to: {}, easing: "linear", perspective: 2000, ...o });
  const planWith = (motion3d: Motion3DSegment[]): RenderPlan => {
    const p = defaultProject();
    return buildRenderPlan({ meta: META, events: EVENTS, project: { ...p, motion3d, output: { ...p.output, fps: 30 } }, onlyFrames: [60] });
  };
  const drawAll = async (plan: RenderPlan) => {
    const { PlanRenderer } = await import("../src/render/renderer");
    const r = new PlanRenderer();
    const g = fakeCtx() as OffscreenCanvasRenderingContext2D;
    for (let i = 0; i < plan.frames.length; i++) r.draw(g, plan, i, { screen: null });
  };

  it("an identity pose emits no m3d and never constructs the WebGL pass", async () => {
    const plan = planWith([seg({ from: {}, to: {} })]);
    expect(plan.frames.length).toBeGreaterThan(0);
    expect(plan.frames.every((f) => !f.m3d)).toBe(true);
    await drawAll(plan);
    expect(glCtor).not.toHaveBeenCalled();
    expect(glRender).not.toHaveBeenCalled();
  });

  it("no motion3d segments at all: no GL either", async () => {
    await drawAll(planWith([]));
    expect(glCtor).not.toHaveBeenCalled();
  });

  it("control: a tilted pose does go through the WebGL pass", async () => {
    const plan = planWith([seg({ from: { ry: 20 }, to: { ry: 20 } })]);
    expect(plan.frames.some((f) => f.m3d)).toBe(true);
    await drawAll(plan);
    expect(glCtor).toHaveBeenCalledTimes(1);
    expect(glRender).toHaveBeenCalled();
  });
});
