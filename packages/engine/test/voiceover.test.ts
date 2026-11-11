/**
 * Voiceover clips (demand #17): placement on the output clock through cuts and speed ranges, trims,
 * gain, transcript lines, validation, and projects without voiceover planning exactly as before.
 */
import { describe, expect, it } from "vitest";
import { addVoiceClip, buildRenderPlan, dbToGain, removeVoiceClip, resolveProject, transcriptLines, updateVoiceClip, voicePieces, type VoiceClip, type Word } from "../src/index.js";
import { demoSession, META } from "./fixtures.js";

const clip = (over: Partial<VoiceClip> = {}): VoiceClip => ({ id: "v1", name: "a.wav", path: "voiceover/a.wav", fileMs: 2000, srcMs: 1000, trimStartMs: 0, trimEndMs: 2000, gainDb: 0, ...over });
const planOf = (patch: Record<string, unknown>) => buildRenderPlan({ meta: META, events: demoSession(), project: resolveProject({ output: { aspect: "16:9", resolution: 360, fps: 30 }, ...patch }) });

describe("voiceover (demand #17)", () => {
  it("projects without voiceover plan identically; a clip only adds audio.voice", () => {
    const a = planOf({});
    const b = planOf({ voiceover: { clips: [clip()] } });
    expect(JSON.stringify(planOf({ voiceover: undefined }))).toBe(JSON.stringify(a));
    expect(a.audio?.voice).toBeUndefined();
    expect(b.audio!.voice).toEqual([{ id: "v1", path: "voiceover/a.wav", outMs: 1000, fileOffsetMs: 0, durMs: 2000, gain: 1 }]);
    expect(JSON.stringify(b.frames)).toBe(JSON.stringify(a.frames));
  });

  it("a silent project with a clip still gets an audio plan", () => {
    const p = planOf({ audio: { tracks: [] }, cursor: { clickSound: false }, voiceover: { clips: [clip()] } });
    expect(p.audio).not.toBeNull();
    expect(p.audio!.tracks).toHaveLength(0);
    expect(p.audio!.voice).toHaveLength(1);
  });

  it("follows cuts and speed ranges; plays at normal speed; trims and gain", () => {
    // 500 ms cut before the anchor: the clip moves 500 ms earlier on the output clock
    const cut = planOf({ edits: { cuts: [{ startMs: 200, endMs: 700 }] }, voiceover: { clips: [clip({ trimStartMs: 300, trimEndMs: 1100, gainDb: -6 })] } });
    expect(cut.audio!.voice![0]).toMatchObject({ outMs: 500, fileOffsetMs: 300, durMs: 800 });
    expect(cut.audio!.voice![0]!.gain).toBeCloseTo(dbToGain(-6), 6);
    // anchor inside a cut: where the recording resumes
    const inCut = planOf({ edits: { cuts: [{ startMs: 800, endMs: 1500 }] }, voiceover: { clips: [clip()] } });
    expect(inCut.audio!.voice![0]!.outMs).toBe(800);
    // 2x speed before the anchor: output time halves there, the clip still plays 2000 ms
    const fast = planOf({ edits: { speed: [{ startMs: 0, endMs: 1000, rate: 2 }] }, voiceover: { clips: [clip()] } });
    expect(fast.audio!.voice![0]).toMatchObject({ outMs: 500, durMs: 2000 });
    // past the end: clipped to the output
    const end = planOf({ voiceover: { clips: [clip({ srcMs: 11000 })] } });
    expect(end.audio!.voice![0]!.durMs).toBe(1000);
    expect(voicePieces({ clips: [clip({ muted: true })] }, [{ srcStart: 0, srcEnd: 5000, outStart: 0, outEnd: 5000, rate: 1 }] as never, 5000)).toEqual([]);
  });

  it("edits clamp trims and gain; remove drops the block when empty", () => {
    let v = addVoiceClip(undefined, clip());
    v = updateVoiceClip(v, "v1", { trimStartMs: -50, trimEndMs: 9000, gainDb: 30, srcMs: 1234.4 });
    expect(v.clips[0]).toMatchObject({ trimStartMs: 0, trimEndMs: 2000, gainDb: 12, srcMs: 1234 });
    v = updateVoiceClip(v, "v1", { trimStartMs: 1995 });
    expect(v.clips[0]!.trimEndMs).toBeGreaterThan(v.clips[0]!.trimStartMs);
    expect(removeVoiceClip(v, "v1")).toBeUndefined();
  });

  it("transcript lines split at sentence ends and pauses, fillers left out", () => {
    const w = (text: string, startMs: number, endMs: number, extra: Partial<Word> = {}): Word => ({ text, startMs, endMs, ...extra });
    const lines = transcriptLines([w("Open", 0, 200), w("settings.", 220, 500), w("um", 520, 600, { filler: true }), w("Then", 700, 900), w("click", 920, 1100), w("save", 2000, 2300)]);
    expect(lines.map((l) => [l.text, l.startMs, l.endMs])).toEqual([["Open settings.", 0, 500], ["Then click", 700, 1100], ["save", 2000, 2300]]);
  });

  it("validation", () => {
    expect(() => resolveProject({ voiceover: { clips: [clip({ trimEndMs: 0 })] } })).toThrow(/voiceover/);
    expect(() => resolveProject({ voiceover: { clips: [clip(), clip()] } })).toThrow(/unique/);
    expect(() => resolveProject({ voiceover: { clips: [clip({ gainDb: 20 })] } })).toThrow(/gainDb/);
  });
});
