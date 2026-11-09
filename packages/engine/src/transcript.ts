import { mergeRanges } from "./timeline.js";
import type { TimeRange, Word } from "./types.js";
import { visualOrderRtl } from "./translation.js";

/**
 * Transcript JSON written by the local speech-to-text (transcribe/lens_transcribe, lens-transcribe
 * CLI) and read by lens-plan --words. A bare Word[] (hand-written timings) is still accepted.
 * Times are recording time in ms (the transcriber adds the audio track's offset).
 */
export interface Transcript {
  version: 1;
  /** BCP-47-ish language code reported by the recogniser, e.g. "en". */
  language: string;
  languageProbability?: number;
  /** Length of the transcribed audio, ms. */
  durationMs: number;
  /** Shift already applied to every time (the audio track's offset on the recording clock). */
  offsetMs?: number;
  engine?: { name: string; model: string; licence: string };
  source?: { path?: string; trackId?: string };
  words: Word[];
  /**
   * Measured silences (energy VAD) not overlapping any spoken word, ms. When present, pause
   * shortening only ever cuts inside these, so speech the recogniser missed is never cut as a pause.
   */
  pauses?: TimeRange[];
}

export class TranscriptError extends Error {}

/** Accept a Transcript object or a bare Word[]; validate and return a normalised Transcript. */
export function parseTranscript(json: unknown): Transcript {
  const raw: Record<string, unknown> = Array.isArray(json) ? { version: 1, language: "", words: json } : (json as Record<string, unknown>);
  if (!raw || typeof raw !== "object") throw new TranscriptError("transcript must be an object or an array of words");
  if (raw.version !== undefined && raw.version !== 1) throw new TranscriptError(`unsupported transcript version ${String(raw.version)}`);
  if (!Array.isArray(raw.words)) throw new TranscriptError("transcript.words must be an array");
  const words: Word[] = raw.words.map((w: unknown, i: number) => {
    const o = w as Record<string, unknown>;
    if (typeof o?.text !== "string" || !Number.isFinite(o.startMs) || !Number.isFinite(o.endMs))
      throw new TranscriptError(`word ${i} needs text, startMs and endMs`);
    if ((o.endMs as number) < (o.startMs as number)) throw new TranscriptError(`word ${i} ends before it starts`);
    if (o.confidence !== undefined && !(Number(o.confidence) >= 0 && Number(o.confidence) <= 1))
      throw new TranscriptError(`word ${i} confidence must be within 0..1`);
    const out: Word = { text: o.text, startMs: o.startMs as number, endMs: o.endMs as number };
    if (o.confidence !== undefined) out.confidence = Number(o.confidence);
    if (o.filler === true) out.filler = true;
    if (o.inferred === true) out.inferred = true;
    return out;
  });
  words.sort((a, b) => a.startMs - b.startMs);
  const pauses = Array.isArray(raw.pauses)
    ? (raw.pauses as TimeRange[]).map((p, i) => {
        if (!Number.isFinite(p?.startMs) || !Number.isFinite(p?.endMs) || p.endMs < p.startMs) throw new TranscriptError(`pause ${i} invalid`);
        return { startMs: p.startMs, endMs: p.endMs };
      })
    : undefined;
  const durationMs = Number.isFinite(raw.durationMs) ? (raw.durationMs as number) : words.length ? words[words.length - 1]!.endMs : 0;
  const t: Transcript = { version: 1, language: typeof raw.language === "string" ? raw.language : "", durationMs, words };
  if (Number.isFinite(raw.languageProbability)) t.languageProbability = raw.languageProbability as number;
  if (Number.isFinite(raw.offsetMs)) t.offsetMs = raw.offsetMs as number;
  if (raw.engine && typeof raw.engine === "object") t.engine = raw.engine as Transcript["engine"];
  if (raw.source && typeof raw.source === "object") t.source = raw.source as Transcript["source"];
  if (pauses) t.pauses = pauses;
  return t;
}

export const DEFAULT_FILLERS = ["um", "uh", "erm", "er", "ah", "hmm", "mm", "uhm", "umm"];

