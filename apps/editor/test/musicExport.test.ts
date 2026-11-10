/**
 * Music bed in the in-app export (demand #23): server/music.ts (built-in bed WAV, import checks) and
 * exportAudio's music mix (level vs the cleaned speech, duck and fade envelopes, loop), measured on
 * the rendered PCM by tone power (speech = 1 kHz, music = 220 Hz in the synthetic inputs).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AudioPlan } from "@lens/engine";
import { buildMusicPlan, defaultMusic, encodeWav16, integratedLoudness } from "@lens/engine";
import { importMusic, writeBuiltinBed } from "../server/music";
import { renderExportAudio } from "../server/exportAudio";

const FF = "ffmpeg";
const hasFfmpeg = spawnSync(FF, ["-version"]).status === 0;
const SR = 48000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lens-mu-"));

/** Power of frequency f in [a, b) s of interleaved stereo (left), as dB (Goertzel, Hann-free, whole cycles). */
function toneDb(x: Float32Array, f: number, a: number, b: number): number {
  const i0 = Math.round(a * SR), i1 = Math.round(b * SR);
  const w = (2 * Math.PI * f) / SR;
  let re = 0, im = 0;
  for (let i = i0; i < i1; i++) {
    const v = x[2 * i]!;
    re += v * Math.cos(w * i);
    im -= v * Math.sin(w * i);
  }
  const amp = (2 * Math.hypot(re, im)) / (i1 - i0);
  return 20 * Math.log10(amp + 1e-12);
}

function writeWav(file: string, l: Float32Array, r = l) {
  fs.writeFileSync(file, encodeWav16([l, r], SR));
}
const tone = (f: number, amp: number, secs: number, gate?: (t: number) => boolean) =>
  Float32Array.from({ length: Math.round(secs * SR) }, (_, i) => (gate && !gate(i / SR) ? 0 : amp * Math.sin((2 * Math.PI * f * i) / SR)));

describe.skipIf(!hasFfmpeg)("music files", () => {
  it("writes a built-in bed once as a 48 kHz stereo WAV ffmpeg decodes to the stated length", () => {
    const d = tmp();
    const a = writeBuiltinBed(d, "calm-pad");
    expect(a).toMatchObject({ path: "music/lens-calm-pad.wav", name: "Calm pad", source: "builtin:calm-pad" });
    const f = path.join(d, a.path);
    const mtime = fs.statSync(f).mtimeMs;
    const p = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=sample_rate,channels,duration", "-of", "json", f], { encoding: "utf8" });
    const s = JSON.parse(p.stdout).streams[0];
    expect(Number(s.sample_rate)).toBe(48000);
    expect(s.channels).toBe(2);
    expect(Math.abs(Number(s.duration) * 1000 - a.durationMs)).toBeLessThan(2);
    writeBuiltinBed(d, "calm-pad");
    expect(fs.statSync(f).mtimeMs).toBe(mtime);
    expect(() => writeBuiltinBed(d, "nope")).toThrow(/unknown/);
  });
  it("imports an audio file under a safe name and refuses other files", async () => {
    const d = tmp();
    const wav = path.join(d, "src.wav");
    writeWav(wav, tone(220, 0.3, 1.5));
    const r = await importMusic(FF, d, "../My Song!.wav", fs.readFileSync(wav));
    expect(r.path).toBe("music/My_Song_.wav");
    expect(Math.abs(r.durationMs - 1500)).toBeLessThan(30);
    expect(fs.existsSync(path.join(d, r.path))).toBe(true);
    await expect(importMusic(FF, d, "notes.txt", Buffer.from("hello"))).rejects.toThrow(/unsupported/);
    await expect(importMusic(FF, d, "fake.mp3", Buffer.from("not audio at all"))).rejects.toThrow(/not an audio file/);
    expect(fs.readdirSync(path.join(d, "music")).filter((f) => f.startsWith(".import"))).toEqual([]);
  });
});

