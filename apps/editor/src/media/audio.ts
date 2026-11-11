/**
 * Preview audio: plays the mic track through the plan's audio pieces (cuts skipped, speed ranges
 * played at their rate, per-segment gain) and the voiceover clips (demand #17) at their output
 * times, and provides waveform peaks for the timeline.
 * Noise reduction plays through an RNNoise AudioWorklet (rnnoiseDenoise.ts) when the project has it
 * on, so the preview sounds like the export (ffmpeg arnndn, RNNoise too); loudness normalisation is
 * export-only.
 *
 * The music bed (demand #23) plays on the output clock through three gains: its level (the engine's
 * musicLevelGain from the same BS.1770 measurements the export makes: the music file and the speech
 * it is mixed with), the plan's duck envelope and its fade envelope, both scheduled as Web Audio
 * linear ramps between the plan's keys, i.e. the same piecewise-linear curve the export evaluates
 * per sample. renderOffline() runs this exact graph in an OfflineAudioContext (e2e: preview audio).
 */
import type { GainKey, RenderPlan } from "@lens/engine";
import { integratedLoudness, keyAt, musicLevelGain } from "@lens/engine";
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
  /** Integrated loudness of the mic file (LUFS), measured once per load. */
  private speechLufs = -Infinity;
  private music: { path: string; buffer: AudioBuffer | null; lufs: number; loading: Promise<void> | null } | null = null;
  /** Called when the music finishes loading (the store restarts playback so it is heard). */
  onMusicReady: (() => void) | null = null;
  /** Decoded voiceover clip files (demand #17), by project path. */
  private voice = new Map<string, AudioBuffer>();
  private voiceLoading = new Map<string, Promise<void>>();
  /** Silence the recording's own track (while a voiceover take is being recorded, so the mic does not pick it up). */
  muteOriginal = false;
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
      this.speechLufs = bufferLoudness(this.buffer);
      for (const l of this.listeners) l();
    } catch {
      this.buffer = null;
    }
  }

  /** Decode the voiceover files the project uses (once each); listeners hear when one is ready. */
  loadVoice(paths: string[]): Promise<void> {
    const dir = new URLSearchParams(location.search).get("dir");
    const jobs = [...new Set(paths)].filter((p) => !this.voice.has(p)).map((p) => {
      let j = this.voiceLoading.get(p);
      if (!j) {
        j = (async () => {
          try {
            const r = await fetch(`/api/asset?path=${encodeURIComponent(p)}${dir ? `&dir=${encodeURIComponent(dir)}` : ""}`);
            if (!r.ok) return;
            const off = new OfflineAudioContext(2, 1, 48000);
            this.voice.set(p, await off.decodeAudioData(await r.arrayBuffer()));
            for (const l of this.listeners) l();
          } catch {
            /* unreadable file: the clip stays silent in the preview */
          } finally {
            this.voiceLoading.delete(p);
          }
        })();
        this.voiceLoading.set(p, j);
      }
      return j;
    });
    return Promise.all(jobs).then(() => undefined);
  }

  /** Whether a voiceover file is decoded (diagnostics, e2e). */
  voiceReady(path: string): boolean {
    return this.voice.has(path);
  }

  /** The decoded voice file's duration in ms (null until loaded). */
  voiceFileMs(path: string): number | null {
    const b = this.voice.get(path);
    return b ? b.duration * 1000 : null;
  }

  /**
   * The preview's audio rendered offline as a mono (L+R)/2 mix: `ms` of output from frame `frame` at
   * 1x, 48 kHz, through the same schedule live playback uses (denoise and loudness excluded, as the live
   * preview without them). Voiceover e2e (demand #17); renderOffline below is the stereo version.
   */
  async renderOfflineMono(plan: RenderPlan, frame: number, ms: number): Promise<Float32Array> {
    const x = await this.renderOffline(plan, frame, ms / 1000);
    const n = x.length / 2;
    const m = new Float32Array(n);
    for (let i = 0; i < n; i++) m[i] = (x[2 * i]! + x[2 * i + 1]!) / 2;
    return m;
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

  /** Load the plan's music file (bundle-relative path) once; the level needs its loudness. */
  loadMusic(path: string | null): Promise<void> {
    if (!path) {
      this.music = null;
      return Promise.resolve();
    }
    if (this.music?.path === path) return this.music.loading ?? Promise.resolve();
    const m: NonNullable<AudioEngine["music"]> = { path, buffer: null, lufs: -Infinity, loading: null };
    this.music = m;
    m.loading = (async () => {
      try {
        const dir = new URLSearchParams(location.search).get("dir");
        const url = /^(\/|[A-Za-z]:\\)/.test(path) ? null : `/api/asset?path=${encodeURIComponent(path)}${dir ? `&dir=${encodeURIComponent(dir)}` : ""}`;
        if (!url) return;
        const r = await fetch(url);
        if (!r.ok) return;
        const off = new OfflineAudioContext(2, 1, 48000);
        const buf = await off.decodeAudioData(await r.arrayBuffer());
        if (this.music !== m) return;
        m.buffer = buf;
        m.lufs = bufferLoudness(buf);
        this.onMusicReady?.();
      } catch (e) {
        console.warn("[lens] music could not be loaded:", e);
      } finally {
        m.loading = null;
      }
    })();
    return m.loading;
  }

  /** What the music is doing right now (diagnostics, e2e). */
  musicState(): { path: string | null; loaded: boolean; musicLufs: number; speechLufs: number } {
    return { path: this.music?.path ?? null, loaded: !!this.music?.buffer, musicLufs: this.music?.lufs ?? -Infinity, speechLufs: this.speechLufs };
  }

  /**
   * Schedule the plan's audio from output frame `frame` at `rate` into `dest` of `ctx`, starting at
   * context time `t0`: speech pieces of the first track (track volume on `trackGain`; skipped while muteOriginal), the
   * voiceover clips and the music bed.
   */
  private schedule(ctx: BaseAudioContext, trackGain: AudioNode, dest: AudioNode, plan: RenderPlan, frame: number, rate: number, t0: number, nodes: AudioScheduledSourceNode[]): void {
    const audio = plan.audio;
    if (!audio || rate <= 0) return;
    if (this.buffer && audio.tracks[0] && !this.muteOriginal) {
      for (const s of audioSchedule(plan, frame, rate, this.buffer.duration * 1000)) {
        const node = ctx.createBufferSource();
        node.buffer = this.buffer;
        node.playbackRate.value = s.playbackRate;
        const g = ctx.createGain();
        g.gain.value = s.gain;
        node.connect(g).connect(trackGain);
        node.start(t0 + s.whenS, s.offsetS, s.durationS);
        nodes.push(node);
      }
    }
    // voiceover clips (demand #17) at their output times, straight out like the music (the export adds
    // them after its denoise / loudnorm), 3 ms fades at both ends as the export mixes them
    for (const v of voiceSchedule(plan, frame, rate)) {
      const buf = this.voice.get(v.path);
      if (!buf) continue;
      const node = ctx.createBufferSource();
      node.buffer = buf;
      node.playbackRate.value = v.playbackRate;
      const g = ctx.createGain();
      const at = t0 + v.whenS;
      const len = v.durationS / v.playbackRate;
      const f = Math.min(0.003, len / 2);
      g.gain.setValueAtTime(v.fadeIn ? 0 : v.gain, at);
      if (v.fadeIn) g.gain.linearRampToValueAtTime(v.gain, at + f);
      g.gain.setValueAtTime(v.gain, Math.max(at + f, at + len - f));
      g.gain.linearRampToValueAtTime(0, at + len);
      node.connect(g).connect(dest);
      node.start(at, v.offsetS, v.durationS);
      nodes.push(node);
    }
    const m = audio.music;
    const mb = this.music?.path === m?.path ? this.music?.buffer : null;
    if (!m || !mb) return;
    const outNow = (frame * 1000) / plan.output.fps;
    const total = (plan.frames.length * 1000) / plan.output.fps;
    if (outNow >= total) return;
    // speech reference: the mic as it plays here (track volume); the export measures its cleaned mix
    const tr = audio.tracks[0];
    const speech = tr && this.buffer ? this.speechLufs + 20 * Math.log10(Math.max(1e-9, tr.volume)) : -Infinity;
    const level = musicLevelGain(speech, this.music!.lufs, m.volumeDb, audio.loudness.enabled ? audio.loudness.targetLufs : -16);
    const fileMs = mb.duration * 1000;
    const pos = m.startMs + outNow;
    if (!m.loop && pos >= fileMs) return;
    const src = ctx.createBufferSource();
    src.buffer = mb;
    src.loop = m.loop;
    src.playbackRate.value = rate;
    const lv = ctx.createGain();
    lv.gain.value = level;
    const duck = ctx.createGain();
    const fade = ctx.createGain();
    scheduleKeys(duck.gain, m.duck, outNow, t0, rate);
    scheduleKeys(fade.gain, m.fade, outNow, t0, rate);
    src.connect(lv).connect(duck).connect(fade).connect(dest);
    src.start(t0, ((m.loop ? pos % fileMs : pos) / 1000));
    src.stop(t0 + (total - outNow) / 1000 / rate);
    nodes.push(src);
  }

  /** (Re)start playback from output frame `frame`. Only forward 1x-4x plays sound. */
  restart(plan: RenderPlan, frame: number, rate: number): void {
    this.stop();
    if (plan.audio?.music) void this.loadMusic(plan.audio.music.path);
    if (!plan.audio || rate <= 0 || (!this.buffer && !this.music?.buffer && !plan.audio.voice?.length)) return;
    const ctx = this.context();
    if (!ctx || !this.gain) return;
    void ctx.resume();
    const nr = !!plan.audio.noiseReduction?.enabled;
    if (nr !== this.denoiseOn || (nr && !this.denoise)) {
      this.denoiseOn = nr;
      this.route(nr);
    }
    const track = plan.audio.tracks[0];
    this.gain.gain.value = track?.volume ?? 1;
    // the music goes straight out (RNNoise is for the voice; the export adds the music after its denoise)
    this.schedule(ctx, this.gain, ctx.destination, plan, frame, rate, ctx.currentTime + 0.03, this.nodes);
  }

  /**
   * The preview's audio graph rendered offline: `seconds` of output from frame `frame` at 1x, stereo
   * 48 kHz, as interleaved Float32 (denoise not applied; e2e runs with it off). Loads the music first.
   */
  async renderOffline(plan: RenderPlan, frame: number, seconds: number): Promise<Float32Array> {
    if (plan.audio?.music) await this.loadMusic(plan.audio.music.path);
    const n = Math.max(1, Math.round(seconds * 48000));
    const ctx = new OfflineAudioContext(2, n, 48000);
    const g = ctx.createGain();
    g.gain.value = plan.audio?.tracks[0]?.volume ?? 1;
    g.connect(ctx.destination);
    this.schedule(ctx, g, ctx.destination, plan, frame, 1, 0, []);
    const out = await ctx.startRendering();
    const l = out.getChannelData(0), r = out.getChannelData(1);
    const x = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      x[2 * i] = l[i]!;
      x[2 * i + 1] = r[i]!;
    }
    return x;
  }
}

