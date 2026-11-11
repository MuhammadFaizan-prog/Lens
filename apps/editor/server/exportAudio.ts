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
 *   4. the music bed (demand #23): the file looped on the output clock, put `volumeDb` under the
 *      cleaned speech (both measured with the engine's BS.1770 meter, the same function the preview
 *      uses), times the plan's duck and fade envelopes (engine music.ts), added after the denoise so
 *      RNNoise never sees the music;
 *   5. the synthesized click sound at every click's output time.
 *
 * The result is raw f32le, 2 channels, exactly round(frames / fps * sampleRate) samples long, which
 * the export muxes next to the encoded video (no audio filter graph in the video encoder).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AudioPlan } from "../../../packages/engine/src/index";
import { applyEnvelope, LoudnessMeter, musicLevelGain } from "../../../packages/engine/src/index";

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

/** Integrated loudness of a raw f32le stereo file (streamed). */
export function fileLoudness(file: string, frames: number, sr: number): number {
  const m = new LoudnessMeter(sr, 2);
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(BLOCK * BYTES);
  try {
    for (let s = 0; s < frames; s += BLOCK) {
      const n = Math.min(BLOCK, frames - s);
      const got = fs.readSync(fd, buf, 0, n * BYTES, s * BYTES);
      m.pushInterleaved(new Float32Array(buf.buffer, buf.byteOffset, got / 4));
    }
  } finally {
    fs.closeSync(fd);
  }
  return m.integrated();
}

/** What the music mix used (logged next to the export, read by the e2e). */
export interface MusicMixInfo {
  speechLufs: number;
  musicLufs: number;
  gain: number;
  fileFrames: number;
}

/**
 * Add the plan's music bed into `file` (raw f32le stereo, nOut frames, already cleaned): decoded once
 * with the format pinned, looped from startMs on the output clock, level from the two loudness
 * measurements, duck x fade envelopes from the plan, clamped to [-1, 1].
 */
export async function mixMusic(ffmpeg: string, audio: AudioPlan, file: string, nOut: number, dir: string, speechLufs: number): Promise<MusicMixInfo | null> {
  const m = audio.music;
  if (!m) return null;
  const sr = audio.sampleRate;
  const raw = path.join(dir, "music.f32");
  try {
    const frames = await decodeToRaw(ffmpeg, m.path, sr, raw);
    if (frames <= 0) return null;
    const musicLufs = fileLoudness(raw, frames, sr);
    const ref = audio.loudness.enabled ? audio.loudness.targetLufs : -16;
    const gain = musicLevelGain(speechLufs, musicLufs, m.volumeDb, ref);
    const info = { speechLufs, musicLufs, gain, fileFrames: frames };
    if (gain <= 0) return info;
    const start = Math.round((m.startMs * sr) / 1000);
    const mfd = fs.openSync(raw, "r");
    const ofd = fs.openSync(file, "r+");
    const ob = Buffer.alloc(BLOCK * BYTES);
    const mb = Buffer.alloc(BLOCK * BYTES);
    try {
      for (let o = 0; o < nOut; o += BLOCK) {
        const n = Math.min(BLOCK, nOut - o);
        // the music samples for output [o, o + n): wrap around the file when looping
        const mus = new Float32Array(n * 2);
        let filled = 0;
        while (filled < n) {
          let p = start + o + filled;
          if (m.loop) p %= frames;
          else if (p >= frames) break;
          const take = Math.min(n - filled, frames - p);
          const got = fs.readSync(mfd, mb, 0, take * BYTES, p * BYTES);
          mus.set(new Float32Array(mb.buffer, mb.byteOffset, got / 4), filled * 2);
          filled += take;
        }
        const t0 = (o * 1000) / sr;
        const dt = 1000 / sr;
        applyEnvelope(m.duck, t0, dt, mus, 2);
        applyEnvelope(m.fade, t0, dt, mus, 2);
        fs.readSync(ofd, ob, 0, n * BYTES, o * BYTES);
        const out = new Float32Array(ob.buffer, ob.byteOffset, n * 2);
        for (let i = 0; i < n * 2; i++) out[i] = Math.max(-1, Math.min(1, out[i]! + mus[i]! * gain));
        fs.writeSync(ofd, ob, 0, n * BYTES, o * BYTES);
      }
    } finally {
      fs.closeSync(mfd);
      fs.closeSync(ofd);
    }
    return info;
  } finally {
    fs.rmSync(raw, { force: true });
  }
}

/**
 * A voiceover file decoded to raw f32 stereo at `sr`, as the preview's Web Audio plays it: a mono file
 * goes to both channels at full level (ffmpeg's own mono -> stereo upmix is -3 dB per channel, which
 * would make the export 3 dB quieter than the preview), stereo stays stereo. Returns the frame count.
 */
