/**
 * Export audio for the in-app (desktop) export, the same steps as compositor/lens_compositor/audio.py:
 *
 *   1. every track is decoded once to float PCM at the plan rate, 2 channels, by its own ffmpeg with
 *      the format pinned (aresample + aformat fltp / stereo / 48 kHz): a mono MediaRecorder Opus webm,
 *      a mono WAV, or a stream whose channel layout changes mid-way all come out the same;
 *   2. the plan pieces are laid onto the output clock here (slice, atempo for sped-up pieces, gain,
 *      3 ms fades at every cut), streamed in 1 s blocks so memory stays flat for long recordings;
 *   3. noise reduction (ffmpeg arnndn with the bundled RNNoise model; afftdn with a measured noise
 *      floor when no model is found) and two-pass EBU R128 loudnorm;
 *   4. the synthesized click sound at every click's output time.
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

// ---------------------------------------------------------------- click sound (Lens design, as audio.py)

/** Small deterministic PRNG (mulberry32) for the click's noise transient. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A short soft "tick": two damped partials plus a short high-passed noise attack; mono, peak 0.9. */
export function synthClick(sr = 48000, ms = 30): Float32Array {
  const n = Math.floor((sr * ms) / 1000);
  const r = rng(20261109);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  const noise = new Float64Array(n + 1).map(() => gauss());
  const x = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const body = Math.exp(-t / 0.0038);
    const snap = Math.exp(-t / 0.0009);
    let v = 0.55 * Math.sin(2 * Math.PI * 1870 * t) * body + 0.28 * Math.sin(2 * Math.PI * 3320 * t + 0.6) * body + 0.3 * (noise[i + 1]! - noise[i]!) * snap;
    v *= Math.min(1, t / 0.0003);
    x[i] = v;
    peak = Math.max(peak, Math.abs(v));
  }
  for (let i = 0; i < n; i++) x[i] = (x[i]! * 0.9) / peak;
  return x;
}

// ---------------------------------------------------------------- ffmpeg helpers

