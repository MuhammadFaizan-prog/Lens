/**
 * Import Video (Windows report 2026-11-09: "Importing…" forever). h264 yuv420p CFR -> remux (-c:v copy,
 * packets byte-identical, fast); VP9 webm -> libx264 re-encode with progress events; Cancel kills ffmpeg
 * and removes the half-made folder; a non-video file fails with a reason (no hang).
 * Uses the system ffmpeg (the packaged app ships its own; file-menu.spec covers that one).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ImportCancelled, canCopy, importVideo, parseProbe } from "../src/main/library";

const FF = process.env.LENS_TEST_FFMPEG ?? "ffmpeg";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lens-import-"));
const root = path.join(tmp, "rec");
const h264 = path.join(tmp, "talk.mp4");
const vp9 = path.join(tmp, "clip.webm");
const vp9Long = path.join(tmp, "long.webm");
const ff = (args: string[]) => execFileSync(FF, ["-v", "error", "-y", ...args]);
const packetHashes = (f: string) => execFileSync(FF, ["-v", "error", "-i", f, "-map", "0:v:0", "-c", "copy", "-f", "framemd5", "-"]).toString().split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").pop()!.trim());

beforeAll(() => {
  fs.mkdirSync(root, { recursive: true });
  ff(["-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=6", "-f", "lavfi", "-i", "sine=f=440:d=6:sample_rate=44100", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", h264]);
  ff(["-f", "lavfi", "-i", "testsrc2=s=640x360:r=25:d=3", "-f", "lavfi", "-i", "sine=f=300:d=3", "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "1M", "-c:a", "libopus", "-shortest", vp9]);
  ff(["-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30:d=40", "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "2M", vp9Long]);
}, 120_000);

describe("parseProbe / canCopy", () => {
  it("h264 yuv420p CFR is copyable, vp9 / odd size / VFR / 10-bit are not", () => {
    const line = (v: string, extra = "") => `Input #0, mov\n  Duration: 00:01:02.50, start: 0.000000, bitrate: 1 kb/s\n  Stream #0:0[0x1](und): Video: ${v}${extra}\n  Stream #0:1[0x2](und): Audio: aac (LC), 44100 Hz, mono\n`;
    const ok = parseProbe(line("h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1280x720 [SAR 1:1 DAR 16:9], 1000 kb/s, 30 fps, 30 tbr, 15360 tbn (default)"));
    expect(ok).toMatchObject({ durationMs: 62500, width: 1280, height: 720, codec: "h264", pixFmt: "yuv420p", fps: 30, tbr: 30, hasAudio: true });
    expect(canCopy(ok)).toBe(true);
    expect(canCopy({ ...ok, codec: "vp9" })).toBe(false);
    expect(canCopy({ ...ok, width: 1279 })).toBe(false);
    expect(canCopy({ ...ok, fps: 29.2, tbr: 60 })).toBe(false); // variable frame rate
    expect(canCopy({ ...ok, pixFmt: "yuv420p10le" })).toBe(false);
    expect(canCopy({ ...ok, fps: 120, tbr: 120 })).toBe(false);
    expect(canCopy({ ...ok, rotated: true })).toBe(false);
  });
});

describe("importVideo", () => {
  it("h264: remuxes without re-encoding, fast, duration from the probe", async () => {
    const t0 = Date.now();
    const r = await importVideo(root, FF, h264);
    const ms = Date.now() - t0;
    expect(r.video).toBe("copy");
    expect(packetHashes(path.join(r.dir, "screen.mp4"))).toEqual(packetHashes(h264)); // byte-identical packets: no re-encode
    const meta = JSON.parse(fs.readFileSync(path.join(r.dir, "meta.json"), "utf8"));
    expect(meta).toMatchObject({ width: 1280, height: 720, fps: 30 });
    expect(Math.abs(meta.durationMs - 6000)).toBeLessThanOrEqual(100);
    expect(fs.existsSync(path.join(r.dir, "mic.wav"))).toBe(true);
    expect(ms).toBeLessThan(5000);
    console.log("copy import ms", ms);
  }, 60_000);

  it("vp9 webm: re-encodes with progress events up to 100", async () => {
    const seen: number[] = [];
    const r = await importVideo(root, FF, vp9, { onProgress: (p) => seen.push(p.pct) });
    expect(r.video).toBe("encode");
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.at(-1)).toBe(100);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    const meta = JSON.parse(fs.readFileSync(path.join(r.dir, "meta.json"), "utf8"));
    expect(meta.fps).toBe(30);
    const codec = execFileSync(FF.replace(/ffmpeg$/, "ffprobe"), ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", path.join(r.dir, "screen.mp4")]).toString().trim();
    expect(codec).toBe("h264");
  }, 120_000);

  it("cancel mid re-encode kills ffmpeg and removes the folder", async () => {
    const ac = new AbortController();
    const before = new Set(fs.readdirSync(root));
    let firstVideo = false;
    const p = importVideo(root, FF, vp9Long, { signal: ac.signal, onProgress: (e) => {
      if (e.phase === "video" && e.pct > 0 && !firstVideo) {
        firstVideo = true;
        ac.abort();
      }
    } });
    await expect(p).rejects.toBeInstanceOf(ImportCancelled);
    expect(firstVideo).toBe(true);
    expect(fs.readdirSync(root).filter((d) => !before.has(d))).toEqual([]);
  }, 120_000);

  it("a file that is not a video fails with a reason and leaves nothing", async () => {
    const bad = path.join(tmp, "notes.mp4");
    fs.writeFileSync(bad, "this is not a video");
    const before = new Set(fs.readdirSync(root));
    await expect(importVideo(root, FF, bad)).rejects.toThrow(/no video stream/);
    expect(fs.readdirSync(root).filter((d) => !before.has(d))).toEqual([]);
  }, 30_000);

  it("the probe step has a timeout", async () => {
    // a fake "ffmpeg" that never answers
    const slow = path.join(tmp, process.platform === "win32" ? "slow.cmd" : "slow.sh");
    fs.writeFileSync(slow, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    await expect(importVideo(root, slow, h264, { probeTimeoutMs: 500 })).rejects.toThrow(/did not answer/);
  }, 30_000);
});
