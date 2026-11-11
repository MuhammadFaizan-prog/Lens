import { describe, expect, it } from "vitest";
import { applyExportPreset, bitrateForCap, defaultProject, encodeSettings, estimateBytes, EXPORT_PRESETS, exportChecks, exportPreset, resolveProject, canvasSize } from "../src/index.js";

const out = (w: number, h: number, fps: number, s: number) => ({ width: w, height: h, fps, durationMs: s * 1000 });

describe("platform export presets (demand #24)", () => {
  it("a project without export.video encodes exactly as before (crf 18 / Settings bitrate, no cap)", () => {
    const p = defaultProject();
    expect(p.export.video).toBeUndefined();
    expect(encodeSettings(p)).toEqual({ format: "mp4", bitrateMbps: 0, maxrateMbps: 0, maxBytes: 0, gif: { fps: 15, width: 640, loop: true } });
    expect(encodeSettings(p, 20)).toMatchObject({ bitrateMbps: 20, maxrateMbps: 30, maxBytes: 0 });
    expect(exportChecks(p, out(1920, 1080, 60, 500), true)).toEqual([]);
    // resolveProject does not add the field
    expect(resolveProject({}).export.video).toBeUndefined();
  });

  it("every preset applies its size and frame rate and resolves to a valid project", () => {
    for (const pr of EXPORT_PRESETS) {
      const p = resolveProject(applyExportPreset(defaultProject(), pr.id));
      expect(p.export.video).toEqual({ preset: pr.id });
      if (pr.size) expect(canvasSize(p.output, { width: 1920, height: 1080 })).toEqual({ width: pr.size.w, height: pr.size.h });
      if (pr.fps) expect(p.output.fps).toBe(pr.fps);
    }
  });

  it("YouTube 8 / 12 Mbps, Shorts vertical, App Store <= 30 fps at 11 Mbps with a 12 Mbps peak", () => {
    const enc = (id: Parameters<typeof applyExportPreset>[1]) => encodeSettings(applyExportPreset(defaultProject(), id));
    expect(enc("youtube-1080p30")).toMatchObject({ bitrateMbps: 8, maxrateMbps: 12 });
    expect(enc("youtube-1080p60")).toMatchObject({ bitrateMbps: 12, maxrateMbps: 18 });
    expect(enc("appstore-iphone-portrait")).toMatchObject({ bitrateMbps: 11, maxrateMbps: 12, maxBytes: 500e6 });
    expect(enc("x")).toMatchObject({ maxBytes: 512e6 });
    expect(enc("gif").format).toBe("gif");
    expect(exportPreset("youtube-shorts").size).toEqual({ w: 1080, h: 1920 });
  });

  it("user bitrate wins, LinkedIn clamps to 30 Mbps, user cap wins over the preset's", () => {
    const li = applyExportPreset(defaultProject(), "linkedin");
    const p = { ...li, export: { ...li.export, video: { preset: "linkedin" as const, bitrateMbps: 50, maxSizeMB: 20 } } };
    expect(encodeSettings(p)).toMatchObject({ bitrateMbps: 30, maxrateMbps: 30, maxBytes: 20e6 });
    expect(exportChecks(p, out(1920, 1080, 30, 10), true).map((c) => c.code)).toContain("bitrate-over");
    const c = { ...defaultProject(), export: { gif: defaultProject().export.gif, video: { preset: "custom" as const, bitrateMbps: 6 } } };
    expect(encodeSettings(c)).toMatchObject({ bitrateMbps: 6, maxrateMbps: 9, maxBytes: 0 });
  });

  it("checks: duration over / under, canvas range, fps over, size estimate over the cap", () => {
    const x = applyExportPreset(defaultProject(), "x");
    expect(exportChecks(x, out(1920, 1080, 30, 141), true).map((c) => c.code)).toEqual(["duration-max"]);
    expect(exportChecks(x, out(1920, 1080, 30, 140), true)).toEqual([]);
    const as = applyExportPreset(defaultProject(), "appstore-ipad");
    expect(exportChecks(as, out(1200, 1600, 30, 6), true).map((c) => c.code)).toEqual(["duration-min"]);
    expect(exportChecks(as, out(1200, 1600, 60, 20), true).map((c) => c.code)).toEqual(["fps-over"]);
    const li = applyExportPreset(defaultProject(), "linkedin");
    expect(exportChecks(li, out(5000, 1080, 30, 20), true).map((c) => c.code)).toEqual(expect.arrayContaining(["dims-range", "size-mismatch"]));
    // 8 Mbps for 600 s ~ 612 MB > X's 512 MB
    const long = { ...x, export: { ...x.export, video: { preset: "x" as const } } };
    expect(exportChecks(long, out(1920, 1080, 30, 600), true).map((c) => c.code)).toEqual(["duration-max", "size-over-cap"]);
  });

  it("estimate and cap bitrate", () => {
    const e = encodeSettings(applyExportPreset(defaultProject(), "youtube-1080p30"));
    expect(estimateBytes(10_000, e, true)).toBe(Math.round(((8e6 + 160e3) * 10) / 8 * 1.01));
    expect(estimateBytes(10_000, encodeSettings(defaultProject()), true)).toBeNull();
    // fits: video + audio at that bitrate stay under the cap with the 3 % margin
    const mbps = bitrateForCap(5e6, 20_000, true);
    expect(((mbps * 1e6 + 160e3) * 20) / 8).toBeLessThanOrEqual(5e6 * 0.97 + 1);
    expect(bitrateForCap(5e6, 20_000, true, 0.7)).toBeCloseTo(mbps * 0.7, 6);
  });

  it("validation rejects unknown presets and out-of-range numbers", () => {
    expect(() => resolveProject({ export: { video: { preset: "myspace" } } })).toThrow(/export.video.preset/);
    expect(() => resolveProject({ export: { video: { preset: "custom", bitrateMbps: 0 } } })).toThrow(/bitrateMbps/);
    expect(() => resolveProject({ export: { video: { preset: "custom", maxSizeMB: -1 } } })).toThrow(/maxSizeMB/);
    expect(resolveProject({ export: { video: { preset: "custom", bitrateMbps: null, maxSizeMB: 8 } } }).export.video).toEqual({ preset: "custom", bitrateMbps: null, maxSizeMB: 8 });
  });
});
