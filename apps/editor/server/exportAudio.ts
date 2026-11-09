/**
 * Export audio for the in-app (desktop) export, the same steps as compositor/lens_compositor/audio.py:
 *
 *   1. every track is decoded once to float PCM at the plan rate, 2 channels, by its own ffmpeg with
 *      the format pinned (aresample + aformat fltp / stereo / 48 kHz): a mono MediaRecorder Opus webm,
 *      a mono WAV, or a stream whose channel layout changes mid-way all come out the same;
 *   2. the plan pieces are laid onto the output clock here (slice, atempo for sped-up pieces, gain),
 *      streamed in 1 s blocks so memory stays flat for long recordings;
 *   3. two-pass EBU R128 loudnorm.
 *
 * The result is raw f32le, 2 channels, exactly round(frames / fps * sampleRate) samples long, which
 * the export muxes next to the encoded video (no audio filter graph in the video encoder).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AudioPlan } from "../../../packages/engine/src/index";

export const CHANNELS = 2;
const BYTES = 4 * CHANNELS; // one f32 stereo frame
export const PIN = (sr: number) => `aresample=${sr},aformat=sample_fmts=flt:channel_layouts=stereo:sample_rates=${sr}`;

// ---------------------------------------------------------------- ffmpeg helpers

function run(ffmpeg: string, args: string[], opts: { cwd?: string; stdout?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { cwd: opts.cwd });
    let err = "";
    const out = opts.stdout ? fs.createWriteStream(opts.stdout) : null;
    if (out) p.stdout.pipe(out);
    else p.stdout.resume();
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => {
      const done = () => (code === 0 ? resolve(err) : reject(new Error(`ffmpeg ${args.filter((a) => a.startsWith("-af") || a.includes("=")).join(" ").slice(0, 200)} failed (${code}): ${err.trim().split("\n").slice(-4).join("\n")}`)));
      if (out) out.end(done);
      else done();
    });
  });
}

/** Decode any audio (or a video's audio) to f32le stereo at sr, format pinned before anything else. */
export async function decodeToRaw(ffmpeg: string, input: string, sr: number, out: string): Promise<number> {
  await run(ffmpeg, ["-v", "error", "-nostdin", "-y", "-i", input, "-vn", "-af", PIN(sr), "-f", "f32le", "-c:a", "pcm_f32le", "-ac", "2", "-ar", String(sr), out]);
  return Math.floor(fs.statSync(out).size / BYTES);
}