export interface CleanupOptions {
  fillers: string[];
  /** Silences longer than this are shortened (E03). */
  maxPauseMs: number;
  /** How much of a long pause to keep, split across both sides. */
  keepPauseMs: number;
  /** Padding kept around removed fillers so speech does not clip. */
  padMs: number;
}

export const DEFAULT_CLEANUP: CleanupOptions = { fillers: DEFAULT_FILLERS, maxPauseMs: 900, keepPauseMs: 350, padMs: 30 };

function norm(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
}

/** A word is a filler when the transcriber flagged it or its text is in the filler list. */
export function isFiller(w: Word, fillers: string[] = DEFAULT_FILLERS): boolean {
  if (w.filler) return true;
  const n = norm(w.text);
  return fillers.some((f) => norm(f) === n);
}

export interface CleanupSelect {
  removeFillers: boolean;
  shortenPauses: boolean;
  /** Measured silences (Transcript.pauses); pause cuts are clipped to them when given. */
  pauses?: TimeRange[];
}

function intersect(a: TimeRange[], b: TimeRange[]): TimeRange[] {
  const out: TimeRange[] = [];
  for (const x of a) for (const y of b) {
    const s = Math.max(x.startMs, y.startMs);
    const e = Math.min(x.endMs, y.endMs);
    if (e > s) out.push({ startMs: s, endMs: e });
  }
  return out;
}

/**
 * Cut ranges that remove filler words and shorten long pauses (E03).
 *
 * Fillers are cut inside their span, keeping padMs at each side. A pause is the gap between two
 * spoken (non-filler) words, so "word, um, word" with a long hesitation counts as one pause; any
 * gap longer than maxPauseMs keeps keepPauseMs (half at each side). With measured pauses (from the
 * transcriber's VAD), the pause cut is clipped to measured silence plus filler spans, so voiced
 * audio the recogniser did not transcribe (and did not flag as a filler) is never cut.
 */
export function cleanupCuts(
  words: Word[],
  durationMs: number,
  opts: CleanupOptions = DEFAULT_CLEANUP,
  select: CleanupSelect = { removeFillers: true, shortenPauses: true },
): TimeRange[] {
  const fillerSet = new Set(opts.fillers.map(norm));
  const filler = (w: Word) => w.filler === true || fillerSet.has(norm(w.text));
  const cuts: TimeRange[] = [];
  // Fillers that stay are speech; fillers being removed are part of the pause around them.
  const spoken = select.removeFillers ? words.filter((w) => !filler(w)) : words;
  if (select.removeFillers) {
    for (const w of words) {
      if (filler(w)) cuts.push({ startMs: w.startMs + opts.padMs, endMs: w.endMs - opts.padMs });
    }
  }
  if (!select.shortenPauses) return mergeRanges(cuts.filter((c) => c.endMs > c.startMs));
  const pauseCuts: TimeRange[] = [];
  const keepHalf = opts.keepPauseMs / 2;
  if (!spoken.length) {
    // No words (no transcript yet, or nothing recognised): measured silences on the mic are the pauses
    // (Windows #17), each longer than maxPauseMs shortened to keepPauseMs.
    for (const p of select.pauses ?? []) {
      if (p.endMs - p.startMs > opts.maxPauseMs) pauseCuts.push({ startMs: p.startMs + keepHalf, endMs: p.endMs - keepHalf });
    }
    return mergeRanges([...cuts, ...pauseCuts].filter((c) => c.endMs > c.startMs));
  }
  const gaps: Array<[number, number]> = [];
  let prevEnd = 0;
  for (const w of spoken) {
    gaps.push([prevEnd, w.startMs]);
    prevEnd = w.endMs;
  }
  gaps.push([prevEnd, durationMs]);
  for (const [a, b] of gaps) {
    if (b - a <= opts.maxPauseMs) continue;
    const cut = { startMs: a + keepHalf, endMs: b - keepHalf };
    if (!select.pauses) {
      pauseCuts.push(cut);
      continue;
    }
    // Only measured silence (and fillers, when those are being removed) may go.
    const allowed = mergeRanges([
      ...select.pauses,
      ...(select.removeFillers ? words.filter(filler).map((w) => ({ startMs: w.startMs, endMs: w.endMs })) : []),
    ]);
    pauseCuts.push(...intersect([cut], allowed));
  }
  return mergeRanges([...cuts, ...pauseCuts].filter((c) => c.endMs > c.startMs));
}

