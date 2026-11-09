import { describe, expect, it } from "vitest";
import { clampLayout, defaultLayout, MIN_CENTER_W } from "../src/state/uiLayout";

describe("responsive layout (Windows bug #11)", () => {
  it("keeps the centre column usable at 1024 and the stage at 640 tall", () => {
    for (const [vw, vh] of [[1024, 640], [1280, 720], [1366, 768], [3840, 2160]] as Array<[number, number]>) {
      const l = clampLayout({ ...defaultLayout(vw, vh), leftW: 480, rightW: 520 }, vw, vh);
      const used = (l.leftOpen ? l.leftW : 0) + (l.rightOpen ? l.rightW : 0);
      expect(vw - used - 10).toBeGreaterThanOrEqual(MIN_CENTER_W - 1);
      expect(vh - 52 - 5 - l.tlH).toBeGreaterThanOrEqual(240);
    }
  });
});
