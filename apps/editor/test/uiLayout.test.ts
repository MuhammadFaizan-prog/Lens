import { describe, expect, it } from "vitest";
import { clampLabelW, clampLayout, defaultLayout, RIGHT_MAX, RIGHT_MIN, TL_LABEL_MAX, TL_LABEL_MIN, TL_LABEL_W } from "../src/state/uiLayout";

describe("resizable panes (Windows v0.1.3)", () => {
  it("lane-header width stays inside 90..320 and falls back to the default", () => {
    expect(TL_LABEL_MIN).toBe(90);
    expect(TL_LABEL_MAX).toBe(320);
    expect(clampLabelW(undefined)).toBe(TL_LABEL_W);
    expect(clampLabelW(Number.NaN)).toBe(TL_LABEL_W);
    expect(clampLabelW(10)).toBe(90);
    expect(clampLabelW(1000)).toBe(320);
    expect(clampLabelW(200.4)).toBe(200);
  });
  it("Inspector width stays inside 280..600 when the window has room", () => {
    const vw = 2400, vh = 1400;
    expect(clampLayout({ ...defaultLayout(vw, vh), rightW: 100 }, vw, vh).rightW).toBe(RIGHT_MIN);
    expect(clampLayout({ ...defaultLayout(vw, vh), rightW: 900 }, vw, vh).rightW).toBe(RIGHT_MAX);
    expect(clampLayout({ ...defaultLayout(vw, vh), rightW: 450 }, vw, vh).rightW).toBe(450);
    expect(defaultLayout(1280, 720).rightW).toBeGreaterThanOrEqual(RIGHT_MIN);
  });
  it("a small window still shrinks both panels so the centre keeps its room", () => {
    const vw = 1024, vh = 640;
    const l = clampLayout({ ...defaultLayout(vw, vh), leftOpen: true, leftW: 480, rightW: 600 }, vw, vh);
    expect(l.leftW + l.rightW).toBeLessThanOrEqual(vw - 380 - 10);
  });
});
