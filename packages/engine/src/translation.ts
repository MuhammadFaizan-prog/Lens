/**
 * Caption translation (demand #8): a project holds one caption track per language. Each track is a
 * list of segments; a segment is a span of the source transcript (a sentence or a phrase between
 * pauses) with its source text and its translation. Translation is done per segment on-device
 * (translate/lens-translate, local CTranslate2 models); this file only stores, re-times and lays
 * out the result.
 *
 * Re-timing: the translated words of a segment are spread over the time the speaker actually spoke
 * in that segment (the union of the surviving source words, gaps under 120 ms closed), weighted by
 * an estimate of each word's spoken length (syllables for alphabetic scripts, letters for abjads).
 * So every translated word lies inside its source segment, highlight moves forward monotonically,
 * pauses stay silent, and words cut from the edit take their time with them: a segment that loses
 * some source words to a cut squeezes its translation into the time that is left.
 */
import { mergeRanges } from "./timeline.js";
import type { FontFiles } from "./palette.js";
import type { TimeRange, Word } from "./types.js";

/**
 * Font for Arabic-script caption words (Arabic, Urdu, Persian): Noto Naskh Arabic, SIL Open Font
 * License 1.1, shipped in assets/fonts. Both renderers shape each word with HarfBuzz (PIL raqm /
 * the browser) so letters join and read right to left.
 */
export const ARABIC_FONT: FontFiles = { family: "Noto Naskh Arabic", regular: "builtin:NotoNaskhArabic-Regular.ttf", bold: "builtin:NotoNaskhArabic-Bold.ttf" };

export interface CaptionSegment {
  /** Stable id ("s12"); edits refer to it. */
  id: string;
  /** Recording time of the source segment (first source word start .. last source word end), ms. */
  startMs: number;
  endMs: number;
  /** Source text the translation was made from. */
  source: string;
  /** Translated text (one line; the layout wraps it). */
  text: string;
  /** Set when a person changed `text` after machine translation. */
  edited?: boolean;
}

export interface CaptionTrack {
  /** Target language code (ISO 639-1: "es", "ur"). */
  language: string;
  /** Display name ("Español"). */
  name?: string;
  /** Right-to-left script (Arabic, Urdu, Persian, Hebrew). */
  rtl: boolean;
  sourceLanguage: string;
  /** Model that made the machine translation. */
  engine?: { name: string; model: string; licence: string };
  segments: CaptionSegment[];
}

export interface TranslationSettings {
  /** Language the preview and the burned-in captions use; null = the source transcript. */
  language: string | null;
  tracks: CaptionTrack[];
}

export const RTL_LANGUAGES = ["ar", "ur", "fa", "he", "ps", "sd", "yi", "ug", "ckb"];

export function isRtlLanguage(code: string): boolean {
  return RTL_LANGUAGES.includes(code.toLowerCase().split(/[-_]/)[0]!);
}

/** Hebrew, Arabic (incl. Urdu / Persian letters), Syriac, Thaana, NKo, Arabic presentation forms. */
const RTL_CHAR = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u;
const ARABIC_CHAR = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/u;
const LTR_CHAR = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Devanagari}0-9]/u;

export function hasRtlChar(s: string): boolean {
  return RTL_CHAR.test(s);
}

/** Arabic-script text (Arabic, Urdu, Persian): needs a font with Arabic coverage and shaping. */
export function hasArabicScript(s: string): boolean {
  return ARABIC_CHAR.test(s);
}

/**
 * Estimated spoken length of a word in syllable-ish units. Alphabetic scripts: vowel groups after
 * removing diacritics (é -> e). Arabic script (short vowels unwritten): about one syllable per two
 * letters. Anything else (CJK, digits, symbols): one unit per character, at least one.
 */
export function syllableWeight(word: string): number {
  const base = word.normalize("NFD").replace(/\p{M}/gu, "");
  const letters = base.replace(/[^\p{L}\p{N}]/gu, "");
  if (!letters) return 0.3; // a dash or a lone punctuation mark
  if (hasArabicScript(letters) || /[\u0590-\u05FF]/u.test(letters)) return Math.max(1, Math.round(letters.length / 2));
  if (/^\p{N}+$/u.test(letters)) return Math.max(1, letters.length * 0.8);
  const groups = base.toLowerCase().match(/[aeiouyæøœɛɔ]+/g);
  if (groups && /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]/u.test(letters)) return Math.max(1, groups.length);
  if (/[\p{Script=Cyrillic}]/u.test(letters)) return Math.max(1, (letters.match(/[аеёиоуыэюя]/giu) ?? []).length);
  return Math.max(1, letters.length);
}

