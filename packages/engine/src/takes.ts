import { mergeRanges } from "./timeline.js";
import { DEFAULT_FILLERS, isFiller } from "./transcript.js";
import type { TimeRange, Word } from "./types.js";

/**
 * Multi-take with automatic best take (demand #1). Lens's own design, built on the transcript.
 *
 * A retake is speech the speaker abandoned and said again: "Click the expert, um... Click the export
 * button". We find it from the word sequence alone. For every position j where speech could have
 * restarted, we look back for an earlier stretch A = tokens[i..j) whose words are (fuzzily) a prefix of
 * what follows j. A and the restart B form a take group; a later restart of B extends the group (a
 * chain of 3+ takes). Restart cues lower the bar: a restart phrase ("sorry", "let me redo that"), a
 * long pause before the restart, a filler at the boundary, a stutter, a low-confidence last word, or
 * already being inside a group. A complete sentence that merely starts like the next one ("This step
 * is important. This step is optional") needs a near-exact repeat or a cue.
 *
 * Each group keeps one take (the last, or the best by completeness, fillers, pauses and confidence)
 * and the rest become reversible cuts. Keeping an earlier take cuts the matching part of the final
 * take instead, so the sentence continues from where that take stopped.
 */

export type TakeStrategy = "last" | "best";

export interface TakeChoice {
  /** Any source time inside the group (the editor stores the group's start). */
  atMs: number;
  /** Take index to keep, 0 = first. */
  keep: number;
}

export interface TakeSettings {
  enabled: boolean;
  strategy: TakeStrategy;
  /** Per-group overrides of which take is kept. */
  choices: TakeChoice[];
  /** Source ranges the user marked as a retake ("mark retake"); each becomes a rejected take. */
  marked: TimeRange[];
  /** Groups the user said are not retakes: any source time inside the group. */
  ignored: number[];
  /** Silence kept at each side of a take cut, at most half of the gap there. */
  padMs: number;
}

export const DEFAULT_TAKES: TakeSettings = { enabled: false, strategy: "last", choices: [], marked: [], ignored: [], padMs: 120 };

/** Detector constants. Set on the DEV half of test/takes.corpus.ts; see docs/Takes.md. */
export const TAKE_DETECT = {
  /** Longest abandoned take, in content tokens. */
  maxTakeTokens: 30,
  /** Longest silence between an abandoned take and its restart. */
  maxGapMs: 15000,
  /** A pause before the restart at least this long is a restart cue. */
  longPauseMs: 800,
  /** Token similarity counted as a match (1 - edit distance / length). */
  matchSim: 0.6,
  /** Cost of a word in the restart that the earlier take did not have. */
  insertCost: 0.5,
  lowConfidence: 0.5,
};

export interface Take {
  startMs: number;
  endMs: number;
  /** Word indices (into the transcript's words) of the take's first and last spoken word. */
  firstWord: number;
  lastWord: number;
  /** Fraction of the group's reference wording this take covers, 0..1. */
  completeness: number;
  fillers: number;
  longPauses: number;
  confidence: number;
  score: number;
}

export interface TakeGroup {
  id: string;
  startMs: number;
  endMs: number;
  takes: Take[];
  /** Index of the kept take. */
  kept: number;
  /** What the strategy alone would keep. */
  auto: number;
  manual: boolean;
  /** Why it was detected: prefix similarity of the restart and the cues seen. */
  similarity: number;
  cues: string[];
}

// ------------------------------------------------------------------ tokens

const NUMBERS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18",
  nineteen: "19", twenty: "20", thirty: "30", forty: "40", fifty: "50", sixty: "60", hundred: "100",
};

export function normToken(text: string): string {
  const t = text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "").replace(/^'+|'+$/g, "");
  return NUMBERS[t] ?? t;
}

interface Tok {
  t: string;
  /** Word index of the token's first word. */
  w: number;
  /** Word index of its last word (merged letter runs span several). */
  wEnd: number;
  punct: boolean;
  /** A single letter or a number: later single letters / numbers join onto it. */
  joinable: boolean;
}

