/**
 * Music bed with automatic ducking (demand #23): speech ranges, output mapping, duck / fade
 * envelopes, loudness (BS.1770), level gain, built-in beds, plans of projects without music.
 */
import { describe, expect, it } from "vitest";
import {
  bedLength,
  BUILTIN_BEDS,
  buildRenderPlan,
  duckKeys,
  encodeWav16,
  fadeKeys,
  integratedLoudness,
  keyAt,
  LoudnessMeter,
  musicEnvelopeAt,
  musicFileMs,
  musicLevelGain,
  resolveProject,
  speechRanges,
  speechToOutput,
  synthBed,
} from "../src/index.js";
import { demoSession, META } from "./fixtures.js";

const sine = (f: number, amp: number, secs: number, sr = 48000) => Float32Array.from({ length: Math.round(secs * sr) }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / sr));
const db = (g: number) => 20 * Math.log10(g);
const MIC = { id: "mic", kind: "mic" as const, path: "mic.wav", offsetMs: 0, volume: 1, muted: false };

describe("loudness (BS.1770)", () => {
  it("1 kHz stereo sine at -23 dBFS reads -23.0 LUFS (EBU Tech 3341 case 1)", () => {
    const x = sine(1000, Math.pow(10, -23 / 20), 20);
    expect(integratedLoudness([x, x], 48000)).toBeCloseTo(-23, 1);
  });
  it("gates silence out (absolute gate) and works at 44.1 kHz; mono counts as both channels", () => {
    const sr = 44100;
    const tone = sine(1000, Math.pow(10, -20 / 20), 5, sr);
    const withGap = new Float32Array(tone.length * 2);
    withGap.set(tone, 0);
    // the partly-filled 400 ms blocks at the tone's end pass the gate a little lower (< 0.2 LU)
    expect(Math.abs(integratedLoudness([withGap], sr) - integratedLoudness([tone, tone], sr))).toBeLessThan(0.2);
    expect(integratedLoudness([tone], sr)).toBeCloseTo(-20, 1);
  });
  it("streams interleaved blocks the same as one planar push", () => {
    const l = sine(440, 0.3, 3), r = sine(660, 0.2, 3);
    const m = new LoudnessMeter(48000, 2);
    for (let k = 0; k < l.length; k += 4800) {
      const n = Math.min(4800, l.length - k);
      const blk = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) { blk[2 * i] = l[k + i]!; blk[2 * i + 1] = r[k + i]!; }
      m.pushInterleaved(blk);
    }
    expect(m.integrated()).toBeCloseTo(integratedLoudness([l, r], 48000), 6);
  });
  it("silence is -Infinity and gives a zero music gain", () => {
    expect(integratedLoudness([new Float32Array(48000 * 2)], 48000)).toBe(-Infinity);
    expect(musicLevelGain(-16, -Infinity, -14)).toBe(0);
  });
});

describe("level gain", () => {
  it("puts the music volumeDb under the speech, falls back to the reference, caps at +30 dB", () => {
    expect(db(musicLevelGain(-20, -10, -14))).toBeCloseTo(-24, 6);
    expect(db(musicLevelGain(-Infinity, -10, -14, -16))).toBeCloseTo(-20, 6);
    expect(db(musicLevelGain(-10, -80, 0))).toBeCloseTo(30, 6);
  });
});

describe("speech ranges", () => {
  it("are the gaps between measured silences, clipped to the recording", () => {
    expect(speechRanges(10000, [], [{ startMs: 0, endMs: 1000 }, { startMs: 3000, endMs: 5000 }, { startMs: 7000, endMs: 10000 }])).toEqual([
      { startMs: 1000, endMs: 3000 },
      { startMs: 5000, endMs: 7000 },
    ]);
    expect(speechRanges(4000, [], [])).toEqual([{ startMs: 0, endMs: 4000 }]);
  });
  it("fall back to the words (merged across gaps under 300 ms), else none", () => {
    const w = (startMs: number, endMs: number) => ({ text: "x", startMs, endMs });
    expect(speechRanges(9000, [w(1000, 1400), w(1600, 2000), w(4000, 4500)])).toEqual([{ startMs: 1000, endMs: 2000 }, { startMs: 4000, endMs: 4500 }]);
    expect(speechRanges(9000, [])).toEqual([]);
  });
  it("map onto the output clock through cuts and speed ranges", () => {
    // source 0-2 s kept, 2-4 s cut, 4-6 s at 2x (-> 1 s), 6-8 s kept
    const pieces = [
      { srcStart: 0, srcEnd: 2000, outStart: 0, rate: 1 },
      { srcStart: 4000, srcEnd: 6000, outStart: 2000, rate: 2 },
      { srcStart: 6000, srcEnd: 8000, outStart: 3000, rate: 1 },
    ];
    expect(speechToOutput(pieces, [{ startMs: 1000, endMs: 5000 }, { startMs: 7000, endMs: 7500 }])).toEqual([
      { startMs: 1000, endMs: 2500 },
      { startMs: 4000, endMs: 4500 },
    ]);
  });
});