/** Split translated text into display words (whitespace-separated, empty pieces dropped). */
export function splitWords(text: string): string[] {
  return text.split(/\s+/u).filter((w) => w.length > 0);
}

const GAP_CLOSE_MS = 120;

/**
 * The spans of a segment where the speaker is talking: source words in [startMs, endMs] (never VAD
 * placeholders), minus cuts, gaps up to 120 ms closed. With no source words (an imported subtitle
 * track), the whole segment minus cuts.
 */
export function speechSpans(seg: TimeRange, sourceWords: Word[] | null, cuts: TimeRange[] = []): TimeRange[] {
  let spans: TimeRange[];
  if (sourceWords && sourceWords.length) {
    spans = sourceWords
      .filter((w) => !w.inferred && w.endMs > seg.startMs && w.startMs < seg.endMs)
      .map((w) => ({ startMs: Math.max(seg.startMs, w.startMs), endMs: Math.min(seg.endMs, w.endMs) }))
      .filter((r) => r.endMs > r.startMs);
    if (!spans.length) spans = [{ startMs: seg.startMs, endMs: seg.endMs }];
  } else spans = [{ startMs: seg.startMs, endMs: seg.endMs }];
  spans = subtract(mergeRanges(spans), mergeRanges(cuts));
  // close short gaps (between words) so highlight does not blink off between them
  const out: TimeRange[] = [];
  for (const r of spans) {
    const last = out[out.length - 1];
    const cutBetween = last && cuts.some((c) => c.startMs < r.startMs && c.endMs > last.endMs);
    if (last && !cutBetween && r.startMs - last.endMs <= GAP_CLOSE_MS) last.endMs = r.endMs;
    else out.push({ ...r });
  }
  return out;
}