/** Spoken tokens: fillers and VAD placeholders dropped, numbers as digits, letter runs ("M P 4") joined. */
function tokenize(words: Word[], fillers: string[]): Tok[] {
  const out: Tok[] = [];
  words.forEach((w, i) => {
    if (w.inferred || isFiller(w, fillers)) return;
    const t = normToken(w.text);
    if (!t) return;
    const punct = /[.,!?;:]["')\]]*$/.test(w.text);
    const prev = out[out.length - 1];
    // Join runs of single letters / digits spoken separately ("M P four" = "mp4", "four K" = "4k").
    const short = (x: string) => x.length === 1 || /^\d+$/.test(x);
    if (prev && !prev.punct && prev.joinable && short(t)) {
      prev.t += t;
      prev.wEnd = i;
      prev.punct = punct;
      return;
    }
    out.push({ t, w: i, wEnd: i, punct, joinable: short(t) && t !== "a" && t !== "i" });
  });
  return out;
}

function lev(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n]!;
}

/** 0..1: 1 for equal, 1 - edit distance / longer length otherwise (words of 3 letters or fewer: exact only); a cut-off word that is a prefix of the other (3+ letters) counts 0.8. */
export function tokenSim(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  // Edit distance says nothing about short words ("the" / "then", "on" / "in"): they match only exactly.
  if (Math.min(a.length, b.length) <= 3 && !(a.length === 3 && b.startsWith(a) && b.length > 4)) return 0;
  const s = 1 - lev(a, b) / Math.max(a.length, b.length);
  if (a.length >= 3 && b.startsWith(a)) return Math.max(s, 0.8);
  return s;
}

export interface PrefixMatch {
  /** 1 - alignment cost / |A|. */
  ratio: number;
  /** A tokens aligned to a B token with similarity >= matchSim. */
  matched: number;
  /** B tokens consumed by the alignment. */
  bLen: number;
}

/**
 * Align all of A against a prefix of B (B may continue). Substitution costs 1 - similarity when the
 * words are similar, 1 otherwise; a dropped A word costs 1; an extra B word costs insertCost.
 */
export function prefixMatch(a: string[], b: string[], opts = TAKE_DETECT): PrefixMatch {
  const m = a.length;
  const n = Math.min(b.length, m + 6);
  if (!m) return { ratio: 0, matched: 0, bLen: 0 };
  const INF = 1e9;
  const D: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(INF));
  const M: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  D[0]![0] = 0;
  for (let i = 0; i <= m; i++)
    for (let j = 0; j <= n; j++) {
      const d = D[i]![j]!;
      if (d >= INF) continue;
      if (i < m && j < n) {
        const s = tokenSim(a[i]!, b[j]!);
        const ok = s >= opts.matchSim;
        const c = d + (ok ? 1 - s : 1);
        if (c < D[i + 1]![j + 1]! - 1e-9 || (Math.abs(c - D[i + 1]![j + 1]!) < 1e-9 && M[i]![j]! + (ok ? 1 : 0) > M[i + 1]![j + 1]!)) {
          D[i + 1]![j + 1] = c;
          M[i + 1]![j + 1] = M[i]![j]! + (ok ? 1 : 0);
        }
      }
      if (i < m && d + 1 < D[i + 1]![j]!) {
        D[i + 1]![j] = d + 1;
        M[i + 1]![j] = M[i]![j]!;
      }
      // An extra word in B is only allowed between matched words, never before the first.
      if (j < n && i > 0 && d + opts.insertCost < D[i]![j + 1]!) {
        D[i]![j + 1] = d + opts.insertCost;
        M[i]![j + 1] = M[i]![j]!;
      }
    }
  let best = { cost: INF, j: 0, matched: 0 };
  for (let j = 0; j <= n; j++) {
    const c = D[m]![j]!;
    // On a tie prefer consuming more of B: only a substitution (not an extra word) can tie a drop.
    if (c < best.cost - 1e-9 || (Math.abs(c - best.cost) < 1e-9 && M[m]![j]! >= best.matched)) best = { cost: c, j, matched: M[m]![j]! };
  }
  // Trailing inserted B words are not part of the match.
  return { ratio: 1 - best.cost / m, matched: best.matched, bLen: best.j };
}

// ------------------------------------------------------------------ cues

const CUE_PHRASES = [
  "let me redo that", "let me redo", "let me try that again", "let me try again", "let me start over", "let me start again",
  "let me say that again", "let me rephrase", "start over", "scratch that", "try that again", "one more time", "take two",
  "sorry", "oops", "whoops",
].map((p) => p.split(" "));

/** Length (in tokens) of a restart cue phrase ending at the end of toks, 0 if none. */
function cuePhrase(toks: string[]): number {
  for (const p of CUE_PHRASES) {
    if (p.length > toks.length) continue;
    if (p.every((w, k) => toks[toks.length - p.length + k] === w)) return p.length;
  }
  return 0;
}