describe("duck and fade envelopes", () => {
  const duck = { enabled: true, depthDb: 12, attackMs: 150, holdMs: 150, releaseMs: 600 };
  const speech = [{ startMs: 1000, endMs: 3000 }, { startMs: 3500, endMs: 4000 }, { startMs: 7000, endMs: 9000 }];
  const keys = duckKeys(speech, 12000, duck);
  const low = Math.pow(10, -12 / 20);
  it("is down by depthDb while speech runs, from the speech start (look-ahead attack)", () => {
    for (const t of [1000, 2000, 2999, 3700, 7000, 8500]) expect(keyAt(keys, t)).toBeCloseTo(low, 5);
    expect(keyAt(keys, 850)).toBeCloseTo(1, 5);
    expect(keyAt(keys, 925)).toBeCloseTo((1 + low) / 2, 5);
  });
  it("recovers fully in a long gap, stays down through a short one (no pumping)", () => {
    expect(keyAt(keys, 3250)).toBeCloseTo(low, 5); // 500 ms gap < attack + hold + release
    expect(keyAt(keys, 4150)).toBeCloseTo(low, 5); // hold
    expect(keyAt(keys, 4150 + 300)).toBeCloseTo((1 + low) / 2, 5); // half-way through the release
    expect(keyAt(keys, 5500)).toBe(1); // recovered
    expect(keyAt(keys, 11000)).toBe(1);
  });
  it("is constant without speech, with the duck off or with zero depth", () => {
    expect(duckKeys([], 12000, duck)).toEqual([]);
    expect(duckKeys(speech, 12000, { ...duck, enabled: false })).toEqual([]);
    expect(duckKeys(speech, 12000, { ...duck, depthDb: 0 })).toEqual([]);
  });
  it("fades in and out linearly, shortened proportionally when they would overlap", () => {
    const f = fadeKeys(10000, 1000, 2000);
    expect(keyAt(f, 0)).toBe(0);
    expect(keyAt(f, 500)).toBeCloseTo(0.5, 6);
    expect(keyAt(f, 5000)).toBe(1);
    expect(keyAt(f, 9000)).toBeCloseTo(0.5, 6);
    expect(keyAt(f, 10000)).toBe(0);
    const s = fadeKeys(1500, 1000, 2000); // 3 s of fades in 1.5 s
    expect(s).toEqual([[0, 0], [500, 1], [500, 1], [1500, 0]]);
    expect(fadeKeys(5000, 0, 0)).toEqual([[0, 1], [5000, 1]]);
    expect(musicEnvelopeAt({ duck: keys, fade: f }, 2000)).toBeCloseTo(low, 5);
  });
  it("loops the file position on the output clock", () => {
    expect(musicFileMs({ loop: true, startMs: 500 }, 9800, 4000)).toBe(2300);
    expect(musicFileMs({ loop: false, startMs: 0 }, 3999, 4000)).toBe(3999);
    expect(musicFileMs({ loop: false, startMs: 0 }, 4000, 4000)).toBeNull();
  });
});

