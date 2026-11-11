/**
 * Title, description and chapters from the transcript, on the device (demand #27, docs/Chapters.md).
 *
 * No model and no network: a deterministic extractive pipeline in TypeScript, so it runs the same in
 * the desktop app (no Python) and the browser.
 *
 *   1. Sentences: words split at . ? ! , at pauses over 900 ms, or every 30 words; fillers and
 *      placeholder words dropped; words inside cuts are left out by the caller.
 *   2. Tokens: lower-cased, stop words dropped, a light suffix stemmer (plural, -ing, -ed, -ly).
 *   3. Chapters: TextTiling-style lexical cohesion. For each gap between sentences, the TF-IDF
 *      cosine similarity of the k sentences before and after it; a gap's depth is how far it dips
 *      below the nearest peaks on both sides. The deepest gaps above mean + 0.25 sd become chapter
 *      starts, each chapter at least `minChapterMs` long on the output clock (YouTube: 10 s).
 *   4. Chapter titles: the best key phrase of the chapter (runs of content words, scored by the
 *      words' frequency in the chapter times their rarity in the other chapters).
 *   5. Video title: TextRank over the word co-occurrence graph (window 3, damping 0.85), the top two
 *      key phrases. Description: TextRank over sentences (word-overlap similarity), the top three
 *      sentences in spoken order.
 *
 * Everything is extractive: every word of a title and every description sentence comes from the
 * transcript, so the draft never claims anything the speaker did not say.
 */
import type { Word } from "./types.js";
import { sourceToOutput, type TimelinePiece } from "./timeline.js";

// ---------------------------------------------------------------- text

const STOP = new Set(
  ("a about above after again against all am an and any are aren't as at be because been before being below between both but by can can't cannot could " +
    "couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here " +
    "here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my myself no nor not of off on " +
    "once only or other ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some such than that that's the their theirs " +
    "them themselves then there there's these they they'd they'll they're they've this those through to too under until up very was wasn't we we'd we'll we're " +
    "we've were weren't what what's when when's where where's which while who who's whom why why's with won't would wouldn't you you'd you'll you're you've your " +
    "yours yourself yourselves also just now then so okay ok yeah right really actually basically like get got gets going go goes gonna want wanna let lets " +
    "thing things stuff way one two three first next last see look looks make makes made use using used need needs here's there will can just um uh er ah hmm " +
    "kind sort lot lots bit little much many well even still back around every something anything everything today anyone everyone someone nothing whatever")
    .split(/\s+/),
);

const clean = (t: string) => t.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9']+/g, "").replace(/^'+|'+$/g, "");

/** Light suffix stemmer: enough that "exports / exporting / exported" meet, never longer than the word. */
export function stem(w: string): string {
  let s = w.replace(/'s$/, "");
  if (s.length > 4 && s.endsWith("ies")) s = s.slice(0, -3) + "y";
  else if (s.length > 4 && s.endsWith("sses")) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s") && !/(ss|us|is)$/.test(s)) s = s.slice(0, -1);
  if (s.length > 5 && s.endsWith("ing")) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith("ed")) s = s.slice(0, -2);
  else if (s.length > 4 && s.endsWith("ly")) s = s.slice(0, -2);
  if (s.length > 3 && /([b-df-hj-np-tv-z])\1$/.test(s) && !/(ll|ss|zz)$/.test(s)) s = s.slice(0, -1);
  if (s.length > 4 && s.endsWith("e")) s = s.slice(0, -1);
  return s;
}

export const isContent = (t: string) => t.length >= 2 && !STOP.has(t) && !/^\d+$/.test(t);

export interface Sentence {
  index: number;
  startMs: number;
  endMs: number;
  /** The spoken words, as written by the recogniser. */
  words: string[];
  text: string;
  /** Stems of the content words. */
  stems: string[];
}

const isPlaceholder = (w: Word) => w.filler || w.inferred || /^\[.*\]$/.test(w.text.trim());