/** Junk at the end of an abandoned take: a restart phrase, then any stuttered repeats ("then we we"). */
function tailCue(toks: string[]): number {
  let n = 0;
  for (let k = cuePhrase(toks); k > 0; k = cuePhrase(toks.slice(0, toks.length - n))) n += k;
  while (toks.length - n >= 2 && toks[toks.length - n - 1] === toks[toks.length - n - 2]) n++;
  return n;
}

// ------------------------------------------------------------------ detection

interface RawGroup {
  /** Token index where each take starts (alts), then the final take. */
  starts: number[];
  /** Content token length of each alt take (cue tail removed). */
  lens: number[];
  /** Per alt take, B tokens its content aligns to in the final take. */
  bLens: number[];
  /** Per alt take: prefix match ratio vs the final take. */
  ratios: number[];
  /** Word index where the first take's region starts (leading fillers included). */
  regionStartWord: number;
  similarity: number;
  cues: Set<string>;
  manual: boolean;
}

function wordGap(words: Word[], a: number, b: number): number {
  return words[b]!.startMs - words[a]!.endMs;
}

/** Find retake groups in a transcript (no user choices applied). */
export function detectTakeGroups(words: Word[], fillers: string[] = DEFAULT_FILLERS, opts = TAKE_DETECT): RawGroup[] {
  const toks = tokenize(words, fillers);
  const T = toks.map((t) => t.t);
  const groups: RawGroup[] = [];
  let cur: RawGroup | null = null;
  let curExtentEnd = 0; // first token after the current group's final-take extent
  for (let j = 1; j < toks.length; j++) {
    const chainStart: number = cur ? cur.starts[cur.starts.length - 1]! : -1;
    const lo = Math.max(0, j - opts.maxTakeTokens - 4, cur ? curExtentEnd : 0);
    const candidates: number[] = [];
    if (cur && chainStart < j && chainStart >= j - opts.maxTakeTokens - 4) candidates.push(chainStart);
    for (let i = j - 1; i >= lo; i--) if (i !== chainStart) candidates.push(i);
    let best: { i: number; len: number; m: PrefixMatch; cues: string[]; chain: boolean } | null = null;
    for (const i of candidates) {
      if (tokenSim(T[i]!, T[j]!) < opts.matchSim) continue; // a restart begins where the take began
      let A = T.slice(i, j);
      const cueLen = tailCue(A);
      const cues: string[] = [];
      if (cueLen) {
        const ph = cuePhrase(A);
        if (ph) cues.push(`phrase:${A.slice(A.length - cueLen).join(" ")}`);
        else cues.push("stutter");
        A = A.slice(0, A.length - cueLen);
      }
      if (!A.length || A.length > opts.maxTakeTokens) continue;
      const lastTok = toks[i + A.length - 1]!;
      const gap = wordGap(words, toks[j - 1]!.wEnd, toks[j]!.w);
      if (gap > opts.maxGapMs) continue;
      if (gap >= opts.longPauseMs) cues.push("pause");
      // fillers between the take and the restart (or at its end)
      for (let w = lastTok.wEnd + 1; w < toks[j]!.w; w++) if (isFiller(words[w]!, fillers) && !words[w]!.inferred) { cues.push("filler"); break; }
      if ((words[lastTok.wEnd]!.confidence ?? 1) < opts.lowConfidence) cues.push("low-confidence");
      const chain: boolean = cur !== null && i === chainStart;
      if (chain) cues.push("in-group");
      const m = prefixMatch(A, T.slice(j, j + A.length + 6), opts);
      const complete = lastTok.punct;
      const cue = cues.length > 0;
      const ok =
        (m.ratio >= 0.95 && m.matched >= 3) ||
        (m.ratio >= 0.95 && m.matched >= 2 && cue) ||
        (!complete && m.ratio >= 0.75 && m.matched >= 3) ||
        (cue && m.ratio >= 0.6 && m.matched >= 3);
      if (!ok) continue;
      const score = m.matched - (1 - m.ratio) * A.length + (chain ? 0.5 : 0);
      if (!best || score > best.m.matched - (1 - best.m.ratio) * best.len + (best.chain ? 0.5 : 0)) best = { i, len: A.length, m, cues, chain };
    }
    if (!best) continue;
    if (best.chain && cur) {
      cur.starts.push(j);
      cur.lens.push(0);
      best.cues.forEach((c) => cur!.cues.add(c));
    } else {
      // leading fillers right before the abandoned take belong to it
      let rs = toks[best.i]!.w;
      while (rs > 0 && (words[rs - 1]!.inferred || isFiller(words[rs - 1]!, fillers))) rs--;
      cur = { starts: [best.i, j], lens: [], bLens: [], ratios: [], regionStartWord: rs, similarity: best.m.ratio, cues: new Set(best.cues), manual: false };
      groups.push(cur);
    }
    // recompute per-alt lengths and their alignment against the (new) final take
    finishGroup(cur, toks, T, opts);
    curExtentEnd = cur.starts[cur.starts.length - 1]! + Math.max(1, ...cur.bLens);
  }
  return groups;
}

