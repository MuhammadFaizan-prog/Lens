/**
 * Preview audio: plays the mic track through the plan's audio pieces (cuts skipped, speed ranges
 * played at their rate, per-segment gain), and provides waveform peaks for the timeline.
 * Noise reduction plays through an RNNoise AudioWorklet (rnnoiseDenoise.ts) when the project has it
 * on, so the preview sounds like the export (ffmpeg arnndn, RNNoise too); loudness normalisation is
 * export-only.
 */
import type { RenderPlan } from "@lens/engine";
import { createRnnoise } from "./rnnoiseDenoise";

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private nodes: AudioBufferSourceNode[] = [];
  private gain: GainNode | null = null;
  private denoise: AudioNode | null = null;
  private denoiseLoading: Promise<void> | null = null;
  private denoiseOn = false;
  private loadedPath: string | null = null;
  peaks: Float32Array | null = null;
  /** ms of source audio per peak bucket */
  peakMs = 10;
  private listeners = new Set<() => void>();

  onChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  async load(path: string | null): Promise<void> {
    if (!path || path === this.loadedPath) return;
    this.loadedPath = path;
    try {
      const dir = new URLSearchParams(location.search).get("dir");
      const r = await fetch(`/api/media/${encodeURIComponent(path.split("/").pop()!)}${dir ? `?dir=${encodeURIComponent(dir)}` : ""}`);
      if (!r.ok) return;
      const bytes = await r.arrayBuffer();
      // Decode with an OfflineAudioContext so no audio device is needed until playback.
      const off = new OfflineAudioContext(1, 1, 48000);
      this.buffer = await off.decodeAudioData(bytes);
      this.peaks = computePeaks(this.buffer, this.peakMs);
      for (const l of this.listeners) l();
    } catch {
      this.buffer = null;
    }
  }

  private context(): AudioContext | null {
    if (!this.ctx) {
      try {
        // RNNoise works on 48 kHz frames
        this.ctx = new AudioContext({ sampleRate: 48000 });
        this.gain = this.ctx.createGain();
        this.gain.connect(this.ctx.destination);
      } catch {
        return null;
      }
    }
    return this.ctx;
  }

  stop(): void {
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {
        /* already stopped */
      }
    }
    this.nodes = [];
  }

  /** Route the output through RNNoise (on) or straight to the speakers (off). */
  private route(on: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.gain) return;
    if (on && !this.denoise) {
      this.denoiseLoading ??= createRnnoise(ctx)
        .then((n) => {
          this.denoise = n;
          n.connect(ctx.destination);
          this.route(this.denoiseOn);
        })
        .catch((e) => console.warn("[lens] preview denoise unavailable:", e));
      return;
    }
    this.gain.disconnect();
    this.gain.connect(on && this.denoise ? this.denoise : ctx.destination);
  }

  /** Whether playback goes through RNNoise right now (diagnostics, e2e). */
  denoiseState(): { requested: boolean; active: boolean } {
    return { requested: this.denoiseOn, active: this.denoiseOn && !!this.denoise };
  }

  /**
   * Run mono samples (48 kHz) through the same RNNoise worklet offline (diagnostics / packaged-app
   * test that the bundled wasm and worklet load). Returns the processed samples.
   */
  async denoiseOffline(x: Float32Array): Promise<Float32Array> {
    const ctx = new OfflineAudioContext(1, x.length, 48000);
    const node = await createRnnoise(ctx);
    const buf = ctx.createBuffer(1, x.length, 48000);
    buf.copyToChannel(x as Float32Array<ArrayBuffer>, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(node).connect(ctx.destination);
    src.start();
    // the worklet instantiates its wasm asynchronously: hold the render until it is up
    void ctx.suspend(256 / 48000).then(() => setTimeout(() => void ctx.resume(), 500));
    return (await ctx.startRendering()).getChannelData(0);
  }

  /** (Re)start playback from output frame `frame`. Only forward 1x-4x plays sound. */
  restart(plan: RenderPlan, frame: number, rate: number): void {
    this.stop();
    if (!this.buffer || !plan.audio || rate <= 0) return;
    const ctx = this.context();
    if (!ctx || !this.gain) return;
    void ctx.resume();
    const nr = !!plan.audio.noiseReduction?.enabled;
    if (nr !== this.denoiseOn || (nr && !this.denoise)) {
      this.denoiseOn = nr;
      this.route(nr);
    }
    const track = plan.audio.tracks[0];
    if (!track) return;
    this.gain.gain.value = track.volume;
    const t0 = ctx.currentTime + 0.03;
    for (const s of audioSchedule(plan, frame, rate, this.buffer.duration * 1000)) {
      const node = ctx.createBufferSource();
      node.buffer = this.buffer;
      node.playbackRate.value = s.playbackRate;
      const g = ctx.createGain();
      g.gain.value = s.gain;
      node.connect(g).connect(this.gain);
      node.start(t0 + s.whenS, s.offsetS, s.durationS);
      this.nodes.push(node);
    }
  }
}

export interface ScheduledPiece {
  /** Seconds from now (playback start) at which this piece plays. */
  whenS: number;
  /** Seconds into the audio file. */
  offsetS: number;
  /** Seconds of the file to play. */
  durationS: number;
  playbackRate: number;
  gain: number;
}

/**
 * Which slices of the first audio track to play, and when, to follow the plan from output frame
 * `frame` at transport rate `rate` (cuts skipped, speed ranges sped up, per-segment gain).
 */
export function audioSchedule(plan: Pick<RenderPlan, "audio" | "output">, frame: number, rate: number, fileMs: number): ScheduledPiece[] {
  const audio = plan.audio;
  const track = audio?.tracks[0];
  if (!audio || !track || rate <= 0) return [];
  const outNow = (frame * 1000) / plan.output.fps;
  const out: ScheduledPiece[] = [];
  for (const p of audio.pieces) {
    if (p.outEnd <= outNow) continue;
    const startOut = Math.max(p.outStart, outNow);
    const srcAt = p.srcStart + (startOut - p.outStart) * p.rate - track.offsetMs;
    const srcEnd = Math.min(fileMs, p.srcEnd - track.offsetMs);
    const from = Math.max(0, srcAt);
    if (srcEnd <= from) continue;
    // a piece that starts before the file does: wait for the file's first sample
    const lead = (from - srcAt) / p.rate;
    out.push({ whenS: (startOut - outNow + lead) / 1000 / rate, offsetS: from / 1000, durationS: (srcEnd - from) / 1000, playbackRate: p.rate * rate, gain: p.gain });
  }
  return out;
}

/** Max |sample| per bucket of `ms` milliseconds, mono mix. */
export function computePeaks(buf: AudioBuffer, ms: number): Float32Array {
  const per = Math.max(1, Math.round((buf.sampleRate * ms) / 1000));
  const n = Math.ceil(buf.length / per);
  const out = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) {
      let m = 0;
      const end = Math.min(d.length, (i + 1) * per);
      for (let j = i * per; j < end; j++) {
        const v = Math.abs(d[j]!);
        if (v > m) m = v;
      }
      if (m > out[i]!) out[i] = m;
    }
  }
  return out;
}
