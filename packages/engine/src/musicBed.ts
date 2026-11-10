/**
 * Built-in music beds (demand #23): short, seamlessly looping instrumental beds synthesised by Lens's
 * own code, so no third-party recording ships with the app. Every sample is computed here from the
 * chord charts below; the output is dedicated to the public domain (CC0 1.0, see
 * assets/music/LICENSE.md). Deterministic: the same id gives the same samples on every machine, so
 * the preview and the export read the same file (the server writes it once into the bundle as WAV).
 *
 * Each bed is a whole number of bars at its tempo, and every oscillator completes a whole number of
 * cycles per loop (frequencies are snapped to the loop length), so the loop point has no click.
 */

export interface BedInfo {
  id: string;
  name: string;
  mood: string;
  bpm: number;
  bars: number;
}

export const BUILTIN_BEDS: BedInfo[] = [
  { id: "calm-pad", name: "Calm pad", mood: "soft sustained chords, slow", bpm: 72, bars: 8 },
  { id: "light-pulse", name: "Light pulse", mood: "gentle eighth-note pulse, upbeat", bpm: 100, bars: 8 },
  { id: "focus-keys", name: "Focus keys", mood: "plucked keys over a low drone, steady", bpm: 88, bars: 8 },
];

export const BED_LICENSE = "Lens built-in music bed: synthesised by Lens's own code (packages/engine/src/musicBed.ts). CC0 1.0 Universal (public domain dedication).";

// A4 = 440 Hz; MIDI note -> Hz
const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

// chord charts (MIDI notes), one chord per bar; I-vi-IV-V style progressions in C / G / D
const CHARTS: Record<string, number[][]> = {
  "calm-pad": [[48, 55, 60, 64], [45, 52, 57, 60], [41, 48, 53, 57], [43, 50, 55, 59], [48, 55, 60, 64], [45, 52, 57, 60], [41, 48, 53, 57], [43, 50, 55, 62]],
  "light-pulse": [[43, 55, 59, 62], [40, 52, 55, 59], [36, 48, 52, 55], [38, 50, 54, 57], [43, 55, 59, 62], [40, 52, 55, 59], [36, 48, 52, 55], [38, 50, 54, 57]],
  "focus-keys": [[50, 57, 62, 66], [47, 54, 59, 62], [43, 55, 59, 62], [45, 57, 61, 64], [50, 57, 62, 66], [47, 54, 59, 62], [43, 55, 59, 62], [45, 52, 57, 61]],
};

/** Deterministic PRNG (mulberry32). */
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

export function bedInfo(id: string): BedInfo | undefined {
  return BUILTIN_BEDS.find((b) => b.id === id);
}

/** Loop length in samples for a bed at `sr`. */
export function bedLength(info: BedInfo, sr: number): number {
  return Math.round(((info.bars * 4 * 60) / info.bpm) * sr);
}

/**
 * Synthesise one loop of a built-in bed: stereo planar Float32 at `sr`, peak normalised to -6 dBFS.
 * Throws for an unknown id.
 */
