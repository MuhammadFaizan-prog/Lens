import { describe, expect, it } from "vitest";
import { overlayArgs } from "../server/nleExport";

describe("NLE overlay encode (demand #11)", () => {
  it("PNG frames with alpha -> ProRes 4444 with alpha and VP9 with alpha, ffmpeg only", () => {
    const a = overlayArgs({ output: { width: 640, height: 360, fps: 30, frames: 150, durationMs: 5000 } } as never, "/x/overlay.mov", "/x/overlay.webm");
    const s = a.join(" ");
    expect(s).toContain("-f image2pipe -framerate 30 -c:v png -i pipe:0");
    expect(s).toContain("-c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le -alpha_bits 16");
    expect(s).toContain("-c:v libvpx-vp9 -pix_fmt yuva420p");
    expect(a.indexOf("/x/overlay.mov")).toBeLessThan(a.indexOf("/x/overlay.webm"));
  });
});