function finishGroup(g: RawGroup, toks: Tok[], T: string[], opts = TAKE_DETECT): void {
  const fin = g.starts[g.starts.length - 1]!;
  g.lens = [];
  g.bLens = [];
  g.ratios = [];
  for (let k = 0; k < g.starts.length - 1; k++) {
    let A = T.slice(g.starts[k]!, g.starts[k + 1]!);
    const c = tailCue(A);
    if (c) A = A.slice(0, A.length - c);
    const m = prefixMatch(A, T.slice(fin, fin + A.length + 6), opts);
    g.lens.push(A.length);
    g.bLens.push(Math.max(1, m.bLen));
    g.ratios.push(m.ratio);
  }
  void toks;
}

/** A user-marked retake: the marked words are a rejected take, the speech right after it is kept. */
function manualGroup(words: Word[], toks: Tok[], T: string[], r: TimeRange, opts = TAKE_DETECT): RawGroup | null {
  const inside = toks.map((t, k) => ({ t, k })).filter(({ t }) => {
    const mid = (words[t.w]!.startMs + words[t.wEnd]!.endMs) / 2;
    return mid >= r.startMs && mid < r.endMs;
  });
  if (!inside.length) return null;
  const i = inside[0]!.k;
  const j = inside[inside.length - 1]!.k + 1;
  if (j >= toks.length) return null;
  const A = T.slice(i, j);
  const m = prefixMatch(A, T.slice(j, j + A.length + 6), opts);
  const bLen = m.ratio >= 0.3 && m.bLen > 0 ? m.bLen : Math.min(A.length, toks.length - j);
  let rs = toks[i]!.w;
  for (let w = rs - 1; w >= 0 && words[w]!.startMs >= r.startMs - 1; w--) rs = w;
  return { starts: [i, j], lens: [A.length], bLens: [bLen], ratios: [m.ratio], regionStartWord: rs, similarity: m.ratio, cues: new Set(["manual"]), manual: true };
}

// ------------------------------------------------------------------ resolution + cuts

function wordStats(words: Word[], a: number, b: number, fillers: string[]): { fillers: number; longPauses: number; confidence: number } {
  let f = 0;
  let p = 0;
  let cs = 0;
  let cn = 0;
  for (let w = a; w <= b; w++) {
    const x = words[w]!;
    if (x.inferred) continue;
    if (isFiller(x, fillers)) f++;
    else {
      cs += x.confidence ?? 0.9;
      cn++;
    }
    if (w > a && x.startMs - words[w - 1]!.endMs > 700) p++;
  }
  return { fillers: f, longPauses: p, confidence: cn ? cs / cn : 0 };
}

export interface ResolvedTakes {
  groups: TakeGroup[];
  cuts: TimeRange[];
}

/**
 * Detect (when enabled), add user-marked retakes, apply per-group choices and the strategy, and
 * return the groups plus the source-time cuts that remove every rejected take.
 */
