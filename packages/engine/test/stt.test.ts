import { describe, expect, it } from "vitest";
import {
  buildRenderPlan,
  captionWords,
  cleanupCuts,
  DEFAULT_CLEANUP,
  isFiller,
  parseTranscript,
  resolveProject,
  ProjectValidationError,
  TranscriptError,
  type Word,
} from "../src/index.js";
import { META, demoSession } from "./fixtures.js";

// Shape of lens-transcribe output (transcribe/lens_transcribe): times in recording ms.
const transcript = {
  version: 1,
  language: "en",
  languageProbability: 1,
  durationMs: 6000,
  offsetMs: 0,
  engine: { name: "faster-whisper", model: "base.en", licence: "MIT" },
  words: [
    { text: "So,", startMs: 300, endMs: 700, confidence: 0.8 },
    { text: "um,", startMs: 900, endMs: 1250, confidence: 0.4, filler: true },
    { text: "open", startMs: 1450, endMs: 1800, confidence: 0.9 },
    { text: "[filler]", startMs: 2000, endMs: 2300, confidence: 0, filler: true, inferred: true },
    { text: "settings.", startMs: 3900, endMs: 4400, confidence: 0.95 },
  ],
  pauses: [
    { startMs: 0, endMs: 300 },
    { startMs: 700, endMs: 900 },
    { startMs: 1250, endMs: 1450 },
    { startMs: 1800, endMs: 2000 },
    { startMs: 2300, endMs: 2900 },
    // 2900-3200: voiced audio with no word and no filler flag (e.g. a cough): must never be cut
    { startMs: 3200, endMs: 3900 },
    { startMs: 4400, endMs: 6000 },
  ],
};

describe("transcript schema (AI-01)", () => {
  it("parses lens-transcribe output and keeps confidence, filler, inferred, pauses", () => {
    const t = parseTranscript(transcript);
    expect(t.language).toBe("en");
    expect(t.engine?.licence).toBe("MIT");
    expect(t.words).toHaveLength(5);
    expect(t.words[1]).toEqual({ text: "um,", startMs: 900, endMs: 1250, confidence: 0.4, filler: true });
    expect(t.words[3]!.inferred).toBe(true);
    expect(t.pauses).toHaveLength(7);
  });

  it("still accepts a bare word array (hand-written timings)", () => {
    const t = parseTranscript([{ text: "hi", startMs: 0, endMs: 200 }]);
    expect(t.words).toEqual([{ text: "hi", startMs: 0, endMs: 200 }]);
    expect(t.durationMs).toBe(200);
    expect(t.pauses).toBeUndefined();
  });

  it("rejects malformed transcripts", () => {
    expect(() => parseTranscript({ version: 2, words: [] })).toThrow(TranscriptError);
    expect(() => parseTranscript({ words: [{ text: "x", startMs: 5, endMs: 1 }] })).toThrow(/ends before/);
    expect(() => parseTranscript({ words: [{ text: "x", startMs: 0, endMs: 1, confidence: 2 }] })).toThrow(/confidence/);
    expect(() => parseTranscript({ words: "nope" })).toThrow(/array/);
  });

  it("a flagged filler counts even when its text is not in the list", () => {
    expect(isFiller({ text: "[filler]", startMs: 0, endMs: 1, filler: true })).toBe(true);
    expect(isFiller({ text: "Umm,", startMs: 0, endMs: 1 })).toBe(true);
    expect(isFiller({ text: "open", startMs: 0, endMs: 1 })).toBe(false);
  });
});