describe.skipIf(!hasFfmpeg)("export mix", () => {
  // 10 s: speech (1 kHz) in [1, 3) and [6, 8), music (220 Hz, 2.5 s file, looped) under all of it
  const speechR = [{ startMs: 1000, endMs: 3000 }, { startMs: 6000, endMs: 8000 }];
  function plan(dir: string, over: Partial<ReturnType<typeof defaultMusic>> = {}, loudness = false): AudioPlan {
    const mic = path.join(dir, "mic.wav");
    writeWav(mic, tone(1000, 0.25, 10, (t) => speechR.some((r) => t * 1000 >= r.startMs && t * 1000 < r.endMs)));
    const mus = path.join(dir, "music.wav");
    writeWav(mus, tone(220, 0.5, 2.5));
    const m = { ...defaultMusic(mus, "t", "file"), fadeInMs: 0, fadeOutMs: 0, ...over };
    return {
      sampleRate: SR,
      durationMs: 10000,
      tracks: [{ id: "mic", kind: "mic", path: mic, offsetMs: 0, volume: 1 }],
      pieces: [{ srcStart: 0, srcEnd: 10000, rate: 1, outStart: 0, outEnd: 10000, gain: 1 }],
      clickSound: { enabled: false, volume: 0, times: [] },
      noiseReduction: { enabled: false, amountDb: 12 },
      loudness: { enabled: loudness, targetLufs: -16, truePeakDb: -1.5, lra: 11 },
      music: buildMusicPlan(m, 10000, speechR)!,
    };
  }
  async function render(p: AudioPlan, dir: string) {
    const r = (await renderExportAudio(FF, p, 10000, path.join(dir, "audio"), dir))!;
    const b = fs.readFileSync(r.file);
    return { r, x: new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4) };
  }

  it("ducks the music by depthDb under speech, recovers in the gap, level volumeDb under the speech", async () => {
    const d = tmp();
    const { r, x } = await render(plan(d, { volumeDb: -10, duck: { enabled: true, depthDb: 15, attackMs: 100, holdMs: 100, releaseMs: 400 } }), d);
    const sp = toneDb(x, 1000, 1.5, 2.5);
    const mDuck = toneDb(x, 220, 1.5, 2.5);
    const mGap = toneDb(x, 220, 4.0, 5.5);
    expect(mGap - mDuck).toBeGreaterThan(14.5);
    expect(mGap - mDuck).toBeLessThan(15.5);
    // level: the gain is the meter's speech loudness (of what the music is mixed with) - 10 - the music's loudness
    const micL = tone(1000, 0.25, 10, (t) => speechR.some((q) => t * 1000 >= q.startMs && t * 1000 < q.endMs));
    expect(r.music!.speechLufs).toBeCloseTo(integratedLoudness([micL, micL], SR), 1);
    expect(r.music!.musicLufs).toBeCloseTo(integratedLoudness([tone(220, 0.5, 2.5)], SR), 1);
    expect(20 * Math.log10(r.music!.gain)).toBeCloseTo(r.music!.speechLufs - 10 - r.music!.musicLufs, 3);
    expect(mGap).toBeCloseTo(20 * Math.log10(0.5 * r.music!.gain), 1);
    expect(sp).toBeCloseTo(20 * Math.log10(0.25), 1);
    expect(r.music!.gain).toBeGreaterThan(0);
    expect(r.music!.fileFrames).toBe(2.5 * SR);
    // the loop keeps the music going past the 2.5 s file
    expect(toneDb(x, 220, 9.0, 9.9)).toBeCloseTo(mGap, 0);
  });

  it("measures the speech after loudnorm, fades in / out, and is silent with no loop past the file", async () => {
    const d = tmp();
    const { x } = await render(plan(d, { fadeInMs: 1000, fadeOutMs: 1000, duck: { ...defaultMusic().duck, enabled: false } }, true), d);
    const full = toneDb(x, 220, 4, 5);
    expect(toneDb(x, 220, 0, 0.25)).toBeLessThan(full - 10);
    expect(toneDb(x, 220, 9.75, 10)).toBeLessThan(full - 10);
    const d2 = tmp();
    const { x: y } = await render(plan(d2, { loop: false }), d2);
    expect(toneDb(y, 220, 1.0 - 0.2, 1.0)).toBeGreaterThan(-60); // music plays while the file lasts
    expect(toneDb(y, 220, 3.5, 5)).toBeLessThan(-80); // the 2.5 s file has ended
  });

  it("music-only export (no mic): level from the reference, no ducking", async () => {
    const d = tmp();
    const p = plan(d);
    const { x } = await render({ ...p, tracks: [], music: { ...p.music!, duck: [] } }, d);
    expect(toneDb(x, 220, 2, 3)).toBeCloseTo(toneDb(x, 220, 6, 7), 1);
    expect(toneDb(x, 1000, 2, 3)).toBeLessThan(-80);
  });
});