export function resolveTakes(words: Word[], settings: TakeSettings, fillers: string[] = DEFAULT_FILLERS, durationMs = Infinity): ResolvedTakes {
  if (!settings.enabled || !words.length) return { groups: [], cuts: [] };
  const toks = tokenize(words, fillers);
  const T = toks.map((t) => t.t);
  const manual = settings.marked.map((r) => manualGroup(words, toks, T, r)).filter((g): g is RawGroup => g !== null);
  const spanOf = (g: RawGroup): [number, number] => {
    const fin = g.starts[g.starts.length - 1]!;
    const endTok = toks[Math.min(toks.length - 1, fin + Math.max(...g.bLens) - 1)]!;
    return [words[g.regionStartWord]!.startMs, words[endTok.wEnd]!.endMs];
  };
  const auto = detectTakeGroups(words, fillers).filter((g) => {
    const [s, e] = spanOf(g);
    return !manual.some((m) => {
      const [ms, me] = spanOf(m);
      return s < me && ms < e;
    });
  });
  const raw = [...manual, ...auto].sort((a, b) => a.regionStartWord - b.regionStartWord);

  const groups: TakeGroup[] = [];
  const cuts: TimeRange[] = [];
  const pad = settings.padMs;
  const before = (wi: number) => {
    const w = words[wi]!;
    const gap = wi > 0 ? w.startMs - words[wi - 1]!.endMs : w.startMs;
    return w.startMs - Math.max(0, Math.min(pad, gap / 2));
  };
  const after = (wi: number) => {
    const w = words[wi]!;
    const gap = wi < words.length - 1 ? words[wi + 1]!.startMs - w.endMs : Math.max(0, durationMs - w.endMs);
    return w.endMs + Math.max(0, Math.min(pad, (Number.isFinite(gap) ? gap : pad * 2) / 2));
  };

  for (const g of raw) {
    const [gs, ge] = spanOf(g);
    if (settings.ignored.some((t) => t >= gs && t < ge)) continue;
    const n = g.starts.length;
    const fin = g.starts[n - 1]!;
    const ref = Math.max(...g.bLens);
    const takes: Take[] = [];
    for (let k = 0; k < n; k++) {
      const isFinal = k === n - 1;
      const firstTok = toks[g.starts[k]!]!;
      const lastTok = isFinal ? toks[Math.min(toks.length - 1, fin + ref - 1)]! : toks[g.starts[k]! + Math.max(1, g.lens[k]!) - 1]!;
      const firstWord = k === 0 ? g.regionStartWord : firstTok.w;
      const st = wordStats(words, firstWord, lastTok.wEnd, fillers);
      const completeness = isFinal ? 1 : Math.min(1, (g.bLens[k]! / ref) * Math.max(0, Math.min(1, g.ratios[k]!)));
      const score = 2 * completeness + 0.5 * st.confidence - 0.25 * st.fillers - 0.2 * st.longPauses + 0.01 * k;
      takes.push({
        startMs: words[firstTok.w]!.startMs,
        endMs: words[lastTok.wEnd]!.endMs,
        firstWord: firstTok.w,
        lastWord: lastTok.wEnd,
        completeness: Math.round(completeness * 1000) / 1000,
        ...st,
        confidence: Math.round(st.confidence * 1000) / 1000,
        score: Math.round(score * 1000) / 1000,
      });
    }
    const autoKeep = settings.strategy === "best" ? takes.reduce((bi, t, i) => (t.score > takes[bi]!.score ? i : bi), 0) : n - 1;
    const choice = [...settings.choices].reverse().find((c) => c.atMs >= gs && c.atMs < ge);
    const kept = choice && choice.keep >= 0 && choice.keep < n ? choice.keep : autoKeep;
    groups.push({
      id: `take-${Math.round(gs)}`,
      startMs: gs,
      endMs: ge,
      takes,
      kept,
      auto: autoKeep,
      manual: g.manual,
      similarity: Math.round(g.similarity * 1000) / 1000,
      cues: [...g.cues],
    });
    // cuts
    const finalFirst = toks[fin]!.w;
    if (kept === n - 1) {
      cuts.push({ startMs: before(g.regionStartWord), endMs: before(finalFirst) });
    } else {
      const t = takes[kept]!;
      if (kept > 0) cuts.push({ startMs: before(g.regionStartWord), endMs: before(t.firstWord) });
      const replacedEnd = toks[Math.min(toks.length - 1, fin + g.bLens[kept]! - 1)]!.wEnd;
      cuts.push({ startMs: after(t.lastWord), endMs: after(replacedEnd) });
    }
  }
  return { groups, cuts: mergeRanges(cuts.filter((c) => c.endMs - c.startMs > 1)) };
}

/** Which take (group index, take index) a source time falls in, if any. */
export function takeAt(groups: TakeGroup[], tMs: number): { group: number; take: number } | null {
  for (let g = 0; g < groups.length; g++) {
    const takes = groups[g]!.takes;
    for (let k = 0; k < takes.length; k++) if (tMs >= takes[k]!.startMs && tMs < takes[k]!.endMs) return { group: g, take: k };
  }
  return null;
}

/** Set (or replace) the kept take of the group containing atMs. */
export function withTakeChoice(settings: TakeSettings, group: TakeGroup, keep: number): TakeSettings {
  const choices = settings.choices.filter((c) => !(c.atMs >= group.startMs && c.atMs < group.endMs));
  if (keep !== group.auto) choices.push({ atMs: group.startMs, keep });
  return { ...settings, choices };
}
