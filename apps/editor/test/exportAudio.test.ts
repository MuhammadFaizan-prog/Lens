/**
 * Export audio regressions (Windows v0.1.0 bugs #10 and #16, docs/Tracker.md):
 * - a real Chromium MediaRecorder mono Opus webm (test/fixtures/audio/mono-opus.webm, made by
 *   scripts/make_mediarecorder_fixtures.mjs) and a stream whose channel layout changes mid-way
 *   (ADTS AAC, mono then stereo) export, through the pinned filter graph and the export path;
 * - A/V durations of the exported MP4 agree within 0.1 s;
 * - noise reduction: noise floor in silent stretches drops >= 10 dB, speech level within 1 dB;
 * - click sounds and 3 ms fades at cuts are back (they were missing from the in-app export).
 * LENS_TEST_FFMPEG6 (the ffmpeg-static b6.0 build the Windows installer ships, for this machine's
 * arch) is used for the graph check when set: ffmpeg 6.0 is the version that failed.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AudioPlan, RenderPlan } from "@lens/engine";
import { audioFilterGraph, finishBrowserExport, startBrowserExport, writeFrame } from "../server/browserExport";
import { cutJoins, renderExportAudio, synthClick } from "../server/exportAudio";

const FF = "ffmpeg";
const FF6 = process.env.LENS_TEST_FFMPEG6 && fs.existsSync(process.env.LENS_TEST_FFMPEG6) ? process.env.LENS_TEST_FFMPEG6 : null;
const hasFfmpeg = spawnSync(FF, ["-version"]).status === 0;
const hasEspeak = spawnSync("espeak-ng", ["--version"]).status === 0;
const ROOT = path.resolve(__dirname, "..", "..", "..");
const FIX = path.join(__dirname, "fixtures", "audio");
const SR = 48000;

function audioPlan(over: Partial<AudioPlan> = {}): AudioPlan {
  return {
    sampleRate: SR,
    durationMs: 4000,
    tracks: [],
    pieces: [{ srcStart: 0, srcEnd: 4000, rate: 1, outStart: 0, outEnd: 4000, gain: 1 }],
    clickSound: { enabled: false, volume: 0, times: [] },
    noiseReduction: { enabled: false, amountDb: 12 },
    loudness: { enabled: false, targetLufs: -16, truePeakDb: -1.5, lra: 11 },
    ...over,
  };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lens-xa-"));

function pcm(file: string, ch = 1): Float32Array {
  const b = spawnSync(FF, ["-v", "error", "-i", file, "-f", "f32le", "-ac", String(ch), "-ar", String(SR), "-"], { maxBuffer: 1 << 28 }).stdout as Buffer;
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}
function rawPcm(file: string): Float32Array {
  const b = fs.readFileSync(file);
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}
const db = (x: number) => 20 * Math.log10(x + 1e-12);
function rmsMono(s: Float32Array, a: number, b: number, stride = 1): number {
  let acc = 0;
  let n = 0;
  for (let i = Math.round(a * SR); i < Math.round(b * SR); i++) {
    let v = 0;
    for (let c = 0; c < stride; c++) v += s[i * stride + c]!;
    v /= stride;
    acc += v * v;
    n++;
  }
  return Math.sqrt(acc / Math.max(1, n));
}

/** mono AAC for 2 s then stereo AAC for 2 s in one ADTS stream: the decoder changes layout mid-way. */
function layoutChangeFixture(dir: string): string {
  const a = path.join(dir, "a.aac");
  const b = path.join(dir, "b.aac");
  expect(spawnSync(FF, ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=2:sample_rate=48000", "-ac", "1", "-c:a", "aac", "-f", "adts", a]).status).toBe(0);
  expect(spawnSync(FF, ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=660:d=2:sample_rate=44100", "-ac", "2", "-c:a", "aac", "-f", "adts", b]).status).toBe(0);
  const out = path.join(dir, "layout-change.aac");
  fs.writeFileSync(out, Buffer.concat([fs.readFileSync(a), fs.readFileSync(b)]));
  return out;
}

function probe(file: string): { v: number; a: number } {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", file], { encoding: "utf8" });
  const st = JSON.parse(r.stdout).streams as Array<{ codec_type: string; duration: string }>;
  return { v: Number(st.find((s) => s.codec_type === "video")?.duration), a: Number(st.find((s) => s.codec_type === "audio")?.duration) };
}

async function exportWith(audio: AudioPlan, seconds: number, fps = 30): Promise<{ out: string; error?: string; secs: number }> {
  const dir = tmp();
  const jpg = path.join(dir, "f.jpg");
  expect(spawnSync(FF, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x334455:s=320x180", "-frames:v", "1", jpg]).status).toBe(0);
  const frame = fs.readFileSync(jpg);
  const n = Math.round(seconds * fps);
  const plan = { output: { width: 320, height: 180, fps, durationMs: seconds * 1000 }, frames: new Array(n).fill({}), audio } as unknown as RenderPlan;
  const t0 = Date.now();
  // the export runs on ffmpeg 6.0 (what the installer ships) when it is available
  const job = startBrowserExport(FF6 ?? FF, plan, path.join(dir, "x"), "t", ROOT);
  for (let i = 0; i < n; i++) await writeFrame(job, i, frame);
  finishBrowserExport(job);
  while (job.state === "running") await new Promise((r) => setTimeout(r, 50));
  return { out: job.out, error: job.error, secs: (Date.now() - t0) / 1000 };
}

describe.skipIf(!hasFfmpeg)("export audio (desktop, no Python)", () => {
  const plans = (track: string, loud: boolean): AudioPlan[] => {
    const tracks = [{ id: "mic", kind: "mic" as const, path: track, offsetMs: 120, volume: 1 }];
    const L = { enabled: loud, targetLufs: -16, truePeakDb: -1.5, lra: 11 };
    return [
      audioPlan({ tracks, loudness: L, pieces: [{ srcStart: 0, srcEnd: 4000, rate: 1, outStart: 0, outEnd: 4000, gain: 1 }] }),
      audioPlan({ tracks, loudness: L, durationMs: 3000, pieces: [
        { srcStart: 0, srcEnd: 1500, rate: 1, outStart: 0, outEnd: 1500, gain: 1 },
        { srcStart: 2000, srcEnd: 3000, rate: 2, outStart: 1500, outEnd: 2000, gain: 1 },
        { srcStart: 3000, srcEnd: 4000, rate: 1, outStart: 2000, outEnd: 3000, gain: 0.5 },
      ] }),
    ];
  };

  it("pinned graph: every input, piece and the loudnorm output pass through aformat fltp/stereo/48k", () => {
    const g = audioFilterGraph(plans("/x.wav", true)[1]!)!;
    const pin = "aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=48000";
    expect(g.startsWith(`[1:a]aresample=48000,${pin}`)).toBe(true);
    for (const seg of g.split(";").filter((s) => /^\[s\d\]/.test(s))) {
      expect(seg.indexOf(pin)).toBeLessThan(seg.indexOf("apad"));
      expect(seg.lastIndexOf(pin)).toBeLessThan(seg.indexOf("adelay"));
    }
    // no aresample is followed directly by apad any more (the v0.1.0 failure)
    expect(g).not.toMatch(/aresample=\d+,apad/);
  });

  for (const ff of [FF, ...(FF6 ? [FF6] : [])]) {
    it(`pinned graph runs on the mono Opus webm and the layout change (${ff === FF ? "system ffmpeg" : "ffmpeg 6.0 static"})`, () => {
      const dir = tmp();
      for (const src of [path.join(FIX, "mono-opus.webm"), layoutChangeFixture(dir)]) {
        for (const loud of [false, true]) {
          for (const p of plans(src, loud)) {
            const g = audioFilterGraph(p)!;
            const out = path.join(dir, "g.m4a");
            const r = spawnSync(ff, ["-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=0.1", "-i", src, "-filter_complex", g, "-map", "[aout]", "-c:a", "aac", out], { encoding: "utf8", timeout: 60000 });
            expect(r.status, `${path.basename(src)} loud=${loud}: ${r.stderr}`).toBe(0);
          }
        }
      }
    });
  }

  it("mono Opus mic: the export succeeds and A/V durations agree within 0.1 s", async () => {
    const p = plans(path.join(FIX, "mono-opus.webm"), true)[1]!;
    const r = await exportWith(p, 3);
    expect(r.error).toBeUndefined();
    const d = probe(r.out);
    console.log(`[mono-opus export] video ${d.v.toFixed(3)} s, audio ${d.a.toFixed(3)} s, |A-V| ${Math.abs(d.a - d.v).toFixed(3)} s`);
    expect(Math.abs(d.v - 3)).toBeLessThan(0.05);
    expect(Math.abs(d.a - d.v)).toBeLessThanOrEqual(0.1);
    const s = pcm(r.out);
    expect(rmsMono(s, 0.3, 1.2)).toBeGreaterThan(0.01); // the mic is audible
  });

  it("layout change mid-stream: the export succeeds, both halves audible, A/V within 0.1 s", async () => {
    const src = layoutChangeFixture(tmp());
    const p = audioPlan({ tracks: [{ id: "mic", kind: "mic", path: src, offsetMs: 0, volume: 1 }], loudness: { enabled: true, targetLufs: -16, truePeakDb: -1.5, lra: 11 } });
    const r = await exportWith(p, 4);
    expect(r.error).toBeUndefined();
    const d = probe(r.out);
    console.log(`[layout-change export] video ${d.v.toFixed(3)} s, audio ${d.a.toFixed(3)} s, |A-V| ${Math.abs(d.a - d.v).toFixed(3)} s`);
    expect(Math.abs(d.a - d.v)).toBeLessThanOrEqual(0.1);
    const s = pcm(r.out);
    expect(rmsMono(s, 0.3, 1.7)).toBeGreaterThan(0.02);
    expect(rmsMono(s, 2.3, 3.7)).toBeGreaterThan(0.02);
  });

  it("3 ms fades at cuts: no step at the join, none inside an uncut piece split", async () => {
    // square-ish loud tone: a hard cut in the middle of a period would leave a big step
    const dir = tmp();
    const src = path.join(dir, "tone.wav");
    expect(spawnSync(FF, ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=97:d=4:sample_rate=48000", "-af", "volume=6", src]).status).toBe(0);
    const p = audioPlan({ tracks: [{ id: "mic", kind: "mic", path: src, offsetMs: 0, volume: 1 }], durationMs: 2000, pieces: [
      { srcStart: 0, srcEnd: 1003, rate: 1, outStart: 0, outEnd: 1003, gain: 1 },
      { srcStart: 2511, srcEnd: 3508, rate: 1, outStart: 1003, outEnd: 2000, gain: 1 },
    ] });
    expect(cutJoins(p.pieces)).toEqual([{ cutBefore: false, cutAfter: true }, { cutBefore: true, cutAfter: false }]);
    const a = await renderExportAudio(FF, p, 2000, path.join(dir, "a"), ROOT);
    const s = rawPcm(a!.file);
    const j = Math.round(1.003 * SR);
    // the samples on both sides of the join are ~0 (faded), and the 3 ms ramps exist
    expect(Math.abs(s[2 * (j - 1)]!)).toBeLessThan(0.01);
    expect(Math.abs(s[2 * j]!)).toBeLessThan(0.01);
    let maxStep = 0;
    for (let i = j - 400; i < j + 400; i++) maxStep = Math.max(maxStep, Math.abs(s[2 * (i + 1)]! - s[2 * i]!));
    expect(maxStep).toBeLessThan(0.05); // a 97 Hz tone at amplitude ~0.75 steps <= 0.01 per sample; an unfaded cut here steps ~0.5
  });

  it("click sounds at the click times", async () => {
    const dir = tmp();
    const p = audioPlan({ tracks: [], clickSound: { enabled: true, volume: 0.5, times: [500, 1500] }, durationMs: 2000 });
    const a = await renderExportAudio(FF, p, 2000, path.join(dir, "a"), ROOT);
    expect(a).not.toBeNull();
    const s = rawPcm(a!.file);
    expect(s.length / 2).toBe(2 * SR);
    const click = synthClick(SR);
    expect(click.length).toBe(1440);
    expect(db(rmsMono(s, 0.5, 0.515, 2))).toBeGreaterThan(-25);
    expect(db(rmsMono(s, 1.5, 1.515, 2))).toBeGreaterThan(-25);
    expect(rmsMono(s, 0.6, 1.4, 2)).toBe(0);
  });

  it.skipIf(!hasEspeak)("noise reduction: floor in pauses drops >= 10 dB, speech level within 1 dB", async () => {
    const dir = tmp();
    const say = (t: string, f: string) => expect(spawnSync("espeak-ng", ["-v", "en-us", "-s", "150", "-w", f, t]).status).toBe(0);
    const lines = ["The quick brown fox jumps over the lazy dog.", "Open the settings panel and choose a folder.", "Then press record to start the capture."];
    const speech: Float32Array[] = lines.map((t, i) => {
      const f = path.join(dir, `s${i}.wav`);
      say(t, f);
      return pcm(f);
    });
    const gap = 2 * SR;
    const total = speech.reduce((n, x) => n + x.length + gap, gap);
    const clean = new Float32Array(total);
    const spans: Array<[number, number]> = [];
    let pos = gap;
    for (const x of speech) {
      clean.set(x, pos);
      spans.push([pos / SR, (pos + x.length) / SR]);
      pos += x.length + gap;
    }
    let peak = 0;
    for (const v of clean) peak = Math.max(peak, Math.abs(v));
    // hiss + fan rumble + 50 Hz hum, about -44 dBFS
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
    let fan = 0;
    const noisy = new Float32Array(total);
    for (let i = 0; i < total; i++) {
      fan = 0.95 * fan + rnd();
      noisy[i] = (clean[i]! / peak) * 0.5 + 0.007 * rnd() + 0.0015 * fan + 0.002 * Math.sin((2 * Math.PI * 50 * i) / SR);
    }
    const src = path.join(dir, "noisy.f32");
    fs.writeFileSync(src, Buffer.from(noisy.buffer));
    const wav = path.join(dir, "noisy.wav");
    expect(spawnSync(FF, ["-v", "error", "-y", "-f", "f32le", "-ar", String(SR), "-ac", "1", "-i", src, "-c:a", "pcm_s16le", wav]).status).toBe(0);
    const ms = (total * 1000) / SR;
    const base = { tracks: [{ id: "mic", kind: "mic" as const, path: wav, offsetMs: 0, volume: 1 }], durationMs: ms, pieces: [{ srcStart: 0, srcEnd: ms, rate: 1, outStart: 0, outEnd: ms, gain: 1 }] };
    const off = await renderExportAudio(FF, audioPlan(base), ms, path.join(dir, "off"), ROOT);
    const on = await renderExportAudio(FF, audioPlan({ ...base, noiseReduction: { enabled: true, amountDb: 12 } }), ms, path.join(dir, "on"), ROOT);
    const a = rawPcm(off!.file);
    const b = rawPcm(on!.file);
    const quiet: Array<[number, number]> = [[0.3, spans[0]![0] - 0.3], ...spans.slice(0, -1).map((s, i) => [s[1] + 0.3, spans[i + 1]![0] - 0.3] as [number, number])];
    const lvl = (x: Float32Array, rs: Array<[number, number]>) => rs.reduce((acc, [s, e]) => acc + db(rmsMono(x, s, e, 2)), 0) / rs.length;
    const floorDrop = lvl(a, quiet) - lvl(b, quiet);
    const speechDiff = lvl(b, spans) - lvl(a, spans);
    console.log(`[denoise] floor ${lvl(a, quiet).toFixed(1)} -> ${lvl(b, quiet).toFixed(1)} dBFS (drop ${floorDrop.toFixed(1)} dB), speech ${lvl(a, spans).toFixed(2)} -> ${lvl(b, spans).toFixed(2)} dBFS (${speechDiff.toFixed(2)} dB)`);
    expect(floorDrop).toBeGreaterThanOrEqual(10);
    expect(Math.abs(speechDiff)).toBeLessThanOrEqual(1);
  });
});