describe("cleanup from real timings (E03)", () => {
  const t = parseTranscript(transcript);

  it("cuts flagged fillers (recognised and VAD-inferred) inside their span with padding", () => {
    const cuts = cleanupCuts(t.words, 6000, DEFAULT_CLEANUP, { removeFillers: true, shortenPauses: false });
    expect(cuts).toEqual([
      { startMs: 930, endMs: 1220 },
      { startMs: 2030, endMs: 2270 },
    ]);
  });

  it("with measured pauses, a long gap is cut only through silence and fillers, never unknown speech", () => {
    const cuts = cleanupCuts(t.words, 6000, DEFAULT_CLEANUP, { removeFillers: true, shortenPauses: true, pauses: t.pauses });
    // gap open(1800) .. settings(3900) = 2100 ms > 900: cut [1975, 3725] clipped to silence+filler
    const inGap = cuts.filter((c) => c.startMs >= 1800 && c.endMs <= 3900);
    expect(inGap).toEqual([
      { startMs: 1975, endMs: 2900 },
      { startMs: 3200, endMs: 3725 },
    ]);
    for (const c of cuts) expect(c.endMs <= 2900 || c.startMs >= 3200).toBe(true);
    // trailing silence 4400..6000 shortened to keep 175 ms after the last word
    expect(cuts.some((c) => c.startMs === 4575 && c.endMs === 5825)).toBe(true);
  });

  it("without measured pauses the whole gap shortens (hand-written timings behave as before)", () => {
    const cuts = cleanupCuts(t.words, 6000, DEFAULT_CLEANUP, { removeFillers: true, shortenPauses: true });
    expect(cuts.some((c) => c.startMs === 1975 && c.endMs === 3725)).toBe(true);
  });

  it("when fillers stay, they are speech: neither cut nor counted as part of a pause", () => {
    const words: Word[] = [
      { text: "So", startMs: 0, endMs: 300 },
      { text: "um", startMs: 800, endMs: 1100, filler: true },
      { text: "yes", startMs: 1600, endMs: 1900 },
    ];
    expect(cleanupCuts(words, 1900, DEFAULT_CLEANUP, { removeFillers: false, shortenPauses: true })).toEqual([]);
    const both = cleanupCuts(words, 1900, DEFAULT_CLEANUP, { removeFillers: true, shortenPauses: true });
    expect(both).toEqual([{ startMs: 475, endMs: 1425 }]); // 1300 ms hesitation -> 350 ms
  });

  it("captions never show VAD placeholders, and hide fillers only when they are cut", () => {
    expect(captionWords(t.words, false).map((w) => w.text)).toEqual(["So,", "um,", "open", "settings."]);
    expect(captionWords(t.words, true).map((w) => w.text)).toEqual(["So,", "open", "settings."]);
  });
});

describe("plan with transcript cleanup", () => {
  const t = parseTranscript(transcript);
  const meta = { ...META, durationMs: 6000 };
  const base = { output: { fps: 30 as const }, captions: { enabled: true } };

  it("cleanup off: no cleanup cuts, captions carry the filler", () => {
    const plan = buildRenderPlan({ meta, events: demoSession().filter((e) => e.t < 6000), project: resolveProject(base), words: t.words, pauses: t.pauses });
    expect(plan.cleanupCuts).toEqual([]);
    expect(plan.output.durationMs).toBeCloseTo(6000, 0);
    const texts = new Set(plan.frames.flatMap((f) => (f.caption ? f.caption.words : [])));
    expect(texts.has("um,")).toBe(true);
    expect(texts.has("[filler]")).toBe(false);
  });

  it("cleanup on: fillers and long pauses leave the output, captions skip them", () => {
    const project = resolveProject({ ...base, edits: { cleanup: { enabled: true } } });
    const plan = buildRenderPlan({ meta, events: demoSession().filter((e) => e.t < 6000), project, words: t.words, pauses: t.pauses });
    const removed = plan.cleanupCuts.reduce((s, c) => s + c.endMs - c.startMs, 0);
    expect(removed).toBeGreaterThan(2500);
    expect(plan.output.durationMs).toBeCloseTo(6000 - removed, 0);
    expect(plan.cuts).toEqual(plan.cleanupCuts);
    // no output frame shows source time inside a filler's cut
    for (const f of plan.frames) expect(f.src > 930 && f.src < 1220).toBe(false);
    const texts = new Set(plan.frames.flatMap((f) => (f.caption ? f.caption.words : [])));
    expect([...texts].sort()).toEqual(["So,", "open", "settings."]);
    // audio follows the same cuts
    expect(plan.audio).toBeNull(); // no tracks in this project; mux is covered by the audio tests
  });

  it("manual cuts and cleanup cuts merge", () => {
    const project = resolveProject({ ...base, edits: { cuts: [{ startMs: 5000, endMs: 5500 }], cleanup: { enabled: true, shortenPauses: false } } });
    const plan = buildRenderPlan({ meta, events: [], project, words: t.words, pauses: t.pauses });
    expect(plan.cuts).toEqual([
      { startMs: 930, endMs: 1220 },
      { startMs: 2030, endMs: 2270 },
      { startMs: 5000, endMs: 5500 },
    ]);
  });
});

describe("project: cleanup + transcription config", () => {
  it("has safe defaults", () => {
    const p = resolveProject({});
    expect(p.edits.cleanup.enabled).toBe(false);
    expect(p.transcription).toEqual({ mode: "auto", track: null, model: "base.en", language: null });
  });

  it("validates", () => {
    expect(() => resolveProject({ edits: { cleanup: { keepPauseMs: 1000, maxPauseMs: 900 } } })).toThrow(ProjectValidationError);
    expect(() => resolveProject({ transcription: { mode: "always" } })).toThrow(/transcription.mode/);
    expect(() => resolveProject({ transcription: { track: "mic" } })).toThrow(/not an audio track/);
    expect(() =>
      resolveProject({ transcription: { track: "mic" }, audio: { tracks: [{ id: "mic", kind: "mic", path: "m.wav", offsetMs: 0, volume: 1, muted: false }] } }),
    ).not.toThrow();
  });
});
