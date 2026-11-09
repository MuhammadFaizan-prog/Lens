import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AudioPlan } from "@lens/engine";
import { EventEmitter } from "node:events";
import { atempoChain, audioFilterGraph, writeFrame, type BrowserExportJob } from "../server/browserExport";
import { parseFfmpegVideoInfo } from "../server/api";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

function plan(over: Partial<AudioPlan> = {}): AudioPlan {
  return {
    sampleRate: 48000,
    durationMs: 3000,
    tracks: [{ id: "mic", kind: "mic", path: "mic.wav", offsetMs: 0, volume: 1 }],
    pieces: [{ srcStart: 0, srcEnd: 3000, rate: 1, outStart: 0, outEnd: 3000, gain: 1 }],
    clickSound: { enabled: false, volume: 0, times: [] },
    noiseReduction: { enabled: false, amountDb: 12 },
    loudness: { enabled: false, targetLufs: -16, truePeakDb: -1.5, lra: 11 },
    ...over,
  };
}

describe("in-browser export (desktop): ffmpeg side", () => {
  it("atempo stages stay inside 0.5..100", () => {
    expect(atempoChain(1)).toBe("");
    expect(atempoChain(2)).toBe("atempo=2.000000");
    expect(atempoChain(0.25)).toBe("atempo=0.500000,atempo=0.500000");
  });

  it("no tracks -> no audio graph", () => {
    expect(audioFilterGraph(null)).toBeNull();
    expect(audioFilterGraph(plan({ tracks: [] }))).toBeNull();
  });

  it("ffmpeg -i parsing (no ffprobe shipped on Windows)", () => {
    const txt = "Input #0, mov,mp4\n  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709), 1920x1080 [SAR 1:1 DAR 16:9], 4512 kb/s, 30 fps, 30 tbr, 15360 tbn (default)\n";
    expect(parseFfmpegVideoInfo(txt)).toEqual({ width: 1920, height: 1080, fps: 30 });
    expect(parseFfmpegVideoInfo("Stream #0:0: Video: vp8, yuv420p, 1280x720, SAR 1:1 DAR 16:9, 1k tbr, 1k tbn")).toEqual({ width: 1280, height: 720, fps: 30 }); // "1k tbr" is a timebase (VFR webm), not a frame rate: falls back to 30
    expect(() => parseFfmpegVideoInfo("Stream #0:0: Audio: opus")).toThrow();
  });

  it.skipIf(!hasFfmpeg)("the graph runs: a cut and a 2x piece land where the plan says", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lens-bexp-"));
    const mic = path.join(dir, "mic.wav");
    // 1 kHz tone 0-1 s, silence 1-2 s, tone 2-4 s
    expect(spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=1000:d=4:sample_rate=48000", "-af", "volume='if(between(t,1,2),0,1)':eval=frame", mic]).status).toBe(0);
    // keep 0-1 s at 1x (out 0-1 s), cut 1-2 s, play 2-4 s at 2x (out 1-2 s)
    const p = plan({ durationMs: 2000, tracks: [{ id: "mic", kind: "mic", path: mic, offsetMs: 0, volume: 0.5 }], pieces: [
      { srcStart: 0, srcEnd: 1000, rate: 1, outStart: 0, outEnd: 1000, gain: 1 },
      { srcStart: 2000, srcEnd: 4000, rate: 2, outStart: 1000, outEnd: 2000, gain: 1 },
    ] });
    const graph = audioFilterGraph(p, 0)!;
    const out = path.join(dir, "out.wav");
    const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", mic, "-filter_complex", graph, "-map", "[aout]", out], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const pcm = spawnSync("ffmpeg", ["-v", "error", "-i", out, "-f", "f32le", "-ac", "1", "-"], { maxBuffer: 1 << 26 }).stdout as Buffer;
    const s = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
    expect(s.length / 48000).toBeCloseTo(2, 2);
    const rms = (a: number, b: number) => {
      let acc = 0;
      for (let i = Math.round(a * 48000); i < Math.round(b * 48000); i++) acc += s[i]! * s[i]!;
      return Math.sqrt(acc / ((b - a) * 48000));
    };
    // sine amplitude 1/8 (lavfi default) * 0.5 volume -> rms ~0.044 in both halves, no silent gap from the cut
    expect(rms(0.1, 0.9)).toBeGreaterThan(0.03);
    expect(rms(1.1, 1.9)).toBeGreaterThan(0.03);
    expect(Math.abs(rms(0.1, 0.9) - rms(1.1, 1.9))).toBeLessThan(0.01);
  });

  // A fake ffmpeg whose stdin refuses every write (pipe full) until drained by the test.
  function fakeJob(total: number) {
    const stdin = Object.assign(new EventEmitter(), { writes: 0, write(_b: Buffer) { this.writes++; return false; } });
    const ff = Object.assign(new EventEmitter(), { stdin });
    const job = { id: "t", state: "running", done: 0, total, out: "", startedAt: 0, ff, chain: Promise.resolve() } as unknown as BrowserExportJob;
    return { job, stdin, ff };
  }

  it("streams with back-pressure: a frame is not written until the previous one drained", async () => {
    const { job, stdin } = fakeJob(3);
    const settled: number[] = [];
    const ps = [0, 1, 2].map((i) => writeFrame(job, i, Buffer.alloc(10)).then(() => settled.push(i)));
    await new Promise((r) => setTimeout(r, 10));
    expect(stdin.writes).toBe(1); // frames 1 and 2 wait on the drain, nothing is buffered beyond one
    stdin.emit("drain");
    await new Promise((r) => setTimeout(r, 10));
    expect(stdin.writes).toBe(2);
    stdin.emit("drain");
    await new Promise((r) => setTimeout(r, 10));
    stdin.emit("drain");
    await Promise.all(ps);
    expect(settled).toEqual([0, 1, 2]);
    expect(job.done).toBe(3);
  });

  it("a dead ffmpeg rejects the pending frame instead of hanging", async () => {
    const { job, ff } = fakeJob(5);
    const p = writeFrame(job, 0, Buffer.alloc(10));
    await new Promise((r) => setTimeout(r, 10));
    job.state = "error";
    job.error = "export ended at frame 1 of 5";
    ff.emit("close", null);
    await expect(p).rejects.toThrow(/frame 1 of 5/);
    await expect(writeFrame(job, 1, Buffer.alloc(10))).rejects.toThrow();
  });
});