function subtract(a: TimeRange[], cuts: TimeRange[]): TimeRange[] {
  let cur = a;
  for (const c of cuts) {
    const next: TimeRange[] = [];
    for (const r of cur) {
      if (c.endMs <= r.startMs || c.startMs >= r.endMs) next.push(r);
      else {
        if (c.startMs > r.startMs) next.push({ startMs: r.startMs, endMs: c.startMs });
        if (c.endMs < r.endMs) next.push({ startMs: c.endMs, endMs: r.endMs });
      }
    }
    cur = next;
  }
  return cur.filter((r) => r.endMs - r.startMs > 1e-6);
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Translated words with times: spread over `spans` (speech time) in proportion to syllableWeight.
 * Words get [start, end) on the recording clock, contiguous within a span, inside the spans, in
 * order. Empty when there is no text or no time left.
 */
export function retimeWords(text: string, spans: TimeRange[]): Word[] {
  const words = splitWords(text);
  const total = spans.reduce((s, r) => s + (r.endMs - r.startMs), 0);
  if (!words.length || total <= 0) return [];
  const weights = words.map(syllableWeight);
  const W = weights.reduce((a, b) => a + b, 0);
  // speech-time offset -> recording time; `end` picks the earlier span at a boundary
  const at = (x: number, end: boolean): number => {
    let acc = 0;
    for (const r of spans) {
      const len = r.endMs - r.startMs;
      if (x < acc + len || (end ? x <= acc + len : false)) return r.startMs + (x - acc);
      acc += len;
    }
    return spans[spans.length - 1]!.endMs;
  };
  const out: Word[] = [];
  let cum = 0;
  words.forEach((w, i) => {
    const a = (cum / W) * total;
    cum += weights[i]!;
    const b = i === words.length - 1 ? total : (cum / W) * total;
    const s = at(a, false);
    let e = at(b, true);
    // a word that would straddle a pause ends where its span ends (it is not spoken in the pause)
    const span = spans.find((r) => s >= r.startMs && s < r.endMs);
    if (span && e > span.endMs) e = span.endMs;
    out.push({ text: w, startMs: r2(s), endMs: r2(Math.max(s, e)) });
  });
  return out;
}

/** Translated words of a whole track, each tagged with its segment index (blocks never cross segments). */
export function trackWords(track: CaptionTrack, sourceWords: Word[] | null, cuts: TimeRange[] = []): Word[] {
  const out: Word[] = [];
  track.segments.forEach((seg, i) => {
    const spans = speechSpans(seg, sourceWords, cuts);
    for (const w of retimeWords(seg.text, spans)) out.push({ ...w, segment: i });
  });
  return out;
}

export interface SegmentOptions {
  /** Close a segment at a pause longer than this. */
  pauseMs: number;
  /** Close a segment once it has this many words (at a comma if there is one in the last third). */
  maxWords: number;
  /** Close a segment once it is this long. */
  maxMs: number;
}

export const DEFAULT_SEGMENTS: SegmentOptions = { pauseMs: 700, maxWords: 24, maxMs: 9000 };

/**
 * Source segments to translate: sentences, broken at long pauses and at length limits. Fillers and
 * VAD placeholders are left out of the source text (they are not translated) but stay inside the span.
 * Mirrors translate/lens_translate/segment.py (pytest checks both agree).
 */
export function segmentTranscript(words: Word[], hideFillers: (w: Word) => boolean, opts: SegmentOptions = DEFAULT_SEGMENTS): Array<{ startMs: number; endMs: number; source: string }> {
  const ws = words.filter((w) => !w.inferred && !hideFillers(w));
  const out: Array<{ startMs: number; endMs: number; source: string }> = [];
  let cur: Word[] = [];
  const flush = (n = cur.length) => {
    if (!n) return;
    const take = cur.slice(0, n);
    out.push({ startMs: take[0]!.startMs, endMs: take[take.length - 1]!.endMs, source: take.map((w) => w.text).join(" ") });
    cur = cur.slice(n);
  };
  for (const w of ws) {
    const prev = cur[cur.length - 1];
    if (prev && w.startMs - prev.endMs > opts.pauseMs) flush();
    if (cur.length && (cur.length >= opts.maxWords || w.endMs - cur[0]!.startMs > opts.maxMs)) {
      // prefer a comma in the last third
      let cut = cur.length;
      for (let i = cur.length - 1; i >= Math.floor((cur.length * 2) / 3); i--) if (/[,;:]$/.test(cur[i]!.text)) { cut = i + 1; break; }
      flush(cut);
    }
    cur.push(w);
    if (/[.!?]["')\]]?$/.test(w.text)) flush();
  }
  flush();
  return out;
}

/**
 * Word-level bidi for a right-to-left caption line: the left-to-right drawing order of word indices.
 * Runs of left-to-right words (Latin names, numbers) keep their own order; the runs are laid out
 * right to left. Neutral words (punctuation only) take the paragraph direction. Each word is shaped
 * on its own, so within a word the font's shaper applies (joining, marks, RTL glyph order).
 */
export function visualOrderRtl(words: string[], indices: number[]): number[] {
  const runs: Array<{ ltr: boolean; idx: number[] }> = [];
  for (const i of indices) {
    const w = words[i]!;
    const ltr = !hasRtlChar(w) && LTR_CHAR.test(w);
    const last = runs[runs.length - 1];
    if (last && last.ltr === ltr && ltr) last.idx.push(i);
    else runs.push({ ltr, idx: [i] });
  }
  return runs.reverse().flatMap((r) => r.idx);
}

/** Validate the translations block of a project; returns error strings. */
export function validateTranslations(t: TranslationSettings | undefined): string[] {
  const errs: string[] = [];
  if (!t) return errs;
  if (!Array.isArray(t.tracks)) return ["translations.tracks must be a list"];
  const seen = new Set<string>();
  t.tracks.forEach((tr, i) => {
    if (typeof tr?.language !== "string" || !/^[a-z]{2,3}([-_][A-Za-z0-9]+)?$/.test(tr.language)) errs.push(`translations.tracks[${i}].language must be a language code`);
    else if (seen.has(tr.language)) errs.push(`translations.tracks has two ${tr.language} tracks`);
    else seen.add(tr.language);
    if (!Array.isArray(tr?.segments)) errs.push(`translations.tracks[${i}].segments must be a list`);
    else tr.segments.forEach((s, j) => {
      if (!Number.isFinite(s?.startMs) || !Number.isFinite(s?.endMs) || s.endMs < s.startMs || typeof s.text !== "string")
        errs.push(`translations.tracks[${i}].segments[${j}] needs startMs <= endMs and text`);
    });
  });
  if (t.language !== null && t.language !== undefined && !t.tracks.some((tr) => tr.language === t.language))
    errs.push(`translations.language ${t.language} has no track`);
  return errs;
}

/** Replace one segment's translated text (side-by-side editing); returns a new track. */
export function editSegment(track: CaptionTrack, id: string, text: string): CaptionTrack {
  return { ...track, segments: track.segments.map((s) => (s.id === id ? { ...s, text: text.replace(/\s+/g, " ").trim(), edited: true } : s)) };
}

/** Add or replace a track (by language). */
export function upsertTrack(t: TranslationSettings, track: CaptionTrack): TranslationSettings {
  const tracks = t.tracks.filter((x) => x.language !== track.language);
  return { ...t, tracks: [...tracks, track] };
}
