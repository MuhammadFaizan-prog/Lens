/**
 * Voiceover (demand #17, docs/Voiceover.md), editor side. Bounds set before the first run:
 * - voiceSchedule: a clip plays from its output time, starts part-way when the playhead is inside it
 *   (offset exact to 1 ms), nothing for clips already past, nothing in reverse, scaled by the rate;
 * - export audio (server/exportAudio.ts, the desktop / browser-export path): a 1 kHz tone clip placed at
 *   output 1000 ms has its onset within ±5 ms of 1000 ms, is silent (< -80 dBFS) before it and after its
 *   trimmed end, and +6 dB gain measures +6 dB ±0.5 dB against 0 dB;
 * - with a mic track, noise reduction and loudness on, the voice level is the same (±0.5 dB) as with them
 *   off: the clip is mixed after the tracks' cleanup;
 * - a project without voiceover renders bit-identical audio to before (no voice -> renderExportAudio
 *   output unchanged).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AudioPlan, RenderPlan } from "@lens/engine";
import { buildRenderPlan, resolveProject } from "@lens/engine";
import { voiceSchedule } from "../src/media/audio";
import { renderExportAudio } from "../server/exportAudio";

const FF = "ffmpeg";
const hasFfmpeg = spawnSync(FF, ["-version"]).status === 0;
const ROOT = path.resolve(__dirname, "..", "..", "..");
const SR = 48000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lens-vo-"));
const db = (x: number) => 20 * Math.log10(x + 1e-12);

function rms(s: Float32Array, a: number, b: number): number {
  let acc = 0, n = 0;
  for (let i = Math.round(a * SR); i < Math.round(b * SR); i++) {
    const v = (s[2 * i]! + s[2 * i + 1]!) / 2;
    acc += v * v;
    n++;
  }
  return Math.sqrt(acc / Math.max(1, n));
}
/** First sample (s) whose |mono| exceeds `thr`. */
function onset(s: Float32Array, thr = 0.02): number {
  for (let i = 0; i < s.length / 2; i++) if (Math.abs((s[2 * i]! + s[2 * i + 1]!) / 2) > thr) return i / SR;
  return -1;
}
const raw = (f: string) => {
  const b = fs.readFileSync(f);
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
};

function plan(voice: AudioPlan["voice"], over: Partial<AudioPlan> = {}): AudioPlan {
  return {
    sampleRate: SR,
    durationMs: 3000,
    tracks: [],
    pieces: [{ srcStart: 0, srcEnd: 3000, rate: 1, outStart: 0, outEnd: 3000, gain: 1 }],
    clickSound: { enabled: false, volume: 0, times: [] },
    noiseReduction: { enabled: false, amountDb: 12 },
    loudness: { enabled: false, targetLufs: -16, truePeakDb: -1.5, lra: 11 },
    ...(voice ? { voice } : {}),
    ...over,
  };
}

describe("voiceover preview schedule", () => {
  const META = { width: 1280, height: 720, fps: 30, durationMs: 6000, pixelRatio: 1 };
  const p = buildRenderPlan({
    meta: META,
    events: [],
    project: resolveProject({
      output: { fps: 30, resolution: 360 },
      edits: { cuts: [{ startMs: 1000, endMs: 2000 }] },
      voiceover: { clips: [{ id: "a", name: "a", path: "voiceover/a.wav", fileMs: 2000, srcMs: 2500, trimStartMs: 200, trimEndMs: 1200, gainDb: 6 }] },
    }),
  }) as RenderPlan;

  it("anchors on the recording clock: after a 1 s cut the clip plays at output 1500 ms", () => {
    const v = p.audio!.voice!;
    expect(v).toHaveLength(1);
    expect(v[0]!.outMs).toBe(1500);
    expect(v[0]!.durMs).toBe(1000);
    expect(v[0]!.fileOffsetMs).toBe(200);
    const s = voiceSchedule(p, 0, 1);
    expect(s[0]!.whenS).toBeCloseTo(1.5, 3);
    expect(s[0]!.offsetS).toBeCloseTo(0.2, 3);
    expect(s[0]!.fadeIn).toBe(true);
    expect(s[0]!.gain).toBeCloseTo(1.995262, 5);
  });

  it("starts part-way from a playhead inside the clip; nothing after it; nothing in reverse; scaled by rate", () => {
    const f = Math.round((2000 / 1000) * 30); // output 2000 ms: 500 ms into the clip
    const s = voiceSchedule(p, f, 1);
    expect(s[0]!.whenS).toBe(0);
    expect(s[0]!.offsetS).toBeCloseTo(0.7, 3);
    expect(s[0]!.durationS).toBeCloseTo(0.5, 3);
    expect(s[0]!.fadeIn).toBe(false);
    expect(voiceSchedule(p, 80, 1)).toHaveLength(0);
    expect(voiceSchedule(p, 0, -1)).toHaveLength(0);
    expect(voiceSchedule(p, 0, 2)[0]!.whenS).toBeCloseTo(0.75, 3);
  });
});

