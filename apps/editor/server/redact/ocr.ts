/**
 * On-device OCR in-process: tesseract.js (Tesseract 5 compiled to WebAssembly, Apache-2.0) with the
 * same English LSTM model the Python pipeline's tesseract CLI uses (tessdata_fast eng.traineddata,
 * shipped with the app), sparse-text segmentation (psm 11), word boxes from the TSV output, and Lens's
 * own line grouping (port of redact/lens_redact/ocr.py).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { Gray } from "./imgops";
import { resizeLinear, toPgm } from "./imgops";
import { tessdataDir } from "../models";

export interface OcrWord {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  conf: number;
}

export interface OcrLine {
  words: OcrWord[];
}

export function lineBox(l: OcrLine): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const w of l.words) {
    x0 = Math.min(x0, w.x);
    y0 = Math.min(y0, w.y);
    x1 = Math.max(x1, w.x + w.w);
    y1 = Math.max(y1, w.y + w.h);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

const FOLD: Record<string, string> = { "©": "@", "®": "@", "—": "-", "–": "-", "‐": "-", "“": '"', "”": '"', "’": "'", "‘": "'", "|": "I" };

/** OCR confusions folded before classification, then ASCII only (as ocr.py). */
export function fold(s: string): string {
  let t = "";
  for (const ch of s) t += FOLD[ch] ?? ch;
  return t.normalize("NFKD").replace(/[^\x00-\x7f]/g, "");
}

/** Words (level 5 rows) of a tesseract TSV page. */
export function parseTsv(tsv: string): OcrWord[] {
  const out: OcrWord[] = [];
  for (const line of tsv.split("\n")) {
    const c = line.split("\t");
    if (c.length < 12 || c[0] !== "5") continue;
    const text = fold(c.slice(11).join("\t")).trim();
    if (!text) continue;
    out.push({ text, x: Number(c[6]), y: Number(c[7]), w: Number(c[8]), h: Number(c[9]), conf: Number(c[10]) });
  }
  return out;
}

type TWorker = { setParameters(p: Record<string, string>): Promise<unknown>; recognize(img: Buffer, o: object, out: object): Promise<{ data: { tsv: string | null } }>; terminate(): Promise<unknown> };

const req = createRequire(typeof __filename !== "undefined" ? __filename : import.meta.url);

/** A small pool of tesseract.js workers (each a worker thread with its own wasm instance). */
export class OcrPool {
  private workers: Promise<TWorker>[] = [];
  private queue: Array<() => void> = [];
  private free: TWorker[] = [];
  // LENS_OCR_WORKERS: pool size (each worker holds its own ~100 MB wasm heap; 1 on low-memory machines)
  constructor(private readonly size = Number(process.env.LENS_OCR_WORKERS) || Math.max(1, Math.min(2, os.cpus().length))) {}

  private async make(): Promise<TWorker> {
    const T = req("tesseract.js") as { createWorker: (...a: unknown[]) => Promise<TWorker>; OEM: Record<string, number> };
    const dir = tessdataDir();
    if (!dir) throw new Error("OCR model (eng.traineddata) not found: run `node scripts/fetch-models.mjs` or set LENS_MODELS_DIR");
    const w = await T.createWorker("eng", T.OEM.LSTM_ONLY, { langPath: dir, gzip: false, cacheMethod: "none", logger: () => undefined, errorHandler: () => undefined });
    await w.setParameters({ tessedit_pageseg_mode: "11" });
    return w;
  }

  private async acquire(): Promise<TWorker> {
    if (this.free.length) return this.free.pop()!;
    if (this.workers.length < this.size) {
      const p = this.make();
      this.workers.push(p);
      return p;
    }
    await new Promise<void>((r) => this.queue.push(r));
    return this.free.pop()!;
  }

  private release(w: TWorker): void {
    this.free.push(w);
    this.queue.shift()?.();
  }

  /** OCR one grey image (optionally upscaled first); words in that image's pixel coordinates. */
  async ocr(img: Gray, scale = 1): Promise<OcrWord[]> {
    const w = await this.acquire();
    try {
      const src = scale !== 1 ? resizeLinear(img, Math.round(img.w * scale), Math.round(img.h * scale)) : img;
      const r = await w.recognize(toPgm(src), {}, { tsv: true, text: false, blocks: false, hocr: false });
      const words = parseTsv(r.data.tsv ?? "");
      if (scale !== 1) for (const q of words) [q.x, q.y, q.w, q.h] = [q.x, q.y, q.w, q.h].map((v) => Math.round(v / scale)) as [number, number, number, number];
      return words;
    } finally {
      this.release(w);
    }
  }

  async ocrAll(imgs: Gray[], scale = 1, onDone?: (n: number) => void): Promise<OcrWord[][]> {
    let n = 0;
    return Promise.all(imgs.map((im) => this.ocr(im, scale).then((r) => (onDone?.(++n), r))));
  }

  async close(): Promise<void> {
    const ws = await Promise.allSettled(this.workers);
    await Promise.all(ws.map((w) => (w.status === "fulfilled" ? w.value.terminate() : undefined)));
    this.workers = [];
    this.free = [];
  }
}

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Words into text lines: same row (centres within half a word height) and gaps under 2.5 word heights. */
export function groupLines(words: OcrWord[]): OcrLine[] {
  const ws = [...words].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2) || a.x - b.x);
  const rows: OcrWord[][] = [];
  for (const w of ws) {
    const cy = w.y + w.h / 2;
    let placed = false;
    for (const r of rows) {
      const rh = median(r.map((q) => q.h));
      const rcy = median(r.map((q) => q.y + q.h / 2));
      if (Math.abs(cy - rcy) <= 0.5 * Math.max(rh, w.h)) {
        r.push(w);
        placed = true;
        break;
      }
    }
    if (!placed) rows.push([w]);
  }
  const lines: OcrLine[] = [];
  for (const r of rows) {
    r.sort((a, b) => a.x - b.x);
    let cur = [r[0]!];
    for (const q of r.slice(1)) {
      const p = cur[cur.length - 1]!;
      const gap = q.x - (p.x + p.w);
      const hh = Math.max(8, median(cur.map((z) => z.h)));
      if (gap <= 2.5 * hh) cur.push(q);
      else {
        lines.push({ words: cur });
        cur = [q];
      }
    }
    lines.push({ words: cur });
  }
  return lines;
}

export function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
