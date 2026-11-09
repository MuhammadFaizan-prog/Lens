import { DEFAULT_TAKES, resolveTakes, type TakeGroup } from "../src/index.js";
import { synthWords, type Case, type SynthWord } from "./takes.corpus.js";

export interface CaseResult {
  id: string;
  kind: string;
  words: SynthWord[];
  groups: TakeGroup[];
  /** Word indices cut as retakes. */
  cut: Set<number>;
  tp: number;
  fp: number;
  fn: number;
  truthGroups: number;
  groupHits: number;
  groupFalse: number;
}

const mid = (w: { startMs: number; endMs: number }) => (w.startMs + w.endMs) / 2;

/** Truth groups: maximal runs of [x] spans with no kept spoken word between them; each ends at the next kept word. */
function truthGroups(words: SynthWord[]): Array<{ first: number; last: number; keptFirst: number }> {
  const out: Array<{ first: number; last: number; keptFirst: number }> = [];
  let i = 0;
  while (i < words.length) {
    if (!words[i]!.retake) {
      i++;
      continue;
    }
    const first = i;
    while (i < words.length && words[i]!.retake) i++;
    out.push({ first, last: i - 1, keptFirst: i });
  }
  return out;
}

export function evalCase(c: Case, strategy: "last" | "best" = "last"): CaseResult {
  const words = synthWords(c.text);
  const end = words[words.length - 1]!.endMs + 500;
  const r = resolveTakes(words, { ...DEFAULT_TAKES, enabled: true, strategy }, undefined, end);
  const cut = new Set<number>();
  words.forEach((w, i) => {
    if (r.cuts.some((k) => mid(w) >= k.startMs && mid(w) < k.endMs)) cut.add(i);
  });
  let tp = 0;
  let fp = 0;
  let fn = 0;
  words.forEach((w, i) => {
    if (cut.has(i) && w.retake) tp++;
    else if (cut.has(i)) fp++;
    else if (w.retake) fn++;
  });
  const truth = truthGroups(words);
  let hits = 0;
  for (const t of truth) {
    // found: a detected group whose kept take starts at the truth's kept word and whose cuts remove every truth word
    const g = r.groups.find((g) => g.takes[g.kept]!.firstWord === t.keptFirst);
    const allCut = Array.from({ length: t.last - t.first + 1 }, (_, k) => t.first + k).every((k) => cut.has(k));
    if (g && allCut) hits++;
  }
  const groupFalse = r.groups.filter((g) => !truth.some((t) => g.takes[g.kept]!.firstWord === t.keptFirst)).length;
  return { id: c.id, kind: c.kind, words, groups: r.groups, cut, tp, fp, fn, truthGroups: truth.length, groupHits: hits, groupFalse };
}

export interface Metrics {
  wordPrecision: number;
  wordRecall: number;
  groupPrecision: number;
  groupRecall: number;
  tp: number;
  fp: number;
  fn: number;
  groupsTruth: number;
  groupsFound: number;
  groupsFalse: number;
  failures: string[];
}

export function evalSet(cases: Case[]): Metrics {
  const rs = cases.map((c) => evalCase(c));
  const tp = rs.reduce((a, r) => a + r.tp, 0);
  const fp = rs.reduce((a, r) => a + r.fp, 0);
  const fn = rs.reduce((a, r) => a + r.fn, 0);
  const gt = rs.reduce((a, r) => a + r.truthGroups, 0);
  const gh = rs.reduce((a, r) => a + r.groupHits, 0);
  const gf = rs.reduce((a, r) => a + r.groupFalse, 0);
  const failures = rs
    .filter((r) => r.fp || r.fn || r.groupFalse || r.groupHits < r.truthGroups)
    .map((r) => {
      const shown = r.words.map((w, i) => (r.cut.has(i) ? `~~${w.text}~~` : w.text)).join(" ");
      return `${r.id} (${r.kind}) tp=${r.tp} fp=${r.fp} fn=${r.fn}: ${shown}`;
    });
  return {
    wordPrecision: tp + fp ? tp / (tp + fp) : 1,
    wordRecall: tp + fn ? tp / (tp + fn) : 1,
    groupPrecision: gh + gf ? gh / (gh + gf) : 1,
    groupRecall: gt ? gh / gt : 1,
    tp,
    fp,
    fn,
    groupsTruth: gt,
    groupsFound: gh,
    groupsFalse: gf,
    failures,
  };
}
