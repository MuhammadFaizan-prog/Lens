/**
 * Automatic step labels in-process (no Python): port of redact/lens_redact/steps.py. For each left
 * click: the frame just before the press, a ±260 x ±100 px region around it upscaled 2x and OCR'd
 * twice (as is, and as a polarity-free contrast map), words -> lines -> controls, the control under
 * the click (else the nearest within 40 px) and a verb ("Open" for navigation, else "Click").
 */
import fs from "node:fs";
import { crop, medianBlur, type Gray } from "./imgops";
import { OcrPool, groupLines, lineBox, type OcrLine, type OcrWord } from "./ocr";
import { decode, probe } from "./scan";

const NAV_WORDS = new Set([
  "settings", "preferences", "profile", "account", "menu", "file", "edit", "view", "help", "dashboard", "home", "tools",
  "window", "options", "notifications", "billing", "reports", "projects", "inbox", "overview", "analytics", "team",
  "members", "integrations", "library", "history", "messages", "documents", "files", "calendar", "tab", "page",
]);
const ROI_W = 260;
const ROI_H = 100;

interface Click {
  t: number;
  x: number;
  y: number;
}

export function loadClicks(eventsPath: string, mergeMs = 400, mergePx = 6): Click[] {
  const out: Click[] = [];
  for (const raw of fs.readFileSync(eventsPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type !== "down" || (e.button ?? "left") !== "left") continue;
    const c = { t: Number(e.t), x: Number(e.x), y: Number(e.y) };
    const p = out[out.length - 1];
    if (p && c.t - p.t < mergeMs && Math.abs(c.x - p.x) < mergePx && Math.abs(c.y - p.y) < mergePx) continue;
    out.push(c);
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Polarity-free text image: distance from the local background (median over 21 px), dark on white. */
export function contrastMap(g: Gray): Gray {
  const bg = medianBlur(g, 21);
  const out = new Uint8Array(g.d.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, Math.trunc(255 - Math.abs(g.d[i]! - bg.d[i]!) * 2.2)));
  return { w: g.w, h: g.h, d: out };
}

function clean(words: OcrWord[]): string {
  const toks: string[] = [];
  for (const w of words) {
    const t = w.text.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
    if (!t) continue;
    if (w.conf < 30 && t.length <= 2) continue;
    toks.push(t);
  }
  return toks.join(" ");
}

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

function controls(lines: OcrLine[]): OcrLine[] {
  const out: OcrLine[] = [];
  for (const ln of lines) {
    const ws = [...ln.words].sort((a, b) => a.x - b.x);
    let cur = [ws[0]!];
    for (const q of ws.slice(1)) {
      const p = cur[cur.length - 1]!;
      const hh = Math.max(8, median(cur.map((z) => z.h)));
      if (q.x - (p.x + p.w) > 1.0 * hh) {
        out.push({ words: cur });
        cur = [q];
      } else cur.push(q);
    }
    out.push({ words: cur });
  }
  return out;
}

function mergePolarities(a: OcrWord[], b: OcrWord[]): OcrWord[] {
  const out = [...a];
  for (const w of b) {
    let clash = -1;
    for (let i = 0; i < out.length; i++) {
      const v = out[i]!;
      const ix = Math.min(w.x + w.w, v.x + v.w) - Math.max(w.x, v.x);
      const iy = Math.min(w.y + w.h, v.y + v.h) - Math.max(w.y, v.y);
      if (ix > 0 && iy > 0 && ix * iy > 0.3 * Math.min(w.w * w.h, v.w * v.h)) {
        clash = i;
        break;
      }
    }
    if (clash < 0) out.push(w);
    else if (w.conf > out[clash]!.conf) out[clash] = w;
  }
  return out;
}

function isNav(ctrl: OcrLine, all: OcrLine[], text: string, click: Click, frameH: number): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  if (NAV_WORDS.has(text.toLowerCase()) || (words.length && NAV_WORDS.has(words[words.length - 1]!.toLowerCase()) && words.length <= 2)) return true;
  const [x0, y0, , h0] = lineBox(ctrl);
  const nWords = (c: OcrLine) => clean(c.words).split(/\s+/).filter(Boolean).length;
  const row = all.filter((c) => {
    const b = lineBox(c);
    return Math.abs(b[1] + b[3] / 2 - (y0 + h0 / 2)) < 0.6 * h0 && nWords(c) <= 2;
  });
  if (click.y < frameH * 0.08 && row.length >= 3) return true;
  const col = all.filter((c) => {
    const b = lineBox(c);
    return Math.abs(b[0] - x0) <= Math.max(4, 0.4 * h0) && c !== ctrl && Math.abs(b[1] - y0) < 5 * h0 && nWords(c) <= 3;
  });
  return col.length >= 2;
}

