import { describe, expect, it } from "vitest";
import { buildRenderPlan, defaultProject, resolveProject } from "../src/index.js";
import type { InputEvent, RecordingMeta } from "../src/types.js";

// demand #22: zoom.sharpen setting -> plan.style.zoomSharpen, absent unless on so older plans are byte-identical.
const META: RecordingMeta = { width: 1920, height: 1080, fps: 30, durationMs: 3000, pixelRatio: 1 };
const EVENTS: InputEvent[] = [{ t: 0, type: "move", x: 400, y: 300 }, { t: 1000, type: "down", x: 900, y: 500, button: "left" }, { t: 1080, type: "up", x: 900, y: 500, button: "left" }];
const planJson = (zoom: Record<string, unknown> = {}) => {
  const p = defaultProject();
  return JSON.stringify(buildRenderPlan({ meta: META, events: EVENTS, project: { ...p, zoom: { ...p.zoom, ...zoom } } }));
};

describe("zoom.sharpen project setting (demand #22)", () => {
  it("is not in the defaults, so existing and default projects carry no setting", () => {
    expect(defaultProject().zoom.sharpen).toBeUndefined();
    expect(resolveProject({ version: 1 }).zoom.sharpen).toBeUndefined();
  });

  it("off, absent or amount 0: the plan has no zoomSharpen and is byte-identical to a plan without the setting", () => {
    const base = planJson();
    expect(base.includes("zoomSharpen")).toBe(false);
    expect(planJson({ sharpen: { enabled: false, amount: 0.6 } })).toBe(base);
    expect(planJson({ sharpen: { enabled: true, amount: 0 } })).toBe(base);
  });

  it("on: plan.style.zoomSharpen carries the amount and nothing else in the plan changes", () => {
    const base = JSON.parse(planJson());
    const on = JSON.parse(planJson({ sharpen: { enabled: true, amount: 0.6 } }));
    expect(on.style.zoomSharpen).toEqual({ amount: 0.6 });
    delete on.style.zoomSharpen;
    expect(on).toEqual(base);
  });

  it("round-trips through resolveProject and validates its range", () => {
    expect(resolveProject({ version: 1, zoom: { sharpen: { enabled: true, amount: 0.6 } } }).zoom.sharpen).toEqual({ enabled: true, amount: 0.6 });
    expect(resolveProject({ version: 1, zoom: { sharpen: { enabled: false, amount: 1.5 } } }).zoom.sharpen).toEqual({ enabled: false, amount: 1.5 });
    expect(() => resolveProject({ version: 1, zoom: { sharpen: { enabled: true, amount: 2 } } })).toThrow(/zoom\.sharpen/);
    expect(() => resolveProject({ version: 1, zoom: { sharpen: { enabled: true, amount: -0.1 } } })).toThrow(/zoom\.sharpen/);
    expect(() => resolveProject({ version: 1, zoom: { sharpen: { amount: 0.5 } } })).toThrow(/zoom\.sharpen/);
  });
});