/** Pipe a Float32 interleaved stereo block through an ffmpeg filter chain (raw in, raw out). */
function filterBlock(ffmpeg: string, x: Float32Array, sr: number, af: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ["-v", "error", "-nostdin", "-f", "f32le", "-ar", String(sr), "-ac", "2", "-i", "pipe:0", "-af", `${af},${PIN(sr)}`, "-f", "f32le", "-ac", "2", "-ar", String(sr), "pipe:1"]);
    const chunks: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (d: Buffer) => chunks.push(d));
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.stdin.on("error", () => undefined);
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg ${af} failed: ${err.slice(-300)}`));
      const b = Buffer.concat(chunks);
      resolve(new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)).slice());
    });
    p.stdin.end(Buffer.from(x.buffer, x.byteOffset, x.byteLength));
  });
}

/** ffmpeg filter chain for a playback rate (atempo takes 0.5..100 per stage). */
export function atempoStages(rate: number): string {
  const stages: number[] = [];
  let r = rate;
  while (r < 0.5) {
    stages.push(0.5);
    r /= 0.5;
  }
  while (r > 100) {
    stages.push(100);
    r /= 100;
  }
  stages.push(r);
  return stages.map((s) => `atempo=${s.toFixed(6)}`).join(",");
}

// ---------------------------------------------------------------- laying pieces

interface RawTrack {
  fd: number;
  frames: number;
  /** recording-clock sample index of the file's first sample */
  offset: number;
  volume: number;
}

/** Recording-clock samples [s0, s1) of the sum of all tracks (silence outside each file). */
function readSum(tracks: RawTrack[], s0: number, s1: number): Float32Array {
  const n = Math.max(0, s1 - s0);
  const out = new Float32Array(n * 2);
  const buf = Buffer.alloc(n * BYTES);
  for (const t of tracks) {
    const a = s0 - t.offset;
    const fa = Math.max(0, a);
    const fb = Math.min(t.frames, s1 - t.offset);
    if (fb <= fa) continue;
    const got = fs.readSync(t.fd, buf, 0, (fb - fa) * BYTES, fa * BYTES);
    const f = new Float32Array(buf.buffer, buf.byteOffset, got / 4);
    const at = (fa - a) * 2;
    for (let i = 0; i < f.length; i++) out[at + i]! += f[i]! * t.volume;
  }
  return out;
}

const BLOCK = 48000; // samples per streamed block

async function layPieces(ffmpeg: string, audio: AudioPlan, tracks: RawTrack[], outFd: number, nOut: number): Promise<void> {
  const sr = audio.sampleRate;
  for (let i = 0; i < audio.pieces.length; i++) {
    const p = audio.pieces[i]!;
    const s0 = Math.round((p.srcStart * sr) / 1000);
    const s1 = Math.round((p.srcEnd * sr) / 1000);
    const o0 = Math.round((p.outStart * sr) / 1000);
    const o1 = Math.min(nOut, Math.round((p.outEnd * sr) / 1000));
    if (o1 <= o0 || s1 <= s0 || tracks.length === 0) continue;
    const len = o1 - o0;
    const env = (_k: number) => p.gain;
    const write = (block: Float32Array, k0: number) => {
      const n = Math.min(block.length / 2, len - k0);
      if (n <= 0) return;
      for (let k = 0; k < n; k++) {
        const g = env(k0 + k);
        block[2 * k]! *= g;
        block[2 * k + 1]! *= g;
      }
      fs.writeSync(outFd, Buffer.from(block.buffer, block.byteOffset, n * BYTES), 0, n * BYTES, (o0 + k0) * BYTES);
    };
    if (Math.abs(p.rate - 1) < 1e-6) {
      for (let k = 0; k < len; k += BLOCK) write(readSum(tracks, s0 + k, Math.min(s1, s0 + Math.min(len, k + BLOCK))), k);
    } else {
      // time-stretch the whole piece (sped-up pieces are typing / manual speed ranges); fit to len
      const src = readSum(tracks, s0, s1);
      const st = await filterBlock(ffmpeg, src, sr, atempoStages(p.rate));
      const fit = new Float32Array(len * 2);
      fit.set(st.subarray(0, Math.min(st.length, fit.length)));
      for (let k = 0; k < len; k += BLOCK) write(fit.slice(2 * k, 2 * Math.min(len, k + BLOCK)), k);
    }
  }
}

// ---------------------------------------------------------------- cleanup

const RAW_IN = (sr: number, f: string) => ["-f", "f32le", "-ar", String(sr), "-ac", "2", "-i", f];

async function cleanup(ffmpeg: string, audio: AudioPlan, laid: string, frames: number, root: string, out: string): Promise<string> {
  const sr = audio.sampleRate;
  const chain: string[] = [];
  const cwd: string | undefined = undefined;
  void frames;
  void root;
  const L = audio.loudness;
  if (L.enabled) {
    const base = `loudnorm=I=${L.targetLufs}:TP=${L.truePeakDb}:LRA=${L.lra}`;
    const err = await run(ffmpeg, ["-v", "info", "-nostdin", "-hide_banner", ...RAW_IN(sr, laid), "-af", [...chain, base + ":print_format=json"].join(","), "-f", "null", "-"], { cwd });
    const m = /\{[^{}]*"input_i"[^{}]*\}/s.exec(err);
    if (!m) throw new Error("loudnorm pass 1 printed no measurement");
    const meas = JSON.parse(m[0]) as Record<string, string>;
    const inI = Number(meas.input_i);
    if (Number.isFinite(inI) && inI >= -70) {
      chain.push(`${base}:measured_I=${meas.input_i}:measured_TP=${meas.input_tp}:measured_LRA=${meas.input_lra}:measured_thresh=${meas.input_thresh}:offset=${meas.target_offset}:linear=true`);
    }
  }
  if (!chain.length) return laid;
  chain.push(PIN(sr));
  await run(ffmpeg, ["-v", "error", "-nostdin", "-y", ...RAW_IN(sr, laid), "-af", chain.join(","), "-f", "f32le", "-c:a", "pcm_f32le", "-ac", "2", "-ar", String(sr), out], { cwd });
  return out;
}

export interface RenderedAudio {
  /** raw f32le, 2 channels, sampleRate */
  file: string;
  sampleRate: number;
  frames: number;
}

/**
 * Render the plan's audio into `dir`. `outMs` is the output length (frames / fps), so audio and video
 * end together. Returns null when the plan has nothing audible.
 */
export async function renderExportAudio(ffmpeg: string, audio: AudioPlan | null, outMs: number, dir: string, root: string): Promise<RenderedAudio | null> {
  if (!audio) return null;
  if (!audio.tracks.length) return null;
  const sr = audio.sampleRate;
  const nOut = Math.max(1, Math.round((outMs * sr) / 1000));
  fs.mkdirSync(dir, { recursive: true });
  const tracks: RawTrack[] = [];
  try {
    for (const [i, t] of audio.tracks.entries()) {
      const raw = path.join(dir, `track${i}.f32`);
      const frames = await decodeToRaw(ffmpeg, t.path, sr, raw);
      tracks.push({ fd: fs.openSync(raw, "r"), frames, offset: Math.round((t.offsetMs * sr) / 1000), volume: t.volume });
    }
    const laid = path.join(dir, "laid.f32");
    const outFd = fs.openSync(laid, "w+");
    fs.ftruncateSync(outFd, nOut * BYTES);
    try {
      await layPieces(ffmpeg, audio, tracks, outFd, nOut);
    } finally {
      fs.closeSync(outFd);
    }
    const file = tracks.length ? await cleanup(ffmpeg, audio, laid, nOut, root, path.join(dir, "clean.f32")) : laid;
    // exact length (filters may add or drop a few samples at the end)
    const fd = fs.openSync(file, "r+");
    fs.ftruncateSync(fd, nOut * BYTES);
    fs.closeSync(fd);
    if (file !== laid) fs.rmSync(laid, { force: true });
    return { file, sampleRate: sr, frames: nOut };
  } finally {
    for (const [i, t] of tracks.entries()) {
      fs.closeSync(t.fd);
      fs.rmSync(path.join(dir, `track${i}.f32`), { force: true });
    }
  }
}

/** Mux the encoded video with the rendered audio (video copied, AAC 160k). */
export function muxArgs(video: string, audio: RenderedAudio, out: string, durationMs: number): string[] {
  return ["-v", "error", "-nostdin", "-y", "-i", video, ...RAW_IN(audio.sampleRate, audio.file), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
    "-c:a", "aac", "-b:a", "160k", "-t", (durationMs / 1000).toFixed(6), "-movflags", "+faststart", out];
}

export function mux(ffmpeg: string, video: string, audio: RenderedAudio, out: string, durationMs: number): Promise<string> {
  return run(ffmpeg, muxArgs(video, audio, out, durationMs));
}