export interface StepDraft {
  label: string;
  target: string;
  verb: string;
  confidence: number;
  box: { x: number; y: number; w: number; h: number } | null;
}

export function labelClick(frameH: number, click: Click, both: [OcrWord[], OcrWord[]], ox: number, oy: number): StepDraft {
  let words = mergePolarities(both[0], both[1]).map((w) => ({ ...w, x: w.x + ox, y: w.y + oy }));
  words = words.filter((w) => w.conf >= 20 || w.text.length > 2);
  const lines = words.length ? groupLines(words) : [];
  const ctrls = controls(lines).filter((c) => clean(c.words));
  let best: OcrLine | null = null;
  let bestD = 1e9;
  let inside = false;
  for (const c of ctrls) {
    const [x, y, w, h] = lineBox(c);
    const px = 0.6 * h + 6;
    const py = 0.9 * h + 4;
    if (x - px <= click.x && click.x <= x + w + px && y - py <= click.y && click.y <= y + h + py) {
      const d = Math.abs(click.x - (x + w / 2)) / Math.max(1, w) + Math.abs(click.y - (y + h / 2)) / Math.max(1, h);
      if (!inside || d < bestD) [best, bestD, inside] = [c, d, true];
      continue;
    }
    if (inside) continue;
    const dx = Math.max(x - click.x, 0, click.x - (x + w));
    const dy = Math.max(y - click.y, 0, click.y - (y + h));
    const d = Math.hypot(dx, dy);
    if (d <= 40 && d < bestD) [best, bestD] = [c, d];
  }
  if (!best) return { label: "Click here", target: "", verb: "Click", confidence: 0, box: null };
  const text = clean(best.words);
  const verb = isNav(best, ctrls, text, click, frameH) ? "Open" : "Click";
  const conf = (best.words.reduce((a, w) => a + w.conf, 0) / best.words.length / 100) * (inside ? 1.0 : 0.6);
  const [x, y, w, h] = lineBox(best);
  const px = 0.6 * h + 6;
  const py = 0.9 * h + 4;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return { label: `${verb} ${text}`, target: text, verb, confidence: Math.round(conf * 1000) / 1000, box: { x: r1(x - px), y: r1(y - py), w: r1(w + 2 * px), h: r1(h + 2 * py) } };
}

export async function stepLabels(ffmpeg: string, video: string, events: string, leadMs = 80): Promise<Record<string, unknown>> {
  const info = await probe(ffmpeg, video);
  const { fps, width: W, height: H } = info;
  const clicks = loadClicks(events);
  const idx = clicks.map((c) => Math.max(0, Math.round(((c.t - leadMs) * fps) / 1000)));
  const want = new Set(idx);
  const last = Math.max(-1, ...idx);
  const frames = new Map<number, Gray>();
  let i = -1;
  let lastFrame: Gray | null = null;
  if (last >= 0) {
    for await (const d of decode(ffmpeg, video, W, H, "gray")) {
      i++;
      const g = { w: W, h: H, d };
      lastFrame = g;
      if (want.has(i)) frames.set(i, g);
      if (i >= last) break;
    }
  }
  for (const j of want) if (!frames.has(j) && lastFrame) frames.set(j, lastFrame);
  const crops: Gray[] = [];
  const offs: Array<[number, number]> = [];
  clicks.forEach((c, n) => {
    const g = frames.get(idx[n]!)!;
    const x0 = Math.trunc(Math.max(0, Math.min(W - 2 * ROI_W, c.x - ROI_W)));
    const y0 = Math.trunc(Math.max(0, Math.min(H - 2 * ROI_H, c.y - ROI_H)));
    const roi = crop(g, x0, y0, Math.min(2 * ROI_W, W - x0), Math.min(2 * ROI_H, H - y0));
    crops.push(roi, contrastMap(roi));
    offs.push([x0, y0]);
  });
  const pool = new OcrPool();
  let res: OcrWord[][] = [];
  try {
    res = await pool.ocrAll(crops, 2.0);
  } finally {
    await pool.close();
  }
  const drafts = clicks.map((c, n) => ({
    id: `st${n + 1}`, clickMs: Math.round(c.t * 100) / 100, x: Math.round(c.x * 10) / 10, y: Math.round(c.y * 10) / 10,
    ...labelClick(H, c, [res[2 * n]!, res[2 * n + 1]!], offs[n]![0], offs[n]![1]),
  }));
  return { version: 1, engine: { ocr: "tesseract.js", psm: 11, roi: [2 * ROI_W, 2 * ROI_H], leadMs }, source: { video, events }, drafts };
}