describe("render plan", () => {
  const events = demoSession();
  const base = { audio: { tracks: [MIC] }, zoom: { auto: false } };
  const pauses = [{ startMs: 0, endMs: 1000 }, { startMs: 4000, endMs: 6000 }, { startMs: 9000, endMs: 12000 }];
  it("projects without music: no music key, plan identical with music null / absent / muted", () => {
    const a = buildRenderPlan({ meta: META, events, project: resolveProject(base), pauses });
    expect(a.audio && "music" in a.audio).toBe(false);
    const b = buildRenderPlan({ meta: META, events, project: resolveProject({ ...base, audio: { ...base.audio, music: null } }), pauses });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    const off = buildRenderPlan({ meta: META, events, project: resolveProject({ ...base, audio: { ...base.audio, music: { path: "music/x.wav", enabled: false } } }), pauses });
    expect(JSON.stringify(off)).toBe(JSON.stringify(a));
    // a plan without mic or clicks stays null
    expect(buildRenderPlan({ meta: META, events, project: resolveProject({ audio: { tracks: [] }, cursor: { clickSound: false } }) }).audio).toBeNull();
  });
  it("adds a music plan (speech from the measured pauses on the output clock) and changes nothing else", () => {
    const a = buildRenderPlan({ meta: META, events, project: resolveProject(base), pauses });
    const p = resolveProject({ ...base, audio: { ...base.audio, music: { path: "music/bed.wav", name: "Bed", source: "builtin:calm-pad" } } });
    expect(p.audio.music).toMatchObject({ volumeDb: -14, loop: true, fadeInMs: 1000, duck: { depthDb: 12, attackMs: 150 } });
    const m = buildRenderPlan({ meta: META, events, project: p, pauses });
    expect(m.audio!.music!.speech).toEqual([{ startMs: 1000, endMs: 4000 }, { startMs: 6000, endMs: 9000 }]);
    expect(keyAt(m.audio!.music!.duck, 2500)).toBeCloseTo(Math.pow(10, -12 / 20), 5);
    expect(keyAt(m.audio!.music!.duck, 5200)).toBe(1);
    const { audio: _a, ...rest } = m;
    const { audio: _b, ...restA } = a;
    expect(JSON.stringify(rest)).toBe(JSON.stringify(restA));
    const { music: _m, ...am } = m.audio!;
    expect(JSON.stringify(am)).toBe(JSON.stringify(a.audio));
  });
  it("follows cuts: speech after a cut moves earlier on the output clock; music-only projects get an audio plan", () => {
    const p = resolveProject({ ...base, edits: { cuts: [{ startMs: 4000, endMs: 6000 }] }, audio: { ...base.audio, music: { path: "music/bed.wav" } } });
    const m = buildRenderPlan({ meta: META, events, project: p, pauses });
    expect(m.audio!.music!.speech).toEqual([{ startMs: 1000, endMs: 7000 }]);
    const only = buildRenderPlan({ meta: META, events, project: resolveProject({ audio: { tracks: [], music: { path: "music/bed.wav" } }, cursor: { clickSound: false } }) });
    expect(only.audio!.music!.duck).toEqual([]); // nothing to duck under
    expect(only.audio!.tracks).toEqual([]);
  });
  it("rejects bad music settings", () => {
    expect(() => resolveProject({ audio: { music: { path: "" } } })).toThrow(/music.path/);
    expect(() => resolveProject({ audio: { music: { path: "a.wav", volumeDb: 40 } } })).toThrow(/volumeDb/);
    expect(() => resolveProject({ audio: { music: { path: "a.wav", duck: { depthDb: -3 } } } })).toThrow(/depthDb/);
  });
});

describe("built-in beds (CC0, synthesised)", () => {
  for (const b of BUILTIN_BEDS) {
    it(`${b.id}: deterministic, whole bars, peak -6 dBFS, seamless loop, audible`, () => {
      const [L, R] = synthBed(b.id, 48000);
      expect(L.length).toBe(bedLength(b, 48000));
      const [L2] = synthBed(b.id, 48000);
      expect(L2[12345]).toBe(L[12345]);
      let peak = 0, maxStep = 0;
      for (let i = 0; i < L.length; i++) {
        peak = Math.max(peak, Math.abs(L[i]!), Math.abs(R[i]!));
        if (i) maxStep = Math.max(maxStep, Math.abs(L[i]! - L[i - 1]!), Math.abs(R[i]! - R[i - 1]!));
      }
      expect(peak).toBeCloseTo(0.5, 4);
      // the jump across the loop point is no bigger than the largest step inside the loop
      const seam = Math.max(Math.abs(L[0]! - L[L.length - 1]!), Math.abs(R[0]! - R[R.length - 1]!));
      expect(seam).toBeLessThanOrEqual(maxStep * 1.05);
      const lufs = integratedLoudness([L, R], 48000);
      expect(lufs).toBeGreaterThan(-30);
      expect(lufs).toBeLessThan(-8);
    });
  }
  it("encodes a 16-bit stereo WAV", () => {
    const w = encodeWav16([new Float32Array([0, 1, -1]), new Float32Array([0.5, 0, 0])], 48000);
    expect(w.length).toBe(44 + 12);
    expect(String.fromCharCode(...w.slice(0, 4))).toBe("RIFF");
    const v = new DataView(w.buffer);
    expect(v.getInt16(44 + 4, true)).toBe(32767);
    expect(v.getInt16(44 + 8, true)).toBe(-32768);
  });
});