export function synthBed(id: string, sr = 48000): [Float32Array, Float32Array] {
  const info = bedInfo(id);
  const chart = CHARTS[id];
  if (!info || !chart) throw new Error(`unknown built-in bed ${id}`);
  const n = bedLength(info, sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const loopS = n / sr;
  const snap = (f: number) => Math.max(1, Math.round(f * loopS)) / loopS; // whole cycles per loop
  const barS = (4 * 60) / info.bpm;
  const beatS = 60 / info.bpm;
  const TAU = 2 * Math.PI;
  const r = rng(id.split("").reduce((a, c) => a * 31 + c.charCodeAt(0), 7));
  // per-bar chord tones with a little detune and stereo spread
  const voices = chart.map((ch) => ch.map((m, i) => ({ f: snap(hz(m)), f2: snap(hz(m) * 1.003), pan: -0.6 + (1.2 * i) / Math.max(1, ch.length - 1), ph: r() * TAU })));
  for (let k = 0; k < n; k++) {
    const t = k / sr;
    const bar = Math.floor(t / barS) % chart.length;
    const tb = t - Math.floor(t / barS) * barS; // time in bar
    let l = 0, rr = 0;
    const prev = (bar + chart.length - 1) % chart.length;
    if (id === "calm-pad") {
      // each chord swells in over 0.8 s while the previous one fades under it (continuous at every bar line)
      const w = Math.min(1, tb / 0.8);
      for (const [vs, g] of [[voices[bar]!, w], [voices[prev]!, 1 - w]] as const) {
        if (g <= 0) continue;
        for (const v of vs) {
          const s = (0.6 * Math.sin(TAU * v.f * t + v.ph) + 0.4 * Math.sin(TAU * v.f2 * t + v.ph * 1.7)) * g;
          l += s * (1 - v.pan) * 0.5;
          rr += s * (1 + v.pan) * 0.5;
        }
      }
    } else if (id === "light-pulse") {
      const eighth = beatS / 2;
      const te = tb % eighth;
      const tq = tb % beatS;
      const taper = (x: number, len: number) => Math.min(1, x / 0.004) * Math.min(1, (len - x) / 0.01);
      const env = Math.exp(-te / 0.09) * taper(te, eighth);
      const ch = voices[bar]!;
      const b = Math.sin(TAU * (ch[0]!.f / 2) * t) * Math.exp(-tq / 0.25) * taper(tq, beatS) * 0.9;
      l += b * 0.5;
      rr += b * 0.5;
      for (const v of ch.slice(1)) {
        const s = Math.sin(TAU * v.f * t + v.ph) * env;
        l += s * (1 - v.pan) * 0.4;
        rr += s * (1 + v.pan) * 0.4;
      }
    } else {
      // focus-keys: low drone (cross-faded at bar lines) + a plucked arpeggio, one note per beat
      const ch = voices[bar]!;
      const w = Math.min(1, tb / 0.3);
      const d = (Math.sin(TAU * (ch[0]!.f / 2) * t) * w + Math.sin(TAU * (voices[prev]![0]!.f / 2) * t) * (1 - w)) * 0.35;
      l += d;
      rr += d;
      const beat = Math.floor(tb / beatS) % 4;
      const tn = tb % beatS;
      const v = ch[(beat % (ch.length - 1)) + 1]!;
      const env = Math.exp(-tn / 0.35) * Math.min(1, tn / 0.003) * Math.min(1, (beatS - tn) / 0.01);
      const s = (Math.sin(TAU * v.f * t) + 0.3 * Math.sin(TAU * 2 * v.f * t) + 0.1 * Math.sin(TAU * 3 * v.f * t)) * env;
      l += s * (1 - v.pan) * 0.5;
      rr += s * (1 + v.pan) * 0.5;
    }
    L[k] = l;
    R[k] = rr;
  }
  // gentle 1-pole low-pass for warmth, run twice around the loop so the state is continuous at the seam
  for (const x of [L, R]) {
    const a = Math.exp((-TAU * 3500) / sr);
    let y = 0;
    for (let pass = 0; pass < 2; pass++) for (let k = 0; k < n; k++) {
      y = (1 - a) * x[k]! + a * y;
      if (pass === 1) x[k] = y;
    }
  }
  let peak = 0;
  for (let k = 0; k < n; k++) peak = Math.max(peak, Math.abs(L[k]!), Math.abs(R[k]!));
  const g = peak > 0 ? 0.5 / peak : 0;
  for (let k = 0; k < n; k++) {
    L[k] = L[k]! * g;
    R[k] = R[k]! * g;
  }
  return [L, R];
}

/** 16-bit PCM WAV bytes for planar stereo samples. */
export function encodeWav16(ch: [Float32Array, Float32Array], sr: number): Uint8Array {
  const n = ch[0].length;
  const buf = new ArrayBuffer(44 + n * 4);
  const v = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + n * 4, true); w(8, "WAVE");
  w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 2; c++) {
      const s = Math.max(-1, Math.min(1, ch[c as 0 | 1][i]!));
      v.setInt16(44 + i * 4 + c * 2, Math.round(s < 0 ? s * 32768 : s * 32767), true);
    }
  }
  return new Uint8Array(buf);
}
