/**
 * Editor open (v0.1.3 perf): one probe per file, cached by path + size + mtime, shared by concurrent
 * callers, failures not remembered, a disk copy reused after a restart; the probe itself is one async
 * process that yields size, fps and frame count together.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FileCache, parseCopyPass, probeVideoFile } from "../server/probe";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lens-probe-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

function file(name: string, body: string): string {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, body);
  return f;
}

describe("FileCache", () => {
  it("computes once per file version; concurrent callers share the work", async () => {
    const f = file("a.bin", "one");
    let calls = 0;
    const c = new FileCache<number>(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return calls;
    });
    const [x, y] = await Promise.all([c.get(f), c.get(f)]);
    expect([x, y, calls]).toEqual([1, 1, 1]);
    expect(await c.get(f)).toBe(1);
    expect(c.peek(f)).toBe(1);
    // a changed file (size + mtime) is a new key
    fs.writeFileSync(f, "changed!");
    fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
    expect(c.peek(f)).toBeUndefined();
    expect(await c.get(f)).toBe(2);
  });

  it("does not remember a failure", async () => {
    const f = file("b.bin", "x");
    let n = 0;
    const c = new FileCache<string>(async () => {
      if (++n === 1) throw new Error("boom");
      return "ok";
    });
    await expect(c.get(f)).rejects.toThrow("boom");
    expect(c.peek(f)).toBeUndefined();
    expect(await c.get(f)).toBe("ok");
    expect(n).toBe(2);
  });

  it("reuses the disk copy in a fresh instance (app restart), and ignores it for another file version", async () => {
    const f = file("c.bin", "disk");
    const disk = path.join(tmp, "cache", "c.json");
    let calls = 0;
    const compute = async () => ({ v: ++calls });
    expect(await new FileCache(compute).get(f, disk)).toEqual({ v: 1 });
    const fresh = new FileCache(compute);
    expect(fresh.peek(f, disk)).toEqual({ v: 1 });
    expect(await fresh.get(f, disk)).toEqual({ v: 1 });
    expect(calls).toBe(1);
    fs.appendFileSync(f, "+");
    expect(new FileCache(compute).peek(f, disk)).toBeUndefined();
    expect(await new FileCache(compute).get(f, disk)).toEqual({ v: 2 });
    // a different cache version never reads the old entry
    expect(new FileCache(compute, "v2").peek(f, disk)).toBeUndefined();
  });

  it("peek starts no work", () => {
    const f = file("d.bin", "p");
    let calls = 0;
    const c = new FileCache(async () => ++calls);
    expect(c.peek(f)).toBeUndefined();
    expect(calls).toBe(0);
  });
});

describe("probe", () => {
  it("reads size, fps and frame count from one ffmpeg stream-copy pass", () => {
    const err = [
      "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'screen.mp4':",
      "  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 4123 kb/s, 60 fps, 60 tbr, 15360 tbn (default)",
      "frame= 1200 fps=0.0 q=-1.0 size=N/A time=00:00:20.00 bitrate=N/A speed=40x",
      "frame= 3600 fps=0.0 q=-1.0 Lsize=N/A time=00:01:00.00 bitrate=N/A speed=41x",
    ].join("\n");
    expect(parseCopyPass(err)).toEqual({ width: 1920, height: 1080, fps: 60, frames: 3600 });
  });

  it.skipIf(!hasFfmpeg)("probes a real file with and without ffprobe (one process either way)", async () => {
    const f = path.join(tmp, "v.mp4");
    const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", f]);
    expect(r.status).toBe(0);
    const want = { width: 320, height: 240, fps: 25, frames: 50 };
    expect(await probeVideoFile("ffmpeg", "/nonexistent-ffprobe", f)).toEqual(want);
    if (spawnSync("ffprobe", ["-version"]).status === 0) expect(await probeVideoFile("ffmpeg", "ffprobe", f)).toEqual(want);
    await expect(probeVideoFile("ffmpeg", "/nonexistent-ffprobe", file("bad.mp4", "not a video"))).rejects.toThrow(/no readable video frames/);
  });
});