/**
 * Words shown in captions: never VAD placeholders; fillers only when they are not being cut.
 */
export function captionWords(words: Word[], hideFillers: boolean, fillers: string[] = DEFAULT_FILLERS): Word[] {
  return words.filter((w) => !w.inferred && !(hideFillers && isFiller(w, fillers)));
}

/** Edit by transcript (E02): deleting words produces cuts; adjacent deletions merge. */
export function cutsForDeletedWords(words: Word[], deleted: number[]): TimeRange[] {
  const del = new Set(deleted);
  const cuts: TimeRange[] = [];
  words.forEach((w, i) => {
    if (!del.has(i)) return;
    // Extend into the gap up to the neighbouring kept word so the cut does not leave a stutter.
    const prev = words[i - 1];
    const next = words[i + 1];
    const start = prev && !del.has(i - 1) ? (prev.endMs + w.startMs) / 2 : w.startMs;
    // A deleted neighbour: run the cut right up to it so consecutive deletions join into one cut.
    const end = next ? (del.has(i + 1) ? next.startMs : (w.endMs + next.startMs) / 2) : w.endMs;
    cuts.push({ startMs: start, endMs: end });
  });
  return mergeRanges(cuts);
}

export interface CaptionBlock {
  startMs: number;
  endMs: number;
  text: string;
  words: Word[];
}

/**
 * Group words into caption blocks (G01/G02): break on punctuation, word count, duration, a change
 * of translated segment (demand #8), or when the block would need more than two lines of
 * maxCharsPerLine characters (0 = no character limit).
 */
