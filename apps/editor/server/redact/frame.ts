/** Findings on one OCR'd frame: classifier matches mapped back to pixel boxes (port of frame.py). */
import { findLine, findToken } from "./classify";
import { groupLines, type OcrLine, type OcrWord } from "./ocr";

export type Box = [number, number, number, number];

export interface FrameHit {
  type: string;
  box: Box;
  text: string;
  confidence: number;
}

function union(ws: OcrWord[]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const w of ws) {
    x0 = Math.min(x0, w.x);
    y0 = Math.min(y0, w.y);
    x1 = Math.max(x1, w.x + w.w);
    y1 = Math.max(y1, w.y + w.h);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

function spans(ws: OcrWord[], sep: string): [string, Array<[number, number]>] {
  const parts: string[] = [];
  const sp: Array<[number, number]> = [];
  let pos = 0;
  for (const w of ws) {
    sp.push([pos, pos + w.text.length]);
    parts.push(w.text);
    pos += w.text.length + sep.length;
  }
  return [parts.join(sep), sp];
}

const wordsIn = (ws: OcrWord[], sp: Array<[number, number]>, a: number, b: number) => ws.filter((_, i) => sp[i]![0] < b && sp[i]![1] > a);

function gluedRuns(line: OcrLine): OcrWord[][] {
  const runs: OcrWord[][] = [];
  let cur = [line.words[0]!];
  for (const q of line.words.slice(1)) {
    const p = cur[cur.length - 1]!;
    const gap = q.x - (p.x + p.w);
    if (gap < 0.5 * Math.max(p.h, q.h, 8)) cur.push(q);
    else {
      runs.push(cur);
      cur = [q];
    }
  }
  runs.push(cur);
  return runs;
}

const B64ISH = /^[A-Za-z0-9_.+/=-]{3,}$/;
const MIXED = /[0-9]|[a-z][A-Z]|[A-Z][a-z]*[A-Z]/;

function extendToken(line: OcrLine, sel: OcrWord[]): OcrWord[] {
  const ws = line.words;
  const tokenish = (q: OcrWord) => B64ISH.test(q.text) && MIXED.test(q.text);
  let i = ws.indexOf(sel[0]!);
  const out = [...sel];
  while (i > 0) {
    const p = ws[i - 1]!;
    const q = ws[i]!;
    if (q.x - (p.x + p.w) > 1.0 * Math.max(p.h, q.h, 8) || !tokenish(p)) break;
    out.unshift(p);
    i--;
  }
  i = ws.indexOf(sel[sel.length - 1]!);
  while (i + 1 < ws.length) {
    const q = ws[i + 1]!;
    const p = ws[i]!;
    if (q.x - (p.x + p.w) > 1.0 * Math.max(p.h, q.h, 8) || !B64ISH.test(q.text) || !MIXED.test(q.text)) break;
    out.push(q);
    i++;
  }
  return out;
}

export function iou(a: Box | number[], b: Box | number[]): number {
  const ix = Math.max(0, Math.min(a[0]! + a[2]!, b[0]! + b[2]!) - Math.max(a[0]!, b[0]!));
  const iy = Math.max(0, Math.min(a[1]! + a[3]!, b[1]! + b[3]!) - Math.max(a[1]!, b[1]!));
  const inter = ix * iy;
  const u = a[2]! * a[3]! + b[2]! * b[3]! - inter;
  return u > 0 ? inter / u : 0;
}

const RANK: Record<string, number> = { jwt: 0, api_key: 1, card: 2, email: 3, phone: 4, ip: 5, token: 6 };

export function hitsFromWords(words: OcrWord[]): FrameHit[] {
  const hits: FrameHit[] = [];
  for (const line of groupLines(words)) {
    const ws = line.words;
    const [text, sp] = spans(ws, " ");
    for (const f of findLine(text)) {
      const sel = wordsIn(ws, sp, f.start, f.end);
      if (sel.length) hits.push({ type: f.type, box: union(sel), text: f.text, confidence: f.confidence });
    }
    for (const run of gluedRuns(line)) {
      const [tok, tsp] = spans(run, "");
      for (const f of findToken(tok)) {
        let sel = wordsIn(run, tsp, f.start, f.end);
        if (sel.length && ["jwt", "api_key", "token"].includes(f.type) && f.end >= tok.length - 1) sel = extendToken(line, sel);
        if (sel.length) hits.push({ type: f.type, box: union(sel), text: f.text, confidence: f.confidence });
      }
    }
  }
  // stable sort by type rank (Python's sort is stable), then drop boxes found twice
  const ranked = hits.map((h, i) => ({ h, i })).sort((a, b) => (RANK[a.h.type] ?? 9) - (RANK[b.h.type] ?? 9) || a.i - b.i).map((x) => x.h);
  const out: FrameHit[] = [];
  for (const h of ranked) {
    if (out.some((o) => iou(h.box, o.box) > 0.5)) continue;
    out.push(h);
  }
  return out;
}