/** Integrated loudness of a decoded buffer (a mono file counts as the stereo it plays as). */
export function bufferLoudness(b: AudioBuffer): number {
  const ch = Array.from({ length: Math.min(2, b.numberOfChannels) }, (_, i) => b.getChannelData(i));
  return integratedLoudness(ch, b.sampleRate);
}

/**
 * Schedule a piecewise-linear envelope on an AudioParam: its value at output time `outNow` at context
 * time `t0`, then a linear ramp to every later key (times scaled by the transport rate). Between keys
 * Web Audio interpolates linearly, which is exactly keyAt().
 */
export function scheduleKeys(param: AudioParam, keys: GainKey[], outNow: number, t0: number, rate: number): void {
  param.cancelScheduledValues(0);
  param.setValueAtTime(keyAt(keys, outNow), t0);
  for (const [t, g] of keys) if (t > outNow) param.linearRampToValueAtTime(g, t0 + (t - outNow) / 1000 / rate);
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

export interface ScheduledVoice extends ScheduledPiece {
  path: string;
  /** Starts at the clip's first sample (fade in) rather than part-way through it. */
  fadeIn: boolean;
}

/** Voiceover clips (plan.audio.voice) to play from output frame `frame` at transport rate `rate`. */
export function voiceSchedule(plan: Pick<RenderPlan, "audio" | "output">, frame: number, rate: number): ScheduledVoice[] {
  const voice = plan.audio?.voice;
  if (!voice?.length || rate <= 0) return [];
  const outNow = (frame * 1000) / plan.output.fps;
  const out: ScheduledVoice[] = [];
  for (const v of voice) {
    const end = v.outMs + v.durMs;
    if (end <= outNow) continue;
    const from = Math.max(v.outMs, outNow);
    out.push({ path: v.path, whenS: (from - outNow) / 1000 / rate, offsetS: (v.fileOffsetMs + (from - v.outMs)) / 1000, durationS: (end - from) / 1000, playbackRate: rate, gain: v.gain, fadeIn: from === v.outMs });
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