describe.skipIf(!hasFfmpeg)("voiceover export mixing (browser-export path, no Python)", () => {
  const dir = tmp();
  const tone = path.join(dir, "tone.wav");
  const mic = path.join(dir, "mic.wav");
  // 1.5 s file: 0.25 s of silence, then a 1 kHz tone at -12 dBFS
  spawnSync(FF, ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=1000:d=1.25:sample_rate=48000", "-af", "volume=0.25,adelay=250:all=1", "-ac", "1", tone]);
  spawnSync(FF, ["-v", "error", "-y", "-f", "lavfi", "-i", "anoisesrc=d=3:c=pink:a=0.05:r=48000", "-ac", "1", mic]);

  const voice = (gain: number) => [{ id: "a", path: tone, outMs: 1000, fileOffsetMs: 250, durMs: 1000, gain }];

  it("onset at the clip's output time (±5 ms), silent outside it, gain in dB as set (±0.5 dB)", async () => {
    const a = await renderExportAudio(FF, plan(voice(1)), 3000, path.join(dir, "a0"), ROOT);
    const s = raw(a!.file);
    expect(s.length / 2).toBe(3 * SR);
    const t = onset(s);
    expect(Math.abs(t - 1.0)).toBeLessThanOrEqual(0.005);
    expect(db(rms(s, 0, 0.99))).toBeLessThan(-80);
    expect(db(rms(s, 2.01, 3))).toBeLessThan(-80);
    const b = await renderExportAudio(FF, plan(voice(Math.pow(10, 6 / 20))), 3000, path.join(dir, "a6"), ROOT);
    const s6 = raw(b!.file);
    expect(Math.abs(db(rms(s6, 1.1, 1.9)) - db(rms(s, 1.1, 1.9)) - 6)).toBeLessThanOrEqual(0.5);
  });

  it("mixed after the tracks' cleanup: voice level unchanged by denoise + loudness (±0.5 dB)", async () => {
    const tracks = [{ id: "mic", kind: "mic" as const, path: mic, offsetMs: 0, volume: 1 }];
    const clean = { noiseReduction: { enabled: true, amountDb: 12 }, loudness: { enabled: true, targetLufs: -16, truePeakDb: -1.5, lra: 11 } };
    // the voice alone = (mix with it) - (mix without it), under the same cleanup
    const voiceLevel = async (over: Partial<AudioPlan>, tag: string) => {
      const w = raw((await renderExportAudio(FF, plan(voice(1), { tracks, ...over }), 3000, path.join(dir, `${tag}w`), ROOT))!.file);
      const o = raw((await renderExportAudio(FF, plan(undefined, { tracks, ...over }), 3000, path.join(dir, `${tag}o`), ROOT))!.file);
      const d = new Float32Array(w.length);
      for (let i = 0; i < w.length; i++) d[i] = w[i]! - o[i]!;
      return db(rms(d, 1.1, 1.9));
    };
    const off = await voiceLevel({}, "b0");
    const on = await voiceLevel(clean, "b1");
    expect(Math.abs(on - off)).toBeLessThanOrEqual(0.5);
    // lavfi sine is 1/8 full scale; x0.25 -> RMS 0.03125/sqrt2. A mono file plays at full level in both
    // channels, as Web Audio plays it in the preview (not ffmpeg's -3 dB upmix)
    expect(Math.abs(off - db((0.125 * 0.25) / Math.SQRT2))).toBeLessThanOrEqual(0.5);
  });

  it("no voiceover: the rendered audio is the same as before (no voice key, same bytes)", async () => {
    const p0 = plan(undefined, { clickSound: { enabled: true, volume: 0.5, times: [500] } });
    expect("voice" in p0).toBe(false);
    const a = await renderExportAudio(FF, p0, 3000, path.join(dir, "c0"), ROOT);
    const b = await renderExportAudio(FF, { ...p0, voice: [] }, 3000, path.join(dir, "c1"), ROOT);
    expect(Buffer.compare(fs.readFileSync(a!.file), fs.readFileSync(b!.file))).toBe(0);
  });
});
