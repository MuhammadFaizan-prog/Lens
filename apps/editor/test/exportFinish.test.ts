import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EncodeSettings, RenderPlan } from "@lens/engine";
import { browserExportArgs } from "../server/browserExport";
import { capArgs, finishExport, gifArgs } from "../server/exportFinish";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const plan = { output: { width: 1280, height: 720, fps: 30, frames: 90, durationMs: 3000 }, frames: new Array(90) } as unknown as RenderPlan;
const enc = (o: Partial<EncodeSettings>): EncodeSettings => ({ format: "mp4", bitrateMbps: 0, maxrateMbps: 0, maxBytes: 0, gif: { fps: 10, width: 320, loop: true }, ...o });

function sample(dir: string, seconds = 3): string {
  const f = path.join(dir, "export.mp4");
  // noisy content so x264 needs real bits; sine audio so the AAC track is there
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=640x360:r=30:d=${seconds},noise=alls=60:allf=t`, "-f", "lavfi", "-i", `sine=f=440:d=${seconds}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "8", "-c:a", "aac", "-b:a", "160k", "-shortest", f]);
  expect(r.status).toBe(0);
  return f;
}

describe("platform export presets: encode arguments and the last steps (demand #24)", () => {
  it("no preset: the encoder arguments are exactly the old ones (crf 18 / Settings bitrate x1.5 peak)", () => {
    const a = browserExportArgs(plan, "o.mp4");
    expect(a.slice(a.indexOf("libx264") - 1, a.indexOf("-threads"))).toEqual(["-c:v", "libx264", "-preset", "veryfast", "-crf", "18"]);
    const b = browserExportArgs(plan, "o.mp4", { bitrateMbps: 10 });
    expect(b.slice(b.indexOf("-b:v"), b.indexOf("-threads"))).toEqual(["-b:v", "10M", "-maxrate", "15M", "-bufsize", "20M"]);
    // a preset's peak
    const c = browserExportArgs(plan, "o.mp4", { bitrateMbps: 11, maxrateMbps: 12 });
    expect(c.slice(c.indexOf("-b:v"), c.indexOf("-threads"))).toEqual(["-b:v", "11M", "-maxrate", "12M", "-bufsize", "22M"]);
  });

  // bound (set before the first run): on content that needs the bits, the preset bitrate is what the
  // encode averages, within 0.80..1.10 x (x264 ABR; easy screen content comes out under it)
  it.skipIf(!hasFfmpeg)("a preset bitrate is what the encoder averages on busy content (0.80..1.10 x)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lens-rate-"));
    const out = path.join(dir, "v.mp4");
    const p = { output: { width: 1280, height: 720, fps: 30, frames: 150, durationMs: 5000 }, frames: new Array(150) } as unknown as RenderPlan;
    const a = browserExportArgs(p, out, { bitrateMbps: 8, maxrateMbps: 12 });
    // the same encoder arguments, fed busy synthetic frames instead of the JPEG pipe
    const i = a.indexOf("-i");
    const args = ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=5,noise=alls=40:allf=t", ...a.slice(i + 2)];
    expect(spawnSync("ffmpeg", args).status).toBe(0);
    const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=bit_rate", "-of", "csv=p=0", out], { encoding: "utf8" });
    const mbps = Number(r.stdout.trim()) / 1e6;
    console.log("preset 8 Mbps -> measured", mbps.toFixed(2), "Mbps");
    expect(mbps).toBeGreaterThanOrEqual(8 * 0.8);
    expect(mbps).toBeLessThanOrEqual(8 * 1.1);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 90_000);

  it("GIF / cap argument shapes", () => {
    expect(gifArgs("a.mp4", "a.gif", { fps: 12, width: 480, loop: false }).join(" ")).toContain("fps=12,scale=480:-1:flags=lanczos");
    expect(gifArgs("a.mp4", "a.gif", { fps: 12, width: 480, loop: true })).toContain("0");
    const ca = capArgs("a.mp4", "b.mp4", 1.234);
    expect(ca.slice(ca.indexOf("-b:v"), ca.indexOf("-b:v") + 6)).toEqual(["-b:v", "1234k", "-maxrate", "1234k", "-bufsize", "2468k"]);
  });

  it("MP4 without a cap is left alone", async () => {
    const r = await finishExport("ffmpeg", "/nonexistent/export.mp4", enc({}), 3000, true);
    expect(r).toEqual({ out: "/nonexistent/export.mp4", format: "mp4" });
  });

  it.skipIf(!hasFfmpeg)("size cap: an over-cap MP4 is re-encoded under the cap, duration and audio kept", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lens-cap-"));
    const f = sample(dir);
    const before = fs.statSync(f).size;
    const cap = Math.round(before / 4);
    const r = await finishExport("ffmpeg", f, enc({ maxBytes: cap }), 3000, true);
    expect(r.cap!.before).toBe(before);
    expect(r.cap!.passes).toBeGreaterThanOrEqual(1);
    expect(fs.statSync(f).size).toBe(r.cap!.after);
    expect(r.cap!.after).toBeLessThanOrEqual(cap);
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", f], { encoding: "utf8" });
    const j = JSON.parse(probe.stdout);
    expect(Math.abs(Number(j.format.duration) - 3)).toBeLessThan(0.1);
    expect(j.streams.map((s: { codec_type: string }) => s.codec_type).sort()).toEqual(["audio", "video"]);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it.skipIf(!hasFfmpeg)("GIF: palette GIF at the set width / fps with the loop block", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lens-gif-"));
    const f = sample(dir, 2);
    const r = await finishExport("ffmpeg", f, enc({ format: "gif" }), 2000, true);
    expect(r.format).toBe("gif");
    const buf = fs.readFileSync(r.out);
    expect(buf.subarray(0, 6).toString("latin1")).toBe("GIF89a");
    expect(buf.readUInt16LE(6)).toBe(320);
    expect(buf.includes(Buffer.from("NETSCAPE2.0", "latin1"))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it.skipIf(!hasFfmpeg)("cancel stops a running step and never reports done", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lens-cancel-"));
    const f = sample(dir, 3);
    let cancelled = false;
    const p = finishExport("ffmpeg", f, enc({ format: "gif" }), 3000, true, {
      cancelled: () => cancelled,
      child: (c) => {
        if (c) {
          cancelled = true;
          c.kill("SIGKILL");
        }
      },
    });
    await expect(p).rejects.toThrow("cancelled");
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