export function captionBlocks(words: Word[], maxWords: number, maxBlockMs: number, maxCharsPerLine = 0): CaptionBlock[] {
  const out: CaptionBlock[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ startMs: cur[0]!.startMs, endMs: cur[cur.length - 1]!.endMs, text: cur.map((w) => w.text).join(" "), words: cur });
    cur = [];
  };
  const chars = (ws: Word[]) => ws.reduce((n, w) => n + [...w.text].length, 0) + Math.max(0, ws.length - 1);
  for (const w of words) {
    if (cur.length && (cur.length >= maxWords || w.endMs - cur[0]!.startMs > maxBlockMs)) flush();
    if (cur.length && w.segment !== cur[cur.length - 1]!.segment) flush();
    if (cur.length && maxCharsPerLine > 0 && chars([...cur, w]) > maxCharsPerLine * 2) flush();
    cur.push(w);
    if (/[.!?\u061F\u06D4]["')\]]?$/u.test(w.text)) flush();
  }
  flush();
  return out;
}

/**
 * Subtitle cues from caption blocks (SRT / VTT, demand #8): each block's text wrapped exactly like
 * the burned-in caption (lines joined with "\n"), times mapped by `toOut` (source -> output time;
 * null drops the block). Text is in logical order; players apply bidi for right-to-left languages.
 */
export function subtitleCues(
  blocks: CaptionBlock[],
  maxWordsPerLine: number,
  maxCharsPerLine: number,
  toOut: (srcMs: number) => number | null = (t) => t,
): Array<{ startMs: number; endMs: number; text: string }> {
  const cues: Array<{ startMs: number; endMs: number; text: string }> = [];
  for (const b of blocks) {
    const a = toOut(b.startMs);
    const e = toOut(b.endMs);
    if (a === null || e === null || e <= a) continue;
    const words = b.words.map((w) => w.text);
    const lines = wrapLines(words, maxWordsPerLine, maxCharsPerLine);
    let i = 0;
    const text = lines.map((n) => { const l = words.slice(i, i + n).join(" "); i += n; return l; }).join("\n");
    cues.push({ startMs: Math.round(a), endMs: Math.round(e), text });
  }
  return cues;
}

function srtTime(ms: number): string {
  const v = Math.max(0, Math.round(ms));
  const h = Math.floor(v / 3600000);
  const m = Math.floor((v % 3600000) / 60000);
  const s = Math.floor((v % 60000) / 1000);
  const r = v % 1000;
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

/** SRT export (G05). Pass blocks already mapped to output time. */
export function toSrt(blocks: Array<{ startMs: number; endMs: number; text: string }>): string {
  return blocks.map((b, i) => `${i + 1}\n${srtTime(b.startMs)} --> ${srtTime(b.endMs)}\n${b.text}\n`).join("\n");
}

function vttTime(ms: number): string {
  return srtTime(ms).replace(",", ".");
}

/**
 * WebVTT export (demand #8). Pass blocks already mapped to output time. A right-to-left track
 * gets `direction`-free cues (players apply the Unicode bidi algorithm to the text); the language
 * goes in a NOTE so the file stays valid for every player.
 */
export function toVtt(blocks: Array<{ startMs: number; endMs: number; text: string }>, language?: string): string {
  const head = language ? `WEBVTT\n\nNOTE language: ${language}\n` : "WEBVTT\n";
  return head + blocks.map((b, i) => `\n${i + 1}\n${vttTime(b.startMs)} --> ${vttTime(b.endMs)}\n${b.text.replace(/-->/g, "->")}\n`).join("");
}

/** WebVTT import: cues with optional identifiers and settings; NOTE / STYLE / REGION blocks skipped. */
export function parseVtt(text: string): Array<{ startMs: number; endMs: number; text: string }> {
  const toMs = (s: string) => {
    const m = /(?:(\d+):)?(\d+):(\d+)\.(\d+)/.exec(s);
    if (!m) throw new Error(`bad VTT time ${s}`);
    return +(m[1] ?? 0) * 3600000 + +m[2]! * 60000 + +m[3]! * 1000 + +m[4]!.padEnd(3, "0").slice(0, 3);
  };
  const body = text.replace(/\r/g, "").replace(/^\uFEFF/, "");
  if (!/^WEBVTT/.test(body)) throw new Error("not a WebVTT file");
  return body
    .split(/\n\s*\n/)
    .slice(1)
    .map((block) => block.trim().split("\n"))
    .filter((lines) => lines.length >= 2 || (lines.length === 1 && lines[0]!.includes("-->")))
    .filter((lines) => !/^(NOTE|STYLE|REGION)\b/.test(lines[0]!))
    .map((lines) => {
      const ti = lines.findIndex((l) => l.includes("-->"));
      const [a, b] = lines[ti]!.split("-->");
      return { startMs: toMs(a!.trim()), endMs: toMs(b!.trim().split(/\s+/)[0]!), text: lines.slice(ti + 1).join("\n") };
    });
}

/** SRT import (G04). */
export function parseSrt(text: string): Array<{ startMs: number; endMs: number; text: string }> {
  const toMs = (s: string) => {
    const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s);
    if (!m) throw new Error(`bad SRT time ${s}`);
    return +m[1]! * 3600000 + +m[2]! * 60000 + +m[3]! * 1000 + +m[4]!.padEnd(3, "0").slice(0, 3);
  };
  return text
    .replace(/\r/g, "")
    .split(/\n\s*\n/)
    .map((block) => block.trim().split("\n"))
    .filter((lines) => lines.length >= 2)
    .map((lines) => {
      const timeLine = lines[0]!.includes("-->") ? lines[0]! : lines[1]!;
      const textLines = lines.slice(lines[0]!.includes("-->") ? 1 : 2);
      const [a, b] = timeLine.split("-->");
      return { startMs: toMs(a!.trim()), endMs: toMs(b!.trim()), text: textLines.join("\n") };
    });
}

/** What the compositor draws for a caption on one frame (AI-03 styling). */
export interface CaptionFrame {
  text: string;
  words: string[];
  /** Word count of each line, after wrapping at maxWordsPerLine (and maxCharsPerLine). */
  lines: number[];
  /**
   * Index (within words) of the word to highlight: the word being spoken, or during a gap the
   * last word already spoken. -1 before the block's first word starts or when highlighting is off.
   */
  active: number;
  /**
   * Right-to-left caption (demand #8): for each line, the word indices in left-to-right drawing
   * order (word-level bidi). Absent for left-to-right captions, which draw in index order.
   */
  visual?: number[][];
}

export function wrapWords(count: number, maxWordsPerLine: number): number[] {
  const per = Math.max(1, Math.floor(maxWordsPerLine));
  const lines = Math.ceil(count / per);
  if (lines <= 1) return [count];
  // Balance lines so the last line is not a single orphan word.
  const base = Math.floor(count / lines);
  const extra = count % lines;
  return Array.from({ length: lines }, (_, i) => base + (i < extra ? 1 : 0));
}

const lineChars = (words: string[], a: number, b: number) => words.slice(a, b).reduce((n, w) => n + [...w].length, 0) + Math.max(0, b - a - 1);

/**
 * Line breaks for a caption: at most maxWordsPerLine words and (when maxCharsPerLine > 0) at most
 * maxCharsPerLine characters per line; a single longer word gets a line of its own. Uses the
 * word-count balance of wrapWords when that already fits, else the fewest lines that fit, balanced
 * by character count.
 */
export function wrapLines(words: string[], maxWordsPerLine: number, maxCharsPerLine = 0): number[] {
  const byCount = wrapWords(words.length, maxWordsPerLine);
  if (!(maxCharsPerLine > 0)) return byCount;
  const fits = (counts: number[]) => {
    let i = 0;
    for (const n of counts) {
      if (n > 1 && lineChars(words, i, i + n) > maxCharsPerLine) return false;
      i += n;
    }
    return true;
  };
  if (fits(byCount)) return byCount;
  const per = Math.max(1, Math.floor(maxWordsPerLine));
  for (let lines = byCount.length + 1; lines <= words.length; lines++) {
    const counts = balanceChars(words, lines, per, maxCharsPerLine);
    if (counts && fits(counts)) return counts;
  }
  return words.map(() => 1);
}

/** Split words into exactly `lines` lines, each ≤ per words, minimising the longest line (DP). */
function balanceChars(words: string[], lines: number, per: number, maxChars: number): number[] | null {
  const n = words.length;
  const INF = Number.POSITIVE_INFINITY;
  // best[k][i]: minimal max line length placing the first i words on k lines
  const best = Array.from({ length: lines + 1 }, () => new Array<number>(n + 1).fill(INF));
  const from = Array.from({ length: lines + 1 }, () => new Array<number>(n + 1).fill(-1));
  best[0]![0] = 0;
  for (let k = 1; k <= lines; k++)
    for (let i = 1; i <= n; i++)
      for (let j = Math.max(0, i - per); j < i; j++) {
        if (best[k - 1]![j] === INF) continue;
        const len = lineChars(words, j, i);
        const over = i - j > 1 && len > maxChars ? INF : len;
        const v = Math.max(best[k - 1]![j]!, over);
        if (v < best[k]![i]!) {
          best[k]![i] = v;
          from[k]![i] = j;
        }
      }
  if (best[lines]![n] === INF) return null;
  const counts: number[] = [];
  let i = n;
  for (let k = lines; k > 0; k--) {
    const j = from[k]![i]!;
    counts.unshift(i - j);
    i = j;
  }
  return counts;
}

export function activeWordIndex(words: Word[], tMs: number): number {
  let idx = -1;
  for (let i = 0; i < words.length; i++) if (tMs >= words[i]!.startMs) idx = i;
  return idx;
}

export function captionFrame(block: CaptionBlock, tMs: number, maxWordsPerLine: number, highlight: boolean, maxCharsPerLine = 0, rtl = false): CaptionFrame {
  const words = block.words.map((w) => w.text);
  const lines = wrapLines(words, maxWordsPerLine, maxCharsPerLine);
  const f: CaptionFrame = {
    text: block.text,
    words,
    lines,
    active: highlight ? activeWordIndex(block.words, tMs) : -1,
  };
  if (rtl) {
    let i = 0;
    f.visual = lines.map((n) => {
      const idx = Array.from({ length: n }, (_, k) => i + k);
      i += n;
      return visualOrderRtl(words, idx);
    });
  }
  return f;
}