export async function decodeVoiceToRaw(ffmpeg: string, input: string, sr: number, out: string): Promise<number> {
  const wav = `${out}.wav`;
  await run(ffmpeg, ["-v", "error", "-nostdin", "-y", "-i", input, "-vn", "-af", `aresample=${sr},aformat=sample_fmts=flt:channel_layouts=mono|stereo:sample_rates=${sr}`, "-c:a", "pcm_f32le", "-f", "wav", wav]);
  try {
    const b = fs.readFileSync(wav);
    let i = 12, ch = 2, data: Buffer | null = null;
    while (i + 8 <= b.length) {
      const id = b.toString("ascii", i, i + 4);
      const size = b.readUInt32LE(i + 4);
      if (id === "fmt ") ch = b.readUInt16LE(i + 10);
      if (id === "data") {
        data = b.subarray(i + 8, Math.min(b.length, i + 8 + size));
        break;
      }
      i += 8 + size + (size & 1);
    }
    if (!data) throw new Error(`no audio in ${input}`);
    const x = new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + (data.byteLength - (data.byteLength % (4 * ch)))));
    const n = Math.floor(x.length / ch);
    const y = new Float32Array(n * 2);
    for (let k = 0; k < n; k++) {
      y[2 * k] = x[k * ch]!;
      y[2 * k + 1] = x[k * ch + (ch > 1 ? 1 : 0)]!;
    }
    fs.writeFileSync(out, Buffer.from(y.buffer));
    return n;
  } finally {
    fs.rmSync(wav, { force: true });
  }
}

/**
 * Voiceover clips (demand #17) into the rendered audio, after the tracks' cleanup: each clip's file
 * decoded as the preview plays it (decodeVoiceToRaw), the trimmed part added at its output time with its gain and 3 ms
 * fades at both ends.
 */
async function addVoice(ffmpeg: string, file: string, audio: AudioPlan, nOut: number, dir: string): Promise<void> {
  const voice = audio.voice ?? [];
  if (!voice.length) return;
  const sr = audio.sampleRate;
  const fd = fs.openSync(file, "r+");
  try {
    for (const [k, v] of voice.entries()) {
      const raw = path.join(dir, `voice${k}.f32`);
      const frames = await decodeVoiceToRaw(ffmpeg, v.path, sr, raw);
      const o0 = Math.round((v.outMs * sr) / 1000);
      const f0 = Math.round((v.fileOffsetMs * sr) / 1000);
      const n = Math.min(Math.round((v.durMs * sr) / 1000), frames - f0, nOut - o0);
      if (n > 0) {
        const src = Buffer.alloc(n * BYTES);
        const dst = Buffer.alloc(n * BYTES);
        const vf = fs.openSync(raw, "r");
        fs.readSync(vf, src, 0, n * BYTES, f0 * BYTES);
        fs.closeSync(vf);
        fs.readSync(fd, dst, 0, n * BYTES, o0 * BYTES);
        const a = new Float32Array(src.buffer, src.byteOffset, n * 2);
        const b = new Float32Array(dst.buffer, dst.byteOffset, n * 2);
        const fade = Math.min(Math.max(1, Math.round(0.003 * sr)), Math.floor(n / 2));
        for (let i = 0; i < n; i++) {
          const e = Math.min(1, i / fade, (n - 1 - i) / fade) * v.gain;
          b[2 * i] = b[2 * i]! + a[2 * i]! * e;
          b[2 * i + 1] = b[2 * i + 1]! + a[2 * i + 1]! * e;
        }
        fs.writeSync(fd, dst, 0, n * BYTES, o0 * BYTES);
      }
      fs.rmSync(raw, { force: true });
    }
  } finally {
    fs.closeSync(fd);
  }
}

export interface RenderedAudio {
  /** raw f32le, 2 channels, sampleRate */
  file: string;
  sampleRate: number;
  frames: number;
  /** The music mix's measurements, when the plan has music. */
  music?: MusicMixInfo | null;
}

/**
 * Render the plan's audio into `dir`. `outMs` is the output length (frames / fps), so audio and video
 * end together. Returns null when the plan has nothing audible.
 */
export async function renderExportAudio(ffmpeg: string, audio: AudioPlan | null, outMs: number, dir: string, root: string): Promise<RenderedAudio | null> {
  if (!audio) return null;
  const hasClicks = audio.clickSound.enabled && audio.clickSound.times.length > 0;
  if (!audio.tracks.length && !hasClicks && !audio.music && !audio.voice?.length) return null;
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
    // voiceover clips (demand #17) first: the music bed (demand #23) is levelled against the speech as heard
    await addVoice(ffmpeg, file, audio, nOut, dir);
    let music: MusicMixInfo | null = null;
    if (audio.music) {
      // the music sits relative to the speech as it will be heard: measured after denoise / loudnorm
      const speechLufs = tracks.length ? fileLoudness(file, nOut, sr) : -Infinity;
      music = await mixMusic(ffmpeg, audio, file, nOut, dir, speechLufs);
      fs.writeFileSync(path.join(path.dirname(dir), "music-mix.json"), JSON.stringify(music));
    }
    addClicks(file, audio, nOut);
    if (file !== laid) fs.rmSync(laid, { force: true });
    return { file, sampleRate: sr, frames: nOut, music };
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
