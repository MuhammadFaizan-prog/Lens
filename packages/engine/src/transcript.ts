import { mergeRanges } from "./timeline.js";
import type { TimeRange, Word } from "./types.js";

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

/** Cut ranges that remove filler words and shorten long pauses (E03). */
export function cleanupCuts(words: Word[], durationMs: number, opts: CleanupOptions = DEFAULT_CLEANUP): TimeRange[] {
  const fillers = new Set(opts.fillers.map(norm));
  const cuts: TimeRange[] = [];
  const spoken = words.filter((w) => !fillers.has(norm(w.text)));
  for (const w of words) {
    if (fillers.has(norm(w.text))) cuts.push({ startMs: w.startMs + opts.padMs, endMs: w.endMs - opts.padMs });
  }
  const gaps: Array<[number, number]> = [];
  let prevEnd = 0;
  for (const w of spoken) {
    gaps.push([prevEnd, w.startMs]);
    prevEnd = w.endMs;
  }
  gaps.push([prevEnd, durationMs]);
  for (const [a, b] of gaps) {
    if (b - a > opts.maxPauseMs) {
      const keepHalf = opts.keepPauseMs / 2;
      cuts.push({ startMs: a + keepHalf, endMs: b - keepHalf });
    }
  }
  return mergeRanges(cuts.filter((c) => c.endMs > c.startMs));
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

/** Group words into caption blocks (G01/G02): break on punctuation, word count, or duration. */
export function captionBlocks(words: Word[], maxWords: number, maxBlockMs: number): CaptionBlock[] {
  const out: CaptionBlock[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ startMs: cur[0]!.startMs, endMs: cur[cur.length - 1]!.endMs, text: cur.map((w) => w.text).join(" "), words: cur });
    cur = [];
  };
  for (const w of words) {
    if (cur.length && (cur.length >= maxWords || w.endMs - cur[0]!.startMs > maxBlockMs)) flush();
    cur.push(w);
    if (/[.!?]$/.test(w.text)) flush();
  }
  flush();
  return out;
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
  /** Word count of each line, after wrapping at maxWordsPerLine. */
  lines: number[];
  /**
   * Index (within words) of the word to highlight: the word being spoken, or during a gap the
   * last word already spoken. -1 before the block's first word starts or when highlighting is off.
   */
  active: number;
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

export function activeWordIndex(words: Word[], tMs: number): number {
  let idx = -1;
  for (let i = 0; i < words.length; i++) if (tMs >= words[i]!.startMs) idx = i;
  return idx;
}

export function captionFrame(block: CaptionBlock, tMs: number, maxWordsPerLine: number, highlight: boolean): CaptionFrame {
  return {
    text: block.text,
    words: block.words.map((w) => w.text),
    lines: wrapWords(block.words.length, maxWordsPerLine),
    active: highlight ? activeWordIndex(block.words, tMs) : -1,
  };
}
