/**
 * Narration after the fact (demand #17, docs/Voiceover.md): audio clips on a Voiceover lane, either
 * imported files or takes recorded in the app for one transcript line. Each clip is anchored at a
 * recording-clock time (so it follows cuts like everything else), plays at normal speed from the
 * output time of that anchor, trimmed to [trimStartMs, trimEndMs) of its file, at its own gain.
 *
 * In the audio plan the clips become `voice` pieces on the output clock; the preview schedules them
 * with Web Audio and both exports mix them after the recording's cleanup (denoise / loudness apply
 * to the recorded tracks only), so a clip sounds at the level it was set to. Clips never change the
 * picture, and a project without `voiceover` plans exactly as before.
 */
import type { TimelinePiece } from "./timeline.js";
import { sourceToOutput } from "./timeline.js";
import type { Word } from "./types.js";

export interface VoiceClip {
  id: string;
  /** Shown on the lane: the file name or the transcript line it was recorded for. */
  name: string;
  /** Audio file inside the project folder (voiceover/<file>), or an absolute path. */
  path: string;
  /** Length of the whole file in ms. */
  fileMs: number;
  /** Anchor on the recording clock (ms): where the clip starts playing. */
  srcMs: number;
  /** Part of the file that plays: [trimStartMs, trimEndMs). */
  trimStartMs: number;
  trimEndMs: number;
  /** Gain in dB (-40 .. +12). */
  gainDb: number;
  muted?: boolean;
  /** The transcript line it was recorded for (per-line voiceover). */
  line?: { startMs: number; endMs: number; text: string };
}

export interface VoiceoverSettings {
  clips: VoiceClip[];
}

/** A clip on the output clock (plan.audio.voice). */
export interface VoicePiece {
  id: string;
  path: string;
  /** Output time (ms) of the clip's first played sample. */
  outMs: number;
  /** Offset into the file (ms) of that sample. */
  fileOffsetMs: number;
  /** How long it plays (ms), never past the end of the output. */
  durMs: number;
  /** Linear gain. */
  gain: number;
}

export const dbToGain = (db: number) => Math.pow(10, db / 20);
export const clipLengthMs = (c: Pick<VoiceClip, "trimStartMs" | "trimEndMs">) => Math.max(0, c.trimEndMs - c.trimStartMs);

/** Output time of a recording-clock anchor; an anchor inside a cut moves to where the recording resumes. */
export function anchorToOutput(timeline: TimelinePiece[], srcMs: number): number | null {
  const o = sourceToOutput(timeline, srcMs);
  if (o !== null) return o;
  const next = timeline.find((p) => p.srcStart >= srcMs && p.srcEnd > p.srcStart);
  return next ? next.outStart : null;
}

/** The clips as the export plays them (muted / empty / past-the-end clips left out), by output time. */
export function voicePieces(v: VoiceoverSettings | undefined, timeline: TimelinePiece[], durationMs: number): VoicePiece[] {
  if (!v?.clips.length) return [];
  const out: VoicePiece[] = [];
  for (const c of v.clips) {
    if (c.muted) continue;
    const len = clipLengthMs(c);
    const o = anchorToOutput(timeline, c.srcMs);
    if (o === null || len <= 0 || o >= durationMs) continue;
    out.push({ id: c.id, path: c.path, outMs: Math.round(o * 100) / 100, fileOffsetMs: c.trimStartMs, durMs: Math.round(Math.min(len, durationMs - o) * 100) / 100, gain: Math.round(dbToGain(c.gainDb) * 1e6) / 1e6 });
  }
  return out.sort((a, b) => a.outMs - b.outMs || a.id.localeCompare(b.id));
}

// ------------------------------------------------------------------ transcript lines

export interface TranscriptLine {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

/**
 * The transcript split into lines to narrate: a sentence ends at . ? ! or a pause of `pauseMs`, and a
 * line holds at most `maxWords` words. Fillers and placeholder words are left out.
 */
export function transcriptLines(words: Word[], pauseMs = 600, maxWords = 20): TranscriptLine[] {
  const ws = words.filter((w) => !w.filler && !w.inferred && !/^\[.*\]$/.test(w.text.trim()) && w.text.trim());
  const out: TranscriptLine[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ index: out.length, startMs: cur[0]!.startMs, endMs: cur[cur.length - 1]!.endMs, text: cur.map((w) => w.text.trim()).join(" ") });
    cur = [];
  };
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]!;
    if (cur.length && w.startMs - cur[cur.length - 1]!.endMs >= pauseMs) flush();
    cur.push(w);
    if (/[.?!]["')\]]*$/.test(w.text.trim()) || cur.length >= maxWords) flush();
  }
  flush();
  return out;
}

// ------------------------------------------------------------------ edits

export function addVoiceClip(v: VoiceoverSettings | undefined, c: VoiceClip): VoiceoverSettings {
  return { clips: [...(v?.clips ?? []).filter((x) => x.id !== c.id), c].sort((a, b) => a.srcMs - b.srcMs || a.id.localeCompare(b.id)) };
}

export function updateVoiceClip(v: VoiceoverSettings | undefined, id: string, patch: Partial<Omit<VoiceClip, "id">>): VoiceoverSettings {
  const clips = (v?.clips ?? []).map((c) => {
    if (c.id !== id) return c;
    const n = { ...c, ...patch };
    n.srcMs = Math.max(0, Math.round(n.srcMs));
    n.trimStartMs = Math.max(0, Math.min(n.fileMs - 10, Math.round(n.trimStartMs)));
    n.trimEndMs = Math.max(n.trimStartMs + 10, Math.min(n.fileMs, Math.round(n.trimEndMs)));
    n.gainDb = Math.max(-40, Math.min(12, Math.round(n.gainDb * 10) / 10));
    return n;
  });
  return { clips: clips.sort((a, b) => a.srcMs - b.srcMs || a.id.localeCompare(b.id)) };
}

export function removeVoiceClip(v: VoiceoverSettings | undefined, id: string): VoiceoverSettings | undefined {
  const clips = (v?.clips ?? []).filter((c) => c.id !== id);
  return clips.length ? { clips } : undefined;
}

export function validateVoiceover(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  const o = v as Record<string, unknown>;
  if (typeof o !== "object" || !Array.isArray(o.clips)) return ["voiceover must be {clips: [...]}"];
  const ids = new Set<string>();
  for (const it of o.clips as unknown[]) {
    const c = it as Record<string, unknown>;
    const fin = (k: string) => Number.isFinite(c?.[k]);
    if (!c || typeof c.id !== "string" || ids.has(c.id) || typeof c.path !== "string" || !c.path || typeof c.name !== "string" || !fin("fileMs") || !fin("srcMs") || !fin("trimStartMs") || !fin("trimEndMs") || !fin("gainDb"))
      return ["voiceover.clips[] must be {id (unique), name, path, fileMs, srcMs, trimStartMs, trimEndMs, gainDb}"];
    ids.add(c.id);
    if ((c.srcMs as number) < 0 || (c.trimStartMs as number) < 0 || (c.trimEndMs as number) <= (c.trimStartMs as number) || (c.gainDb as number) < -40 || (c.gainDb as number) > 12)
      return [`voiceover clip ${c.id}: srcMs and trimStartMs >= 0, trimEndMs > trimStartMs, gainDb within -40..12`];
  }
  return [];
}