/** Split the transcript into sentences (punctuation, pauses over `pauseMs`, at most `maxWords`). */
export function sentencesOf(words: Word[], pauseMs = 900, maxWords = 30): Sentence[] {
  const out: Sentence[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    const ws = cur.map((w) => w.text.trim()).filter(Boolean);
    const text = ws.join(" ").replace(/\s+([,.!?;:])/g, "$1");
    const stems = ws.map(clean).filter(isContent).map(stem);
    out.push({ index: out.length, startMs: cur[0]!.startMs, endMs: cur[cur.length - 1]!.endMs, words: ws, text, stems });
    cur = [];
  };
  const list = words.filter((w) => !isPlaceholder(w) && w.text.trim()).sort((a, b) => a.startMs - b.startMs);
  list.forEach((w, i) => {
    const prev = cur[cur.length - 1];
    if (prev && w.startMs - prev.endMs > pauseMs) flush();
    cur.push(w);
    const next = list[i + 1];
    if (/[.!?]["')\]]*$/.test(w.text.trim()) || cur.length >= maxWords || !next) flush();
  });
  flush();
  return out;
}

// ---------------------------------------------------------------- vectors

type Vec = Map<string, number>;

function idfOf(docs: string[][]): Map<string, number> {
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length;
  const idf = new Map<string, number>();
  for (const [t, c] of df) idf.set(t, Math.log((n + 1) / (c + 0.5)));
  return idf;
}

function vecOf(tokens: string[], idf: Map<string, number>): Vec {
  const v: Vec = new Map();
  for (const t of tokens) v.set(t, (v.get(t) ?? 0) + (idf.get(t) ?? 0));
  return v;
}

function cosine(a: Vec, b: Vec): number {
  let dot = 0, na = 0, nb = 0;
  for (const [t, x] of a) {
    na += x * x;
    const y = b.get(t);
    if (y) dot += x * y;
  }
  for (const y of b.values()) nb += y * y;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// ---------------------------------------------------------------- chapters

export interface ChapterOptions {
  /** Source ms -> output ms (null = cut); default identity. */
  toOutput?: (srcMs: number) => number | null;
  /** Output length in ms (end of the last chapter). */
  durationMs?: number;
  /** Shortest chapter on the output clock; YouTube needs 10 s. Default max(10 s, duration / 15). */
  minChapterMs?: number;
  /** Most chapters to draft. Default 12. */
  maxChapters?: number;
  /** Sentences compared on each side of a gap. Default 3. */
  window?: number;
}

export interface Segment {
  /** First sentence of the chapter. */
  from: number;
  /** One past its last sentence. */
  to: number;
}

/**
 * TextTiling over sentences: the sentence indices where chapters start (0 always first), and the
 * gap scores / depths it chose from (for tests and tuning).
 */
export function segmentSentences(sents: Sentence[], opts: ChapterOptions = {}): { starts: number[]; sims: number[]; depths: number[] } {
  const n = sents.length;
  if (n < 4) return { starts: [0], sims: [], depths: [] };
  const toOut = opts.toOutput ?? ((s: number) => s);
  const outAt = (i: number) => toOut(sents[i]!.startMs) ?? sents[i]!.startMs;
  const end = opts.durationMs ?? toOut(sents[n - 1]!.endMs) ?? sents[n - 1]!.endMs;
  const begin = 0;
  const total = end - begin;
  const minMs = opts.minChapterMs ?? Math.max(10_000, total / 15);
  const maxCh = opts.maxChapters ?? 12;
  const k = opts.window ?? 3;
  const idf = idfOf(sents.map((s) => s.stems));
  const sv = sents.map((s) => vecOf(s.stems, idf));
  const block = (from: number, to: number): Vec => {
    const v: Vec = new Map();
    for (let i = Math.max(0, from); i < Math.min(n, to); i++) for (const [t, x] of sv[i]!) v.set(t, (v.get(t) ?? 0) + x);
    return v;
  };
  // sims[g] for the gap before sentence g (g = 1..n-1); index 0 unused
  const raw: number[] = [0];
  for (let g = 1; g < n; g++) raw.push(cosine(block(g - k, g), block(g, g + k)));
  // light smoothing (1-2-1) so one odd sentence does not open a chapter
  const sims = raw.map((s, g) => (g === 0 ? 0 : g === 1 || g === n - 1 ? s : (raw[g - 1]! + 2 * s + raw[g + 1]!) / 4));
  const depths: number[] = [0];
  for (let g = 1; g < n; g++) {
    let l = sims[g]!;
    for (let i = g - 1; i >= 1 && sims[i]! >= l; i--) l = sims[i]!;
    let r = sims[g]!;
    for (let i = g + 1; i < n && sims[i]! >= r; i++) r = sims[i]!;
    depths.push(l - sims[g]! + (r - sims[g]!));
  }
  const ds = depths.slice(1);
  const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
  const sd = Math.sqrt(ds.reduce((a, b) => a + (b - mean) ** 2, 0) / ds.length);
  const thr = mean + 0.25 * sd;
  const order = ds.map((d, i) => ({ g: i + 1, d })).filter((c) => c.d > thr && c.d > 0.05).sort((a, b) => b.d - a.d || a.g - b.g);
  const chosen: number[] = [];
  for (const c of order) {
    if (chosen.length + 1 >= maxCh) break;
    const t = outAt(c.g);
    if (t - begin < minMs || end - t < minMs) continue;
    if (chosen.some((g) => Math.abs(outAt(g) - t) < minMs)) continue;
    chosen.push(c.g);
  }
  // TextTiling decides how many chapters; their exact starts are then placed by a contiguous
  // segmentation that maximises cohesion (sum over chapters of |sum of unit sentence vectors|), which
  // is sharper at the boundary than the smoothed valley it came from.
  const starts = placeBoundaries(sv, chosen.length + 1, (a, b) => (b === n ? end : outAt(b)) - (a === 0 ? begin : outAt(a)) >= minMs, n);
  return { starts: starts ?? [0, ...chosen.sort((a, b) => a - b)], sims, depths };
}

/**
 * Split n sentences into exactly K contiguous chapters maximising sum_k |sum_{i in k} v_i / |v_i||.
 * `ok(a, b)` says whether sentences [a, b) may form one chapter (length rules). Null when impossible.
 */
function placeBoundaries(vecs: Vec[], K: number, ok: (a: number, b: number) => boolean, n: number): number[] | null {
  if (K <= 1) return [0];
  const unit = vecs.map((v) => {
    let nn = 0;
    for (const x of v.values()) nn += x * x;
    const r = Math.sqrt(nn) || 1;
    const u: Vec = new Map();
    for (const [t, x] of v) u.set(t, x / r);
    return u;
  });
  // coh[a][b] = |sum unit[a..b)|
  const coh: number[][] = Array.from({ length: n + 1 }, () => new Array(n + 1).fill(0));
  for (let a = 0; a < n; a++) {
    const acc: Vec = new Map();
    for (let b = a + 1; b <= n; b++) {
      for (const [t, x] of unit[b - 1]!) acc.set(t, (acc.get(t) ?? 0) + x);
      let nn = 0;
      for (const x of acc.values()) nn += x * x;
      coh[a]![b] = Math.sqrt(nn);
    }
  }
  const NEG = -Infinity;
  // best[k][b]: best score splitting [0, b) into k chapters; from[k][b]: start of the last one
  const best: number[][] = Array.from({ length: K + 1 }, () => new Array(n + 1).fill(NEG));
  const from: number[][] = Array.from({ length: K + 1 }, () => new Array(n + 1).fill(-1));
  best[0]![0] = 0;
  for (let k = 1; k <= K; k++)
    for (let b = 1; b <= n; b++)
      for (let a = k - 1; a < b; a++) {
        if (best[k - 1]![a] === NEG || !ok(a, b)) continue;
        const v = best[k - 1]![a]! + coh[a]![b]!;
        if (v > best[k]![b]! + 1e-12) {
          best[k]![b] = v;
          from[k]![b] = a;
        }
      }
  if (best[K]![n] === NEG) return null;
  const starts: number[] = [];
  let b = n;
  for (let k = K; k >= 1; k--) {
    const a = from[k]![b]!;
    starts.push(a);
    b = a;
  }
  return starts.reverse();
}

const titleCase = (s: string) =>
  s.split(" ").map((w, i) => (i > 0 && /^(and|or|of|the|a|an|to|in|on|for|with)$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");

interface Phrase {
  words: string[];
  stems: string[];
}

/** Runs of 1-3 content words between stop words / punctuation, as spoken. */
function phrasesOf(sents: Sentence[]): Phrase[] {
  const out: Phrase[] = [];
  for (const s of sents) {
    let run: string[] = [];
    const flush = () => {
      for (let i = 0; i < run.length; i++)
        for (let len = 1; len <= 3 && i + len <= run.length; len++) {
          const words = run.slice(i, i + len);
          out.push({ words: words.map(clean), stems: words.map((w) => stem(clean(w))) });
        }
      run = [];
    };
    for (const w of s.words) {
      const c = clean(w);
      if (isContent(c)) run.push(w);
      else flush();
      if (/[,.!?;:]$/.test(w)) flush();
    }
    flush();
  }
  return out;
}

/** Best phrase by `score` (sum of word scores, multi-word phrases need every word to count). */
function bestPhrases(phrases: Phrase[], score: (stem: string) => number, n: number): Array<{ text: string; s: number }> {
  const agg = new Map<string, { words: string[]; stems: string[]; count: number; s: number }>();
  for (const p of phrases) {
    const key = p.stems.join(" ");
    const e = agg.get(key);
    if (e) e.count++;
    else agg.set(key, { words: p.words, stems: p.stems, count: 1, s: 0 });
  }
  for (const e of agg.values()) {
    const ws = e.stems.map(score);
    // a multi-word phrase must recur to beat its best word
    e.s = e.stems.length === 1 ? ws[0]! : e.count >= 2 ? ws.reduce((a, b) => a + b, 0) * 0.75 : -1;
  }
  const ranked = [...agg.values()].filter((e) => e.s > 0).sort((a, b) => b.s - a.s || b.count - a.count || a.stems.join(" ").localeCompare(b.stems.join(" ")));
  const picked: typeof ranked = [];
  for (const e of ranked) {
    if (picked.length >= n) break;
    if (picked.some((p) => p.stems.some((s) => e.stems.includes(s)))) continue;
    picked.push(e);
  }
  return picked.map((p) => ({ text: p.words.join(" "), s: p.s }));
}

/** "First" or "First and Second" when the second phrase scores at least 60 % of the first. */
function joinTitle(parts: Array<{ text: string; s: number }>, maxLen: number): string {
  let t = parts[0]?.text ?? "";
  const b = parts[1];
  if (b && b.s >= 0.6 * parts[0]!.s && (t + " and " + b.text).length <= maxLen) t = `${t} and ${b.text}`;
  return titleCase(t).slice(0, maxLen).trim();
}

/** PageRank on a weighted undirected graph (adjacency lists), deterministic. */
function pageRank(n: number, edges: Array<Map<number, number>>, iters = 40, d = 0.85): number[] {
  let r = new Array(n).fill(1 / Math.max(1, n));
  const outW = edges.map((m) => [...m.values()].reduce((a, b) => a + b, 0));
  for (let it = 0; it < iters; it++) {
    const nr = new Array(n).fill((1 - d) / Math.max(1, n));
    for (let i = 0; i < n; i++) {
      if (!outW[i]) continue;
      for (const [j, w] of edges[i]!) nr[j] += (d * r[i] * w) / outW[i]!;
    }
    r = nr;
  }
  return r;
}

/** TextRank keyword scores (stem -> score) over the content-word sequence, co-occurrence window 3. */
export function textRankWords(sents: Sentence[], window = 3): Map<string, number> {
  const ids = new Map<string, number>();
  const id = (s: string) => {
    if (!ids.has(s)) ids.set(s, ids.size);
    return ids.get(s)!;
  };
  for (const s of sents) for (const t of s.stems) id(t);
  const edges: Array<Map<number, number>> = Array.from({ length: ids.size }, () => new Map());
  for (const s of sents)
    for (let i = 0; i < s.stems.length; i++)
      for (let j = i + 1; j < Math.min(s.stems.length, i + window); j++) {
        const a = id(s.stems[i]!), b = id(s.stems[j]!);
        if (a === b) continue;
        edges[a]!.set(b, (edges[a]!.get(b) ?? 0) + 1);
        edges[b]!.set(a, (edges[b]!.get(a) ?? 0) + 1);
      }
  const r = pageRank(ids.size, edges);
  const out = new Map<string, number>();
  for (const [s, i] of ids) out.set(s, r[i]!);
  return out;
}

/** TextRank over sentences (overlap / (log|a| + log|b|)): indices of the top `n`, in spoken order. */
export function textRankSentences(sents: Sentence[], n = 3, minWords = 6): number[] {
  const m = sents.length;
  const edges: Array<Map<number, number>> = Array.from({ length: m }, () => new Map());
  for (let i = 0; i < m; i++)
    for (let j = i + 1; j < m; j++) {
      const a = new Set(sents[i]!.stems), b = new Set(sents[j]!.stems);
      if (a.size < 2 || b.size < 2) continue;
      let ov = 0;
      for (const t of a) if (b.has(t)) ov++;
      if (!ov) continue;
      const w = ov / (Math.log(a.size) + Math.log(b.size));
      edges[i]!.set(j, w);
      edges[j]!.set(i, w);
    }
  const r = pageRank(m, edges);
  const order = sents.map((s, i) => ({ i, r: r[i]!, ok: s.words.length >= minWords })).sort((a, b) => Number(b.ok) - Number(a.ok) || b.r - a.r || a.i - b.i);
  return order.slice(0, n).map((o) => o.i).sort((a, b) => a - b);
}

export interface ChapterDraft {
  /** Chapter start on the recording clock (source ms). */
  srcMs: number;
  title: string;
}

export interface ContentDraft {
  title: string;
  description: string;
  chapters: ChapterDraft[];
  /** Top key phrases of the whole transcript (TextRank). */
  keywords: string[];
}

/** Draft a title, description and chapters from transcript words (source clock; words in cuts left out by the caller). */
export function draftContent(words: Word[], opts: ChapterOptions = {}): ContentDraft {
  const sents = sentencesOf(words);
  if (!sents.length) return { title: "", description: "", chapters: [], keywords: [] };
  const { starts } = segmentSentences(sents, opts);
  const segs: Segment[] = starts.map((s, i) => ({ from: s, to: starts[i + 1] ?? sents.length }));
  // chapter titles: frequency in the chapter x rarity across the other chapters
  const segStems = segs.map((sg) => sents.slice(sg.from, sg.to).flatMap((s) => s.stems));
  const cf = new Map<string, number>();
  for (const st of segStems) for (const t of new Set(st)) cf.set(t, (cf.get(t) ?? 0) + 1);
  const C = segs.length;
  const chapters: ChapterDraft[] = segs.map((sg, ci) => {
    const tf = new Map<string, number>();
    for (const t of segStems[ci]!) tf.set(t, (tf.get(t) ?? 0) + 1);
    const score = (t: string) => (tf.get(t) ?? 0) * Math.log((C + 1) / ((cf.get(t) ?? 0) + 0.5));
    const parts = bestPhrases(phrasesOf(sents.slice(sg.from, sg.to)), score, 2);
    return { srcMs: ci === 0 ? Math.min(sents[0]!.startMs, 0) : sents[sg.from]!.startMs, title: joinTitle(parts, 48) || `Part ${ci + 1}` };
  });
  const tr = textRankWords(sents);
  const kw = bestPhrases(phrasesOf(sents), (t) => (tr.get(t) ?? 0) * 100, 5);
  const keywords = kw.map((k) => k.text);
  const title = joinTitle(kw, 70);
  const description = textRankSentences(sents, 3).map((i) => sents[i]!.text.replace(/^\w/, (c) => c.toUpperCase())).map((t) => (/[.!?]$/.test(t) ? t : `${t}.`)).join(" ");
  return { title, description, chapters, keywords };
}

// ---------------------------------------------------------------- output formats

export interface OutputChapter {
  outMs: number;
  title: string;
}

/** m:ss or h:mm:ss (YouTube's format), whole seconds rounded down. */
export function ytTime(ms: number, hours = false): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return hours || h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** The YouTube description chapter list: one "0:00 Title" line per chapter, the first at 0:00. */
export function youtubeChapterList(chapters: OutputChapter[], durationMs: number): string {
  const hours = durationMs >= 3_600_000;
  return [...chapters].sort((a, b) => a.outMs - b.outMs).map((c, i) => `${ytTime(i === 0 ? 0 : c.outMs, hours)} ${c.title.trim() || `Part ${i + 1}`}`).join("\n");
}

/** What YouTube needs before it shows chapters: first at 0:00, at least 3, each at least 10 s. */
export function youtubeChapterIssues(chapters: OutputChapter[], durationMs: number): string[] {
  const c = [...chapters].sort((a, b) => a.outMs - b.outMs);
  const out: string[] = [];
  if (c.length < 3) out.push(`YouTube needs at least 3 chapters (${c.length} now).`);
  c.forEach((ch, i) => {
    const end = c[i + 1]?.outMs ?? durationMs;
    if (end - (i === 0 ? 0 : ch.outMs) < 10_000) out.push(`"${ch.title}" is shorter than 10 s.`);
  });
  return out;
}

/** WebVTT chapters track (kind="chapters"). */
export function chaptersVtt(chapters: OutputChapter[], durationMs: number): string {
  const c = [...chapters].sort((a, b) => a.outMs - b.outMs);
  const ts = (ms: number) => {
    const t = Math.max(0, Math.round(ms));
    const h = Math.floor(t / 3600000), m = Math.floor((t % 3600000) / 60000), s = Math.floor((t % 60000) / 1000), f = t % 1000;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(f).padStart(3, "0")}`;
  };
  return "WEBVTT\n\n" + c.map((ch, i) => `${i + 1}\n${ts(i === 0 ? 0 : ch.outMs)} --> ${ts(c[i + 1]?.outMs ?? durationMs)}\n${ch.title}\n`).join("\n");
}

const ffEsc = (s: string) => s.replace(/[\\=;#\n]/g, (c) => (c === "\n" ? "\\\n" : `\\${c}`));

/** ffmpeg FFMETADATA1 with the title, description and one [CHAPTER] per chapter (ms time base). */
export function ffmetadata(meta: { title?: string; description?: string }, chapters: OutputChapter[], durationMs: number): string {
  const c = [...chapters].sort((a, b) => a.outMs - b.outMs);
  const lines = [";FFMETADATA1"];
  if (meta.title) lines.push(`title=${ffEsc(meta.title)}`);
  if (meta.description) lines.push(`comment=${ffEsc(meta.description)}`, `description=${ffEsc(meta.description)}`);
  c.forEach((ch, i) => {
    lines.push("[CHAPTER]", "TIMEBASE=1/1000", `START=${Math.round(i === 0 ? 0 : ch.outMs)}`, `END=${Math.round(c[i + 1]?.outMs ?? durationMs)}`, `title=${ffEsc(ch.title)}`);
  });
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------- project data

/** project.chapters (absent in older projects; never changes the picture). */
export interface ChapterSettings {
  title: string;
  description: string;
  items: ChapterItem[];
  /** Write the chapters (and title / description) into the exported MP4. */
  embed: boolean;
}

export interface ChapterItem {
  id: string;
  /** Start on the recording clock (ms), so it follows cuts and speed changes. */
  srcMs: number;
  title: string;
}

export function validateChapters(c: unknown): string[] {
  if (c === undefined || c === null) return [];
  if (typeof c !== "object" || Array.isArray(c)) return ["chapters must be an object"];
  const o = c as Record<string, unknown>;
  const errs: string[] = [];
  if (typeof o.title !== "string" || o.title.length > 200) errs.push("chapters.title must be a string of at most 200 characters");
  if (typeof o.description !== "string" || o.description.length > 5000) errs.push("chapters.description must be a string of at most 5000 characters");
  if (typeof o.embed !== "boolean") errs.push("chapters.embed must be true or false");
  if (!Array.isArray(o.items)) errs.push("chapters.items must be an array");
  else
    for (const it of o.items as unknown[]) {
      const i = it as Record<string, unknown>;
      if (!i || typeof i.id !== "string" || !Number.isFinite(i.srcMs) || (i.srcMs as number) < 0 || typeof i.title !== "string" || i.title.length > 100) {
        errs.push("chapters.items[] must be {id, srcMs >= 0, title (at most 100 characters)}");
        break;
      }
    }
  return errs;
}

/**
 * Chapter items (recording clock) on the output clock: a start inside a cut moves to where the
 * recording resumes; starts past the end are dropped; the first chapter is at 0; equal starts merge.
 */
export function outputChapters(items: ChapterItem[], pieces: TimelinePiece[], durationMs: number): OutputChapter[] {
  const out: OutputChapter[] = [];
  for (const it of [...items].sort((a, b) => a.srcMs - b.srcMs || a.id.localeCompare(b.id))) {
    let t = sourceToOutput(pieces, it.srcMs);
    if (t === null) t = pieces.find((p) => p.srcStart >= it.srcMs && p.srcEnd > p.srcStart)?.outStart ?? null;
    if (t === null || t >= durationMs) continue;
    t = Math.round(out.length === 0 ? 0 : t);
    if (out.length && t <= out[out.length - 1]!.outMs) continue;
    out.push({ outMs: t, title: it.title });
  }
  return out;
}

/** The bits of a render plan the draft needs (structural, so this file does not import plan.ts). */
export interface PlanClock {
  frames: Array<{ src: number }>;
  output: { fps: number; durationMs: number };
  cuts: Array<{ startMs: number; endMs: number }>;
}

/**
 * Draft from the transcript as the export will play it: words inside cuts left out, chapter lengths
 * measured on the output clock (first output frame showing that source time).
 */
export function draftContentForPlan(words: Word[], plan: PlanClock, opts: Omit<ChapterOptions, "toOutput" | "durationMs"> = {}): ContentDraft {
  const inCut = (t: number) => plan.cuts.some((c) => t >= c.startMs && t < c.endMs);
  const kept = words.filter((w) => !inCut((w.startMs + w.endMs) / 2));
  const fr = plan.frames;
  const toOutput = (src: number): number | null => {
    if (inCut(src)) return null;
    let lo = 0, hi = fr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (fr[mid]!.src < src) lo = mid + 1;
      else hi = mid;
    }
    return lo >= fr.length ? plan.output.durationMs : (lo * 1000) / plan.output.fps;
  };
  return draftContent(kept, { ...opts, toOutput, durationMs: plan.output.durationMs });
}
