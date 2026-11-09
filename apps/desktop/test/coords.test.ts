import { describe, expect, it } from "vitest";
import { dipToCapture, dipToPhysical, displayAtDip, displayForSource, inFrame, physicalBoundsOf, physicalToCapture, resolveClickPoint, type DisplayGeom } from "../src/shared/coords";

// Two monitors as Windows reports them with mixed DPI: a 4K panel at 150% (primary) and a 1080p at 100%
// to its right. DIP rects come from Electron's Display.bounds, physical rects from screen.dipToScreenRect.
const primary: DisplayGeom = { id: 1, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 1.5, physical: { x: 0, y: 0, width: 3840, height: 2160 } };
const right: DisplayGeom = { id: 2, bounds: { x: 2560, y: 200, width: 1920, height: 1080 }, scaleFactor: 1, physical: { x: 3840, y: 300, width: 1920, height: 1080 } };
// a monitor left of the primary at 125%: negative coordinates
const left: DisplayGeom = { id: 3, bounds: { x: -1536, y: 0, width: 1536, height: 864 }, scaleFactor: 1.25, physical: { x: -1920, y: 0, width: 1920, height: 1080 } };
const displays = [primary, right, left];

describe("coordinate / DPI mapping", () => {
  it("DIP -> physical goes through the display that holds the point", () => {
    expect(dipToPhysical({ x: 100, y: 100 }, displays)).toEqual({ x: 150, y: 150 });
    expect(dipToPhysical({ x: 2560 + 10, y: 200 + 20 }, displays)).toEqual({ x: 3850, y: 320 });
    expect(dipToPhysical({ x: -1536, y: 0 }, displays)).toEqual({ x: -1920, y: 0 });
    expect(dipToPhysical({ x: -1, y: 10 }, displays)).toEqual({ x: -1.25, y: 12.5 });
  });

  it("capture px of the recorded display, at full and downscaled capture size", () => {
    expect(dipToCapture({ x: 1280, y: 720 }, displays, primary, { width: 3840, height: 2160 })).toEqual({ x: 1920, y: 1080 });
    // the stream came in at 1920x1080 for the 4K display: half scale
    expect(dipToCapture({ x: 1280, y: 720 }, displays, primary, { width: 1920, height: 1080 })).toEqual({ x: 960, y: 540 });
    // second display recorded: its own origin
    expect(dipToCapture({ x: 2560 + 960, y: 200 + 540 }, displays, right, { width: 1920, height: 1080 })).toEqual({ x: 960, y: 540 });
    // left display, negative DIP space
    expect(dipToCapture({ x: -768, y: 432 }, displays, left, { width: 1920, height: 1080 })).toEqual({ x: 960, y: 540 });
  });

  it("points on another display land outside the frame", () => {
    const p = dipToCapture({ x: 2600, y: 300 }, displays, primary, { width: 3840, height: 2160 });
    expect(inFrame(p, { width: 3840, height: 2160 })).toBe(false);
    expect(inFrame({ x: 0, y: 0 }, { width: 10, height: 10 })).toBe(true);
    expect(inFrame({ x: 10, y: 5 }, { width: 10, height: 10 })).toBe(false);
  });

  it("physical rect defaults to bounds * scale (X11)", () => {
    const x11: DisplayGeom = { id: 9, bounds: { x: 640, y: 0, width: 640, height: 360 }, scaleFactor: 2 };
    expect(physicalBoundsOf(x11)).toEqual({ x: 1280, y: 0, width: 1280, height: 720 });
    expect(physicalToCapture({ x: 1280 + 100, y: 50 }, x11, { width: 1280, height: 720 })).toEqual({ x: 100, y: 50 });
  });

  it("gap between displays: nearest display", () => {
    expect(displayAtDip({ x: 2559.5, y: 1500 }, displays).id).toBe(1);
    expect(displayAtDip({ x: 5000, y: 500 }, displays).id).toBe(2);
  });

  it("click point: hook (physical) preferred, DIP-reporting hook detected, poll as fallback", () => {
    const cap = { width: 3840, height: 2160 };
    // hook physical (1500.6, 900.3); poll says DIP (1000, 600) = physical (1500, 900)
    const a = resolveClickPoint({ x: 1500.6, y: 900.3 }, { x: 1000, y: 600 }, displays, primary, cap)!;
    expect(a.source).toBe("hook");
    expect(a.point.x).toBeCloseTo(1500.6, 6);
    // a DPI-unaware hook reports DIPs: (1000, 600) must not be taken as physical
    const b = resolveClickPoint({ x: 1000, y: 600 }, { x: 1000, y: 600 }, displays, primary, cap)!;
    expect(b.source).toBe("hook-dip");
    expect(b.point).toEqual({ x: 1500, y: 900 });
    // garbage from the hook: the poll wins
    const c = resolveClickPoint({ x: 9999, y: 9999 }, { x: 1000, y: 600 }, displays, primary, cap)!;
    expect(c.source).toBe("poll");
    expect(resolveClickPoint(null, null, displays, primary, cap)).toBeNull();
    expect(resolveClickPoint({ x: 10, y: 20 }, null, displays, primary, cap)!.source).toBe("hook");
  });

  it("desktopCapturer source -> display", () => {
    expect(displayForSource("2", "screen:1:0", displays)!.id).toBe(2);
    expect(displayForSource("", "screen:0:0", [primary])!.id).toBe(1);
    expect(displayForSource(undefined, "screen:2:0", displays)!.id).toBe(3);
    expect(displayForSource(undefined, "window:1234:0", displays)).toBeNull();
  });
});