function run(ffmpeg: string, args: string[], opts: { cwd?: string; stdout?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { cwd: opts.cwd, windowsHide: true });
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
    const p = spawn(ffmpeg, ["-v", "error", "-nostdin", "-f", "f32le", "-ar", String(sr), "-ac", "2", "-i", "pipe:0", "-af", `${af},${PIN(sr)}`, "-f", "f32le", "-ac", "2", "-ar", String(sr), "pipe:1"], { windowsHide: true });
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

export interface LaidPiece {
  o0: number;
  o1: number;
  cutBefore: boolean;
  cutAfter: boolean;
}

/** Which joins are cuts (the source jumps or the output has a gap), as audio.py. */
export function cutJoins(pieces: AudioPlan["pieces"]): Array<{ cutBefore: boolean; cutAfter: boolean }> {
  return pieces.map((p, i) => {
    const prev = pieces[i - 1];
    const next = pieces[i + 1];
    return {
      cutBefore: !!prev && (Math.abs(prev.srcEnd - p.srcStart) > 0.5 || Math.abs(prev.outEnd - p.outStart) > 0.5),
      cutAfter: !!next && (Math.abs(next.srcStart - p.srcEnd) > 0.5 || Math.abs(next.outStart - p.outEnd) > 0.5),
    };
  });
}

const BLOCK = 48000; // samples per streamed block

async function layPieces(ffmpeg: string, audio: AudioPlan, tracks: RawTrack[], outFd: number, nOut: number): Promise<void> {
  const sr = audio.sampleRate;
  const fade = Math.max(1, Math.round(0.003 * sr));
  const joins = cutJoins(audio.pieces);
  for (let i = 0; i < audio.pieces.length; i++) {
    const p = audio.pieces[i]!;
    const s0 = Math.round((p.srcStart * sr) / 1000);
    const s1 = Math.round((p.srcEnd * sr) / 1000);
    const o0 = Math.round((p.outStart * sr) / 1000);
    const o1 = Math.min(nOut, Math.round((p.outEnd * sr) / 1000));
    if (o1 <= o0 || s1 <= s0 || tracks.length === 0) continue;
    const len = o1 - o0;
    const f = Math.min(fade, Math.floor(len / 2));
    const { cutBefore, cutAfter } = joins[i]!;
    // per-sample envelope at the piece's edges (3 ms linear fades at cuts) and its gain
    const env = (k: number) => {
      let g = p.gain;
      if (f > 0 && cutBefore && k < f) g *= k / Math.max(1, f - 1);
      if (f > 0 && cutAfter && k >= len - f) g *= (len - 1 - k) / Math.max(1, f - 1);
      return g;
    };
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

/** Noise floor estimate: 10th percentile of 50 ms RMS windows (dBFS), skipping digital silence (as audio.py). */
export function noiseFloorDb(fd: number, frames: number, sr: number): number {
  const w = Math.max(1, Math.round(sr * 0.05));
  const buf = Buffer.alloc(w * BYTES);
  const levels: number[] = [];
  for (let s = 0; s + w <= frames; s += w) {
    fs.readSync(fd, buf, 0, w * BYTES, s * BYTES);
    const f = new Float32Array(buf.buffer, buf.byteOffset, w * 2);
    let acc = 0;
    for (let i = 0; i < w; i++) {
      const m = (f[2 * i]! + f[2 * i + 1]!) / 2;
      acc += m * m;
    }
    const rms = Math.sqrt(acc / w);
    if (rms > 1e-6) levels.push(rms);
  }
  if (!levels.length) return -80;
  levels.sort((a, b) => a - b);
  return 20 * Math.log10(levels[Math.floor(0.1 * (levels.length - 1))]!);
}

/** The RNNoise model bundled for arnndn (assets/models/rnnoise/sh.rnnn, fetched by scripts/fetch-models.mjs), or null. */
export function rnnoiseModel(root: string): string | null {
  for (const p of [process.env.LENS_RNNOISE_MODEL, path.join(root, "assets", "models", "rnnoise", "sh.rnnn")]) if (p && fs.existsSync(p)) return p;
  return null;
}

/**
 * The denoise filter: RNNoise (arnndn) with the bundled model, run from the model's folder so the
 * filter argument is a bare file name (a Windows path's drive colon would need filtergraph escaping);
 * mix scales with the project's amount (12 dB and up = full RNNoise). Without a model: afftdn with the
 * measured noise floor (audio.py's method).
 */
export function denoiseFilter(amountDb: number, model: string | null, floorDb: number): { af: string; cwd?: string } {
  if (model) {
    const mix = Math.max(0.05, Math.min(1, amountDb / 12));
    return { af: `arnndn=m=${path.basename(model)}:mix=${mix.toFixed(3)}`, cwd: path.dirname(model) };
  }
  const nr = Math.max(0.01, Math.min(97, amountDb));
  const nf = Math.max(-80, Math.min(-20, Math.round(floorDb)));
  return { af: `afftdn=nr=${nr}:nf=${nf}`, cwd: undefined };
}

const RAW_IN = (sr: number, f: string) => ["-f", "f32le", "-ar", String(sr), "-ac", "2", "-i", f];

async function cleanup(ffmpeg: string, audio: AudioPlan, laid: string, frames: number, root: string, out: string): Promise<string> {
  const sr = audio.sampleRate;
  const chain: string[] = [];
  let cwd: string | undefined;
  if (audio.noiseReduction.enabled) {
    const fd = fs.openSync(laid, "r");
    const floor = noiseFloorDb(fd, frames, sr);
    fs.closeSync(fd);
    const d = denoiseFilter(audio.noiseReduction.amountDb, rnnoiseModel(root), floor);
    chain.push(d.af);
    cwd = d.cwd;
  }
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

function addClicks(file: string, audio: AudioPlan, nOut: number): void {
  const cs = audio.clickSound;
  if (!cs.enabled || !cs.times.length) return;
  const sr = audio.sampleRate;
  const click = synthClick(sr).map((v) => v * cs.volume);
  const fd = fs.openSync(file, "r+");
  const buf = Buffer.alloc(click.length * BYTES);
  for (const t of cs.times) {
    const i = Math.round((t * sr) / 1000);
    if (i >= nOut) continue;
    const n = Math.min(click.length, nOut - i);
    fs.readSync(fd, buf, 0, n * BYTES, i * BYTES);
    const f = new Float32Array(buf.buffer, buf.byteOffset, n * 2);
    for (let k = 0; k < n; k++) {
      f[2 * k] = Math.max(-1, Math.min(1, f[2 * k]! + click[k]!));
      f[2 * k + 1] = Math.max(-1, Math.min(1, f[2 * k + 1]! + click[k]!));
    }
    fs.writeSync(fd, buf, 0, n * BYTES, i * BYTES);
  }
  fs.closeSync(fd);
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
  const hasClicks = audio.clickSound.enabled && audio.clickSound.times.length > 0;
  if (!audio.tracks.length && !hasClicks) return null;
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
    let file = tracks.length ? await cleanup(ffmpeg, audio, laid, nOut, root, path.join(dir, "clean.f32")) : laid;
    // exact length (filters may add or drop a few samples at the end)
    const fd = fs.openSync(file, "r+");
    fs.ftruncateSync(fd, nOut * BYTES);
    fs.closeSync(fd);
    addClicks(file, audio, nOut);
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
