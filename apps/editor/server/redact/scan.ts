/**
 * Privacy scan in-process (no Python): the TypeScript port of redact/lens_redact/scan.py, same passes,
 * same constants. See that file for the design; in short:
 *   1. analysis: 1/4-size grey frames, phase-correlation scroll, motion-compensated residual -> OCR
 *      sample frames (first, scene change, scroll, interval) and notification banners;
 *   2. OCR (tesseract.js, eng LSTM, psm 11) on the samples, classify.ts;
 *   3. tracking at full resolution with NCC template matching (forward, plus backwards through a
 *      frame buffer), merging, and detections with redacted previews only (the secret text itself is
 *      never written: preview / thumbnail of the masked region only).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { maskPreview } from "./classify";
import { hitsFromWords, iou, type Box, type FrameHit } from "./frame";
import {
  PhaseCorrelator, areaDownInt, areaResizeF, canny, close, components, crop, matchTemplateBest, morph, resizeArea, rgbToGray, stdDev, translate,
  type Gray,
} from "./imgops";
import { OcrPool, tmpDir, type OcrWord } from "./ocr";

export const VERSION = 1;

export interface ScanSettings {
  intervalMs: number;
  sceneThreshold: number;
  tileThreshold: number;
  scrollFraction: number;
  settleFrames: number;
  minGapMs: number;
  notifications: boolean;
  padPx: number;
  matchThreshold: number;
  bufferFrames: number;
  types: string[];
}

export const DEFAULT_SETTINGS: ScanSettings = {
  intervalMs: 1000, sceneThreshold: 4.0, tileThreshold: 12.0, scrollFraction: 0.33, settleFrames: 3, minGapMs: 200, notifications: true,
  padPx: 6, matchThreshold: 0.72, bufferFrames: 72, types: ["email", "phone", "card", "api_key", "token", "jwt", "ip", "notification"],
};

export type Progress = (stage: string, done: number, total: number) => void;

// ---------------------------------------------------------------- video io

export interface VideoInfo {
  width: number;
  height: number;
  fps: number;
  frames: number;
}

/** Size / rate from `ffmpeg -i` and the frame count from a null decode (no ffprobe in the desktop build). */
export async function probe(ffmpeg: string, video: string): Promise<VideoInfo> {
  const err = await new Promise<string>((resolve) => {
    const p = spawn(ffmpeg, ["-hide_banner", "-i", video, "-map", "0:v:0", "-c", "copy", "-f", "null", "-"]);
    let e = "";
    p.stderr.on("data", (d: Buffer) => (e += d.toString()));
    p.on("close", () => resolve(e));
    p.on("error", () => resolve(e));
  });
  const line = err.split(/\r?\n/).find((l) => /Stream #\d+:\d+.*: Video:/.test(l)) ?? "";
  const size = / (\d{2,5})x(\d{2,5})[ ,]/.exec(line);
  const fps = /([\d.]+) fps/.exec(line) ?? /([\d.]+) tbr/.exec(line);
  const frames = [...err.matchAll(/frame=\s*(\d+)/g)].pop();
  if (!size) throw new Error(`cannot read the video size of ${video}`);
  return { width: Number(size[1]), height: Number(size[2]), fps: fps ? Number(fps[1]) : 30, frames: frames ? Number(frames[1]) : 0 };
}

/** Decode every frame as rgb24 or gray, one at a time (back-pressure on ffmpeg's pipe). */
export async function* decode(ffmpeg: string, video: string, w: number, h: number, fmt: "rgb24" | "gray"): AsyncGenerator<Uint8Array> {
  const ch = fmt === "gray" ? 1 : 3;
  const n = w * h * ch;
  const p = spawn(ffmpeg, ["-v", "error", "-i", video, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", fmt, "-"], { stdio: ["ignore", "pipe", "ignore"] });
  let buf = Buffer.alloc(0);
  try {
    for await (const chunk of p.stdout as AsyncIterable<Buffer>) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= n) {
        yield new Uint8Array(buf.subarray(0, n));
        buf = buf.subarray(n);
      }
    }
  } finally {
    p.kill();
  }
}

// ---------------------------------------------------------------- pass 1: analysis

export interface Analysis {
  fps: number;
  width: number;
  height: number;
  n: number;
  shift: Array<[number, number]>;
  residual: number[];
  samples: number[];
  sampleReason: Map<number, string>;
  notifications: Array<[number, Box]>;
}

function translateFloat(img: Gray, dx: number, dy: number): Float32Array {
  return translate(img, dx, dy);
}

export async function analyse(ffmpeg: string, video: string, info: VideoInfo, s: ScanSettings, scrollFrames: Set<number>, sampleDir: string, progress?: Progress): Promise<Analysis> {
  const { width: W, height: H, fps } = info;
  const q = 4;
  const sw = Math.floor(W / q);
  const sh = Math.floor(H / q);
  const interval = Math.max(1, Math.round((s.intervalMs * fps) / 1000));
  const minGap = Math.max(1, Math.round((s.minGapMs * fps) / 1000));
  const hist: Array<[number, Gray]> = [];
  const shifts: Array<[number, number]> = [];
  const resid: number[] = [];
  const samples: number[] = [];
  const reason = new Map<number, string>();
  const pendingScene: number[] = [];
  const pendingNotif: number[] = [];
  const notifs: Array<[number, Box]> = [];
  let lastSample = -1e9;
  let cum: [number, number] = [0, 0];
  let changedSince = false;
  let prev: Gray | null = null;
  let prevSpec: ReturnType<PhaseCorrelator["spectrum"]> | null = null;
  const pc = new PhaseCorrelator(sw, sh);
  const total = info.frames || 1;
  let i = -1;
  const take = (f: number, rgb: Uint8Array, gray: Gray, why: string) => {
    samples.push(f);
    reason.set(f, why);
    lastSample = f;
    cum = [0, 0];
    changedSince = false;
    fs.writeFileSync(path.join(sampleDir, `${f}.gray`), gray.d);
    fs.writeFileSync(path.join(sampleDir, `${f}.rgb`), rgb);
  };
  for await (const rgb of decode(ffmpeg, video, W, H, "rgb24")) {
    i++;
    const full = rgbToGray(rgb, W, H);
    const half = areaDownInt(full, 2);
    const g = areaDownInt(half, 2);
    const spec = pc.spectrum(g);
    if (!prev) {
      shifts.push([0, 0]);
      resid.push(0);
    } else {
      let { dx, dy, resp } = pc.correlate(prevSpec!, spec);
      if (resp < 0.05 || Math.abs(dx) > sw / 3 || Math.abs(dy) > sh / 3) dx = dy = 0;
      const moved = Math.abs(dx) > 0.25 || Math.abs(dy) > 0.25 ? translateFloat(prev, dx, dy) : null;
      const mres = new Float32Array(sw * sh);
      let sum = 0;
      for (let k = 0; k < mres.length; k++) {
        const plain = Math.abs(prev.d[k]! - g.d[k]!);
        const m = moved ? Math.abs(Math.round(moved[k]!) - g.d[k]!) : plain;
        mres[k] = Math.min(plain, m);
        sum += mres[k]!;
      }
      const r = sum / mres.length;
      const tiles = areaResizeF({ w: sw, h: sh, d: mres }, 8, 6);
      let tile = 0;
      for (const v of tiles.d) tile = Math.max(tile, v);
      let dxq = dx * q;
      let dyq = dy * q;
      if (Math.abs(dxq) < 1) dxq = 0;
      if (Math.abs(dyq) < 1) dyq = 0;
      shifts.push([dxq, dyq]);
      resid.push(r);
      cum[0] += dxq;
      cum[1] += dyq;
      if (r > 0.6 || Math.abs(dx) > 0.25 || Math.abs(dy) > 0.25) changedSince = true;
      if (r > s.sceneThreshold || tile > s.tileThreshold) {
        pendingScene.push(i + s.settleFrames);
        if (s.notifications) pendingNotif.push(i);
      }
    }
    hist.push([i, half]);
    if (hist.length > 64) hist.shift();
    let why: string | null = null;
    if (i === 0) why = "first";
    else if (pendingScene.length && i >= pendingScene[0]!) {
      while (pendingScene.length && pendingScene[0]! <= i) pendingScene.shift();
      if (i - lastSample >= minGap) why = "scene";
    } else if (Math.abs(cum[1]) > s.scrollFraction * H || Math.abs(cum[0]) > s.scrollFraction * W) why = "scroll";
    else if (i - lastSample >= interval && changedSince) why = "interval";
    if (scrollFrames.size && why === null && scrollFrames.has(i) && i - lastSample >= Math.floor(interval / 2) && changedSince) why = "scroll-event";
    if (why) take(i, rgb, full, why);
    while (pendingNotif.length && i >= pendingNotif[0]! + 27) {
      const c = pendingNotif.shift()!;
      const box = confirmNotification(hist, c, Math.floor(W / 2), Math.floor(H / 2), 2, shifts);
      if (box && !notifs.some(([f, b]) => Math.abs(c - f) < fps * 1.0 && iou(box, b) > 0.3)) notifs.push([c + 15, box]);
    }
    prev = g;
    prevSpec = spec;
    if (progress && i % 30 === 0) progress("analyse", i, total);
  }
  return { fps, width: W, height: H, n: i + 1, shift: shifts, residual: resid, samples, sampleReason: reason, notifications: notifs };
}

function confirmNotification(hist: Array<[number, Gray]>, c: number, hw: number, hh: number, q: number, shifts: Array<[number, number]>): Box | null {
  const d = new Map(hist);
  const b = d.get(c - 1);
  const nowG = d.get(c + 15);
  const laterG = d.get(c + 27);
  if (!b || !nowG || !laterG) return null;
  const w = nowG.w;
  const h = nowG.h;
  const cumShift = (a: number, z: number): [number, number] => {
    let sx = 0;
    let sy = 0;
    for (let k = a + 1; k <= z; k++) {
      sx += shifts[k]![0];
      sy += shifts[k]![1];
    }
    return [sx / q, sy / q];
  };
  const s1 = cumShift(c - 1, c + 15);
  const s2 = cumShift(c + 15, c + 27);
  const bMoved = translate(b, s1[0], s1[1]);
  const newM = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) newM[k] = Math.abs(nowG.d[k]! - b.d[k]!) > 24 && Math.abs(nowG.d[k]! - Math.round(bMoved[k]!)) > 24 ? 1 : 0;
  const still = new Uint8Array(w * h);
  const moved2 = Math.abs(s2[0]) + Math.abs(s2[1]) >= 2 ? translate(nowG, s2[0], s2[1]) : null;
  for (let k = 0; k < w * h; k++) {
    let v = Math.abs(laterG.d[k]! - nowG.d[k]!) < 10;
    if (moved2) v = v && Math.abs(laterG.d[k]! - Math.round(moved2[k]!)) > 24;
    still[k] = v ? 1 : 0;
  }
  const newE = morph(newM, w, h, 2, 2, "erode");
  const m = new Uint8Array(w * h);
  const zx = Math.floor(hw * 0.6);
  const zy0 = Math.floor(hh * 0.35);
  const zy1 = Math.floor(hh * 0.65);
  let msum = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      const inZone = (y < zy0 || y >= zy1) && (x >= zx || x < hw - zx);
      const v = newE[k]! && still[k]! && inZone ? 1 : 0;
      m[k] = v;
      msum += v;
    }
  }
  if (msum < 40) return null;
  const blob = close(m, w, h, 15);
  let best: [number, number, number, number, number] | null = null;
  for (const cc of components(blob, w, h)) {
    const { x, y, w: bw, h: bh, area } = cc;
    if (!(0.12 * hw <= bw && bw <= 0.45 * hw && 0.05 * hh <= bh && bh <= 0.25 * hh)) continue;
    let ecount = 0;
    for (let yy = y; yy < y + bh; yy++) for (let xx = x; xx < x + bw; xx++) ecount += m[yy * w + xx]!;
    if (area / (bw * bh) < 0.5 || ecount < 0.02 * bw * bh) continue;
    if (!best || area > best[4]) best = [x, y, bw, bh, area];
  }
  if (!best) return null;
  const [x, y, bw, bh] = best;
  const edges = canny(nowG, 30, 90);
  const e = morph(edges, w, h, 1, 3, "dilate");
  const ev = morph(edges, w, h, 3, 1, "dilate");
  const reach = 30;
  const lineH = (yy: number, xa: number, xb: number) => {
    if (yy < 0 || yy >= hh) return false;
    const a = Math.max(0, xa);
    const z = Math.min(hw, xb);
    if (z <= a) return false;
    let s = 0;
    for (let xx = a; xx < z; xx++) s += e[yy * w + xx]!;
    return s / (z - a) > 0.85;
  };
  const lineV = (xx: number, ya: number, yb: number) => {
    if (xx < 0 || xx >= hw) return false;
    const a = Math.max(0, ya);
    const z = Math.min(hh, yb);
    if (z <= a) return false;
    let s = 0;
    for (let yy = a; yy < z; yy++) s += ev[yy * w + xx]!;
    return s / (z - a) > 0.85;
  };
  let top: number | null = null;
  for (let yy = y; yy > y - reach; yy--) if (lineH(yy, x, x + bw)) { top = yy; break; }
  let bot: number | null = null;
  for (let yy = y + bh; yy < y + bh + reach; yy++) if (lineH(yy, x, x + bw)) { bot = yy; break; }
  const y0s = top ?? y;
  const y1s = bot ?? y + bh;
  let lef: number | null = null;
  for (let xx = x; xx > x - 80; xx--) if (lineV(xx, y0s + 3, y1s - 3)) { lef = xx; break; }
  let rig: number | null = null;
  for (let xx = x + bw; xx < x + bw + 80; xx++) if (lineV(xx, y0s + 3, y1s - 3)) { rig = xx; break; }
  const snapped = [top, bot, lef, rig].filter((v) => v !== null).length;
  let x0 = (lef ?? x) * q - 4;
  let y0 = y0s * q - 4;
  let x1 = (rig ?? x + bw) * q + 4;
  let y1 = y1s * q + 4;
  const Wf = hw * q;
  const Hf = hh * q;
  let atEdge = 0;
  if (Wf - x1 < 48) { x1 = Wf; atEdge += rig === null ? 1 : 0; }
  if (x0 < 48) { x0 = 0; atEdge += lef === null ? 1 : 0; }
  if (Hf - y1 < 48) { y1 = Hf; atEdge += bot === null ? 1 : 0; }
  if (y0 < 48) atEdge += top === null ? 1 : 0;
  if (snapped + atEdge < 3) return null;
  return [Math.max(0, x0), Math.max(0, y0), Math.min(Wf, x1) - Math.max(0, x0), Math.min(Hf, y1) - Math.max(0, y0)];
}

// ---------------------------------------------------------------- pass 3: tracking

type Rect = [number, number, number, number];

interface Track {
  id: number;
  type: string;
  template: Gray;
  rects: Map<number, Rect>;
  texts: string[];
  conf: number[];
  vel: [number, number];
  alive: boolean;
  coast: number;
  firstHit: number;
  thumb: string | null;
}

const TEMPLATE_MARGIN = 4;
const lastOf = (t: Track): [number, Rect] => {
  let f = -Infinity;
  for (const k of t.rects.keys()) if (k > f) f = k;
  return [f, t.rects.get(f)!];
};
const firstFrame = (t: Track) => Math.min(...t.rects.keys());
const lastFrame = (t: Track) => Math.max(...t.rects.keys());

function nccWindow(frame: Gray, tpl: Gray, cx: number, cy: number, rx: number, ry: number): [number, number, number] {
  const x0 = Math.max(0, Math.floor(cx - rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const x1 = Math.min(frame.w, Math.ceil(cx + rx) + tpl.w);
  const y1 = Math.min(frame.h, Math.ceil(cy + ry) + tpl.h);
  if (x1 - x0 < tpl.w || y1 - y0 < tpl.h) return [-1, cx, cy];
  return matchTemplateBest(frame, tpl, x0, y0, x1, y1);
}

const textured = (t: Gray) => t.d.length > 0 && stdDev(t) > 8.0;

function linspaceInt(a: number, b: number, n: number): number[] {
  return Array.from({ length: n + 1 }, (_, i) => Math.trunc(a + ((b - a) * i) / n));
}

function follow(frame: Gray, tr: Track, prev: Rect, step: number, gshift: [number, number], s: ScanSettings, wideY: number): Rect | null {
  const W = frame.w;
  const H = frame.h;
  const [x, y, w, h] = prev;
  const tpl = tr.template;
  const th = tpl.h;
  const tw = tpl.w;
  const tx = x + w / 2 - tw / 2;
  const ty = y + h / 2 - th / 2;
  const bw = tw - 2 * TEMPLATE_MARGIN;
  const bh = th - 2 * TEMPLATE_MARGIN;
  const preds: Array<[number, number]> = [[tx + tr.vel[0] * step, ty + tr.vel[1] * step], [tx + gshift[0], ty + gshift[1]], [tx, ty]];
  const inside = (px: number, py: number) => px >= 0 && py >= 0 && px + tw <= W && py + th <= H;
  let best: [number, number, number] = [-1, tx, ty];
  if (preds.slice(0, 2).every(([px, py]) => inside(px, py))) {
    for (const [px, py] of preds) {
      const r = nccWindow(frame, tpl, px, py, 6, 6);
      if (r[0] > best[0]) best = r;
      if (best[0] >= s.matchThreshold + 0.1) break;
    }
    if (best[0] < s.matchThreshold) {
      const r = nccWindow(frame, tpl, tx, ty, 64, wideY);
      if (r[0] > best[0]) best = r;
    }
    if (best[0] >= s.matchThreshold) {
      tr.coast = 0;
      return [best[1] + TEMPLATE_MARGIN, best[2] + TEMPLATE_MARGIN, bw, bh];
    }
  }
  const [px, py] = Math.abs(gshift[0]) + Math.abs(gshift[1]) > Math.abs(tr.vel[0]) + Math.abs(tr.vel[1]) ? preds[1]! : preds[0]!;
  const cols = Math.max(1, Math.min(16, Math.trunc(tw / Math.max(24, th))));
  const rows = th >= 16 ? 2 : 1;
  const xe = linspaceInt(0, tw, cols);
  const ye = linspaceInt(0, th, rows);
  const found: Array<[number, number]> = [];
  for (let a = 0; a < cols; a++) {
    const a0 = xe[a]!;
    const a1 = xe[a + 1]!;
    for (let bI = 0; bI < rows; bI++) {
      const b0 = ye[bI]!;
      const b1 = ye[bI + 1]!;
      const sx = Math.round(px) + a0;
      const sy = Math.round(py) + b0;
      const cx0 = Math.max(0, sx);
      const cy0 = Math.max(0, sy);
      const cx1 = Math.min(W, sx + (a1 - a0));
      const cy1 = Math.min(H, sy + (b1 - b0));
      if (cx1 - cx0 < 12 || cy1 - cy0 < Math.max(5, Math.floor(((b1 - b0) * 2) / 3))) continue;
      const part = crop(tpl, a0 + cx0 - sx, b0 + cy0 - sy, cx1 - cx0, cy1 - cy0);
      if (!textured(part)) continue;
      const r = nccWindow(frame, part, cx0, cy0, 8, 10);
      if (r[0] >= 0.78) found.push([r[1] - (cx0 - sx) - a0, r[2] - (cy0 - sy) - b0]);
    }
  }
  if (found.length >= 1) {
    const med = (v: number[]) => {
      const t = [...v].sort((p, qq) => p - qq);
      const m = t.length >> 1;
      return t.length % 2 ? t[m]! : (t[m - 1]! + t[m]!) / 2;
    };
    tr.coast = 0;
    return [med(found.map((f) => f[0])) + TEMPLATE_MARGIN, med(found.map((f) => f[1])) + TEMPLATE_MARGIN, bw, bh];
  }
  const mv: [number, number] = Math.abs(gshift[0]) + Math.abs(gshift[1]) > 0.3 ? gshift : [tr.vel[0] * step, tr.vel[1] * step];
  const nx = x + mv[0];
  const ny = y + mv[1];
  const moving = Math.abs(mv[0]) + Math.abs(mv[1]) >= 0.5;
  const visW = Math.min(W, nx + w) - Math.max(0, nx);
  const visH = Math.min(H, ny + h) - Math.max(0, ny);
  const onEdge = nx < 0 || ny < 0 || nx + w > W || ny + h > H;
  const limit = onEdge ? 12 : 6;
  if (moving && visW > 0 && visH > 0 && tr.coast < limit) {
    tr.coast += 1;
    const g = 2.0;
    return [nx - g, ny - g, w + 2 * g, h + 2 * g];
  }
  return null;
}

function stay(frame: Gray, tr: Track, rect: Rect, s: ScanSettings): Rect | null {
  const [x, y, w, h] = rect;
  const tx = x - (tr.template.w - w) / 2;
  const ty = y - (tr.template.h - h) / 2;
  const r = nccWindow(frame, tr.template, tx, ty, 4, 4);
  return r[0] >= s.matchThreshold ? rect : null;
}

function contain(a: number[], b: number[]): number {
  const ix = Math.max(0, Math.min(a[0]! + a[2]!, b[0]! + b[2]!) - Math.max(a[0]!, b[0]!));
  const iy = Math.max(0, Math.min(a[1]! + a[3]!, b[1]! + b[3]!) - Math.max(a[1]!, b[1]!));
  const sm = Math.min(a[2]! * a[3]!, b[2]! * b[3]!);
  return sm > 0 ? (ix * iy) / sm : 0;
}

const typeCompat = (a: string, b: string) => a === b || ((a === "token" || b === "token") && ["token", "api_key", "jwt"].includes(a) && ["token", "api_key", "jwt"].includes(b));

async function track(ffmpeg: string, video: string, an: Analysis, hits: Map<number, FrameHit[]>, s: ScanSettings, scrollFrames: Set<number>,
  thumbs: (f: number, box: Box, tid: number) => string | null, progress?: Progress): Promise<Track[]> {
  const W = an.width;
  const H = an.height;
  const buf: Array<[number, Gray]> = [];
  const tracks: Track[] = [];
  let live: Track[] = [];
  const margin = TEMPLATE_MARGIN;
  const linger = Math.round(0.5 * an.fps);
  let f = -1;
  for await (const data of decode(ffmpeg, video, W, H, "gray")) {
    f++;
    const g: Gray = { w: W, h: H, d: data };
    const gs = f < an.shift.length ? an.shift[f]! : ([0, 0] as [number, number]);
    const wideY = scrollFrames.has(f) ? 160 : 96;
    for (const tr of live) {
      const [lf, lr] = lastOf(tr);
      if (lf !== f - 1) continue;
      let nr = tr.type !== "notification" ? follow(g, tr, lr, +1, gs, s, wideY) : stay(g, tr, lr, s);
      if (nr === null && tr.type === "notification" && tr.coast < linger) {
        tr.coast += 1;
        nr = lr;
      }
      if (nr === null) {
        tr.alive = false;
        continue;
      }
      tr.vel = [nr[0] - lr[0], nr[1] - lr[1]];
      tr.rects.set(f, nr);
    }
    live = live.filter((t) => t.alive);
    for (const hit of hits.get(f) ?? []) {
      const [x, y, w, h] = hit.box;
      let match: Track | null = null;
      for (const tr of live) {
        const r = tr.rects.get(f);
        if (r && typeCompat(tr.type, hit.type) && contain(hit.box, r) > 0.6) {
          if (hit.box[2] * hit.box[3] > 1.25 * r[2] * r[3]) continue;
          match = tr;
          break;
        }
      }
      if (match) {
        match.texts.push(hit.text);
        match.conf.push(hit.confidence);
        match.coast = 0;
        if (iou(match.rects.get(f)!, hit.box) > 0.6) match.rects.set(f, [x, y, w, h]);
        if (match.type === "token" && hit.type !== "token") match.type = hit.type;
        continue;
      }
      const x0 = Math.max(0, x - margin);
      const y0 = Math.max(0, y - margin);
      const x1 = Math.min(W, x + w + margin);
      const y1 = Math.min(H, y + h + margin);
      if (y1 - y0 < 6 || x1 - x0 < 6) continue;
      const tpl = crop(g, x0, y0, x1 - x0, y1 - y0);
      const tr: Track = { id: tracks.length, type: hit.type, template: tpl, rects: new Map(), texts: [hit.text], conf: [hit.confidence], vel: [0, 0], alive: true, coast: 0, firstHit: f, thumb: null };
      tr.rects.set(f, [x0 + margin, y0 + margin, x1 - x0 - 2 * margin, y1 - y0 - 2 * margin]);
      tr.thumb = thumbs(f, hit.box, tr.id);
      let cur = tr.rects.get(f)!;
      tr.vel = [0, 0];
      if (tr.type !== "notification") {
        for (let bi = buf.length - 1; bi >= 0; bi--) {
          const [bf, bg] = buf[bi]!;
          if (bf !== firstFrame(tr) - 1) break;
          const back = bf + 1 < an.shift.length ? an.shift[bf + 1]! : [0, 0];
          const nr = follow(bg, tr, cur, -1, [-back[0]!, -back[1]!], s, wideY);
          if (nr === null) break;
          tr.vel = [cur[0] - nr[0], cur[1] - nr[1]];
          tr.rects.set(bf, nr);
          cur = nr;
        }
      } else {
        const ff = firstFrame(tr);
        for (let k = Math.max(0, f - 18); k < ff; k++) tr.rects.set(k, tr.rects.get(f)!);
      }
      tr.vel = [0, 0];
      tr.coast = 0;
      tracks.push(tr);
      live.push(tr);
    }
    buf.push([f, g]);
    if (buf.length > s.bufferFrames) buf.shift();
    if (progress && f % 30 === 0) progress("track", f, an.n);
  }
  return tracks;
}

function coMoving(a: Track, b: Track, shared: number[], tol = 4.0): boolean {
  const dx = shared.map((f) => a.rects.get(f)![0] - b.rects.get(f)![0]);
  const dy = shared.map((f) => a.rects.get(f)![1] - b.rects.get(f)![1]);
  return Math.max(...dx) - Math.min(...dx) <= tol && Math.max(...dy) - Math.min(...dy) <= tol;
}

function adjacent(a: Rect, b: Rect): boolean {
  const vo = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  if (vo < 0.6 * Math.min(a[3], b[3])) return false;
  const gap = Math.max(a[0], b[0]) - Math.min(a[0] + a[2], b[0] + b[2]);
  return gap <= 1.5 * Math.max(a[3], b[3]);
}

function join(a: Track, b: Track, f: number): void {
  const ra = a.rects.get(f)!;
  const rb = b.rects.get(f)!;
  const ux0 = Math.min(ra[0], rb[0]);
  const uy0 = Math.min(ra[1], rb[1]);
  const ux1 = Math.max(ra[0] + ra[2], rb[0] + rb[2]);
  const uy1 = Math.max(ra[1] + ra[3], rb[1] + rb[3]);
  const oa = [ux0 - ra[0], uy0 - ra[1]];
  const ob = [ux0 - rb[0], uy0 - rb[1]];
  const uw = ux1 - ux0;
  const uh = uy1 - uy0;
  const out = new Map<number, Rect>();
  for (const k of new Set([...a.rects.keys(), ...b.rects.keys()])) {
    const cands: Rect[] = [];
    const r1 = a.rects.get(k);
    if (r1) cands.push([r1[0] + oa[0]!, r1[1] + oa[1]!, uw, uh]);
    const r2 = b.rects.get(k);
    if (r2) cands.push([r2[0] + ob[0]!, r2[1] + ob[1]!, uw, uh]);
    const x0 = Math.min(...cands.map((c) => c[0]));
    const y0 = Math.min(...cands.map((c) => c[1]));
    const x1 = Math.max(...cands.map((c) => c[0] + c[2]));
    const y1 = Math.max(...cands.map((c) => c[1] + c[3]));
    out.set(k, [x0, y0, x1 - x0, y1 - y0]);
  }
  a.rects = out;
  a.texts.push(...b.texts);
  a.conf.push(...b.conf);
  const rank: Record<string, number> = { jwt: 0, api_key: 1, token: 2 };
  if ((rank[b.type] ?? 9) < (rank[a.type] ?? 9)) a.type = b.type;
  a.thumb ??= b.thumb;
}

function absorb(big: Track, small: Track, f: number): void {
  const [bx, by, bw, bh] = big.rects.get(f)!;
  const [sx, sy] = small.rects.get(f)!;
  const ox = bx - sx;
  const oy = by - sy;
  for (const [k, r] of small.rects) if (!big.rects.has(k)) big.rects.set(k, [r[0] + ox, r[1] + oy, bw, bh]);
  big.texts.push(...small.texts);
  big.conf.push(...small.conf);
  if (big.type === "token" && small.type !== "token") big.type = small.type;
  big.thumb ??= small.thumb;
}

function mode(texts: string[]): string {
  const c = new Map<string, number>();
  let best = "";
  let n = 0;
  for (const t of texts) {
    const v = (c.get(t) ?? 0) + 1;
    c.set(t, v);
    if (v > n) [best, n] = [t, v];
  }
  return best;
}

const normT = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function sim(a0: string, b0: string): number {
  const a = normT(a0);
  const b = normT(b0);
  if (!a || !b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] !== b[j - 1] ? 1 : 0)));
    prev = cur;
  }
  return 1 - prev[b.length]! / Math.max(a.length, b.length);
}

function mergeTracks(tracks: Track[], an: Analysis, maxGapS = 3.0): Track[] {
  let ts: Array<Track | null> = [...tracks].sort((p, q) => firstFrame(p) - firstFrame(q));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < ts.length; i++) {
      for (let j = 0; j < ts.length; j++) {
        const a = ts[i];
        const b = ts[j];
        if (i === j || !a || !b) continue;
        if (!typeCompat(a.type, b.type) || (a.type === "notification") !== (b.type === "notification")) continue;
        const shared = [...a.rects.keys()].filter((k) => b.rects.has(k)).sort((p, q) => p - q);
        if (shared.length && !coMoving(a, b, shared)) continue;
        if (shared.length) {
          let f = shared.find((k) => contain(a.rects.get(k)!, b.rects.get(k)!) > 0.6);
          if (f === undefined) {
            f = shared.find((k) => adjacent(a.rects.get(k)!, b.rects.get(k)!));
            if (f === undefined || a.type === "notification") continue;
            join(a, b, f);
            ts[j] = null;
            changed = true;
            continue;
          }
          const ra = a.rects.get(f)!;
          const rb = b.rects.get(f)!;
          const [big, small] = ra[2] * ra[3] >= rb[2] * rb[3] ? [a, b] : [b, a];
          absorb(big, small, f);
          ts[ts.indexOf(small)] = null;
          changed = true;
          continue;
        }
        const af = lastFrame(a);
        const bf = firstFrame(b);
        const gap = bf - af;
        if (gap <= 1 || gap > maxGapS * an.fps) continue;
        if (sim(mode(a.texts), mode(b.texts)) < 0.8) continue;
        let sx = 0;
        let sy = 0;
        for (let k = af + 1; k <= bf && k < an.shift.length; k++) {
          sx += an.shift[k]![0];
          sy += an.shift[k]![1];
        }
        const ra = a.rects.get(af)!;
        const moved: Rect = [ra[0] + sx, ra[1] + sy, ra[2], ra[3]];
        const rb = b.rects.get(bf)!;
        if (Math.max(iou(moved, rb), iou(ra, rb)) < 0.5) continue;
        for (let k = af + 1; k < bf; k++) {
          const u = (k - af) / gap;
          a.rects.set(k, [0, 1, 2, 3].map((n) => ra[n]! + (rb[n]! - ra[n]!) * u) as Rect);
        }
        for (const [k, r] of b.rects) a.rects.set(k, r);
        a.texts.push(...b.texts);
        a.conf.push(...b.conf);
        if (a.type === "token" && b.type !== "token") a.type = b.type;
        ts[j] = null;
        changed = true;
      }
    }
    ts = ts.filter((t) => t !== null);
  }
  return ts as Track[];
}

// ---------------------------------------------------------------- detections

const r2 = (v: number) => Math.round(v * 100) / 100;

function keysOf(tr: Track, fps: number, pad: number, W: number, H: number) {
  const keys: Array<{ tMs: number; rect: { x: number; y: number; w: number; h: number } }> = [];
  for (const f of [...tr.rects.keys()].sort((a, b) => a - b)) {
    const [x, y, w, h] = tr.rects.get(f)!;
    const x0 = Math.max(0, Math.floor(x - pad));
    const y0 = Math.max(0, Math.floor(y - pad));
    const x1 = Math.min(W, Math.ceil(x + w + pad));
    const y1 = Math.min(H, Math.ceil(y + h + pad));
    if (x1 - x0 < 2 || y1 - y0 < 2) continue;
    keys.push({ tMs: r2((f * 1000) / fps), rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } });
  }
  const same = (a: typeof keys[0]["rect"], b: typeof keys[0]["rect"]) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
  return keys.filter((k, i) => !(i > 0 && i < keys.length - 1 && same(k.rect, keys[i - 1]!.rect) && same(k.rect, keys[i + 1]!.rect)));
}

export interface Detection {
  id: string;
  type: string;
  preview: string;
  confidence: number;
  state: "pending";
  thumb: string | null;
  firstMs: number;
  tracks: Array<{ startMs: number; endMs: number; keys: ReturnType<typeof keysOf> }>;
}

function detectionsFromTracks(tracks: Track[], fps: number, W: number, H: number, s: ScanSettings): Detection[] {
  const frameMs = 1000 / fps;
  interface G { type: string; text: string; tracks: Detection["tracks"]; conf: number[]; thumb: string | null; first: number }
  const groups: G[] = [];
  for (const tr of [...tracks].sort((a, b) => firstFrame(a) - firstFrame(b))) {
    if (!s.types.includes(tr.type)) continue;
    const text = tr.texts.length ? mode(tr.texts) : "";
    const keys = keysOf(tr, fps, tr.type !== "notification" ? s.padPx : 2, W, H);
    if (!keys.length) continue;
    const f0 = firstFrame(tr);
    const f1 = lastFrame(tr);
    const seg = { startMs: r2(Math.max(0, (f0 - 1) * frameMs)), endMs: r2((f1 + 1) * frameMs), keys };
    let g: G | undefined;
    if (tr.type !== "notification") g = groups.find((c) => typeCompat(c.type, tr.type) && sim(c.text, text) >= 0.8);
    if (!g) {
      g = { type: tr.type, text, tracks: [], conf: [], thumb: tr.thumb, first: f0 };
      groups.push(g);
    }
    g.tracks.push(seg);
    g.conf.push(...tr.conf);
    if (g.type === "token" && tr.type !== "token") g.type = tr.type;
  }
  return groups
    .sort((a, b) => a.first - b.first)
    .map((g, i) => ({
      id: `pd${i + 1}`,
      type: g.type,
      preview: g.type !== "notification" ? maskPreview(g.text, g.type) : "Notification banner",
      confidence: Math.round((g.conf.length ? g.conf.reduce((p, q) => p + q, 0) / g.conf.length : 1) * 1000) / 1000,
      state: "pending" as const,
      thumb: g.thumb,
      firstMs: g.tracks[0]!.startMs,
      tracks: [...g.tracks].sort((a, b) => a.startMs - b.startMs),
    }));
}

// ---------------------------------------------------------------- entry point

export function scrollFramesFromEvents(eventsPath: string | null, fps: number): Set<number> {
  const out = new Set<number>();
  if (!eventsPath || !fs.existsSync(eventsPath)) return out;
  for (const raw of fs.readFileSync(eventsPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    try {
      const e = JSON.parse(line) as { type?: string; t?: number };
      if (e.type === "scroll" && typeof e.t === "number") {
        const f = Math.round((e.t * fps) / 1000);
        for (let k = f - 1; k < f + 3; k++) out.add(k);
      }
    } catch {
      // not an event line
    }
  }
  return out;
}

/** JPEG of an RGB crop (scaled down with area averaging), via ffmpeg. */
function writeJpeg(ffmpeg: string, rgb: Uint8Array, w: number, h: number, out: string, quality = 4): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${w}x${h}`, "-i", "pipe:0", "-frames:v", "1", "-q:v", String(quality), out]);
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`thumbnail encode failed (${c})`))));
    p.stdin.end(Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength));
  });
}

function cropRgbScaled(rgb: Uint8Array, W: number, box: Box, H: number): { d: Uint8Array; w: number; h: number } {
  const [x, y, w, h] = box;
  const m = 24;
  const x0 = Math.max(0, x - m);
  const y0 = Math.max(0, y - m);
  const x1 = Math.min(W, x + w + m);
  const y1 = Math.min(H, y + h + m);
  const cw = x1 - x0;
  const ch = y1 - y0;
  const sc = Math.min(1, 240 / Math.max(1, cw), 72 / Math.max(1, ch));
  const ow = Math.max(1, Math.round(cw * sc));
  const oh = Math.max(1, Math.round(ch * sc));
  const out = new Uint8Array(ow * oh * 3);
  for (let c = 0; c < 3; c++) {
    const plane = new Uint8Array(cw * ch);
    for (let yy = 0; yy < ch; yy++) for (let xx = 0; xx < cw; xx++) plane[yy * cw + xx] = rgb[((y0 + yy) * W + x0 + xx) * 3 + c]!;
    const r = sc < 1 ? resizeArea({ w: cw, h: ch, d: plane }, ow, oh) : { d: plane };
    for (let k = 0; k < ow * oh; k++) out[k * 3 + c] = r.d[k]!;
  }
  // even sizes for the encoder's chroma subsampling
  const ew = ow - (ow % 2) || 2;
  const eh = oh - (oh % 2) || 2;
  const even = new Uint8Array(ew * eh * 3);
  for (let yy = 0; yy < eh; yy++) for (let xx = 0; xx < ew; xx++) for (let c = 0; c < 3; c++) even[(yy * ew + xx) * 3 + c] = out[(Math.min(oh - 1, yy) * ow + Math.min(ow - 1, xx)) * 3 + c]!;
  return { d: even, w: ew, h: eh };
}

export interface ScanResult {
  version: number;
  engine: Record<string, string>;
  source: Record<string, unknown>;
  settings: Record<string, unknown>;
  stats: Record<string, unknown>;
  detections: Detection[];
}

export async function scan(ffmpeg: string, video: string, events: string | null, thumbsDir: string | null, progress?: Progress, settings: Partial<ScanSettings> = {}): Promise<ScanResult> {
  const s: ScanSettings = { ...DEFAULT_SETTINGS, ...settings };
  const t0 = Date.now();
  const info = await probe(ffmpeg, video);
  const fps = info.fps;
  const scroll = scrollFramesFromEvents(events, fps);
  const tmp = tmpDir("lens-redact-");
  const pool = new OcrPool();
  try {
    const an = await analyse(ffmpeg, video, info, s, scroll, tmp, progress);
    const t1 = Date.now();
    progress?.("ocr", 0, an.samples.length);
    const imgs = an.samples.map((f) => ({ w: an.width, h: an.height, d: new Uint8Array(fs.readFileSync(path.join(tmp, `${f}.gray`))) }));
    const words: OcrWord[][] = await pool.ocrAll(imgs, 1, (n) => progress?.("ocr", n, an.samples.length));
    const hits = new Map<number, FrameHit[]>();
    an.samples.forEach((f, k) => {
      const hs = hitsFromWords(words[k]!).filter((h) => s.types.includes(h.type));
      if (hs.length) hits.set(f, hs);
    });
    if (s.types.includes("notification")) {
      for (const [f, box] of an.notifications) hits.set(f, [...(hits.get(f) ?? []), { type: "notification", box, text: "", confidence: 0.8 }]);
    }
    const t2 = Date.now();
    if (thumbsDir) fs.mkdirSync(thumbsDir, { recursive: true });
    const pendingThumbs: Array<Promise<void>> = [];
    const thumb = (f: number, box: Box, tid: number): string | null => {
      if (!thumbsDir) return null;
      const src = path.join(tmp, `${f}.rgb`);
      if (!fs.existsSync(src)) return null;
      const c = cropRgbScaled(new Uint8Array(fs.readFileSync(src)), an.width, box, an.height);
      const name = `t${tid}.jpg`;
      pendingThumbs.push(writeJpeg(ffmpeg, c.d, c.w, c.h, path.join(thumbsDir, name)));
      return name;
    };
    let tracks = await track(ffmpeg, video, an, hits, s, scroll, thumb, progress);
    tracks = mergeTracks(tracks, an);
    await Promise.all(pendingThumbs);
    const dets = detectionsFromTracks(tracks, fps, an.width, an.height, s);
    if (thumbsDir) {
      for (const d of dets) {
        if (d.thumb && fs.existsSync(path.join(thumbsDir, d.thumb))) {
          fs.renameSync(path.join(thumbsDir, d.thumb), path.join(thumbsDir, `${d.id}.jpg`));
          d.thumb = `${d.id}.jpg`;
        }
      }
      for (const f of fs.readdirSync(thumbsDir)) if (/^t\d+\.jpg$/.test(f)) fs.rmSync(path.join(thumbsDir, f));
    }
    const t3 = Date.now();
    const durMs = (an.n * 1000) / fps;
    const reasons: Record<string, number> = {};
    for (const v of an.sampleReason.values()) reasons[v] = (reasons[v] ?? 0) + 1;
    return {
      version: VERSION,
      engine: { name: "lens-redact (in-app)", ocr: "tesseract.js (psm 11, eng LSTM)", licence: "Apache-2.0 (tesseract, tesseract.js)" },
      source: { path: path.basename(video), width: an.width, height: an.height, fps, frames: an.n, durationMs: r2(durMs) },
      settings: { intervalMs: s.intervalMs, notifications: s.notifications, padPx: s.padPx },
      stats: {
        samples: an.samples.length, sampleReasons: reasons, tracks: tracks.length,
        seconds: { analyse: (t1 - t0) / 1000, ocr: (t2 - t1) / 1000, track: (t3 - t2) / 1000, total: (t3 - t0) / 1000 },
        secondsPerMinute: r2((t3 - t0) / 1000 / Math.max(1e-9, durMs / 60000)),
      },
      detections: dets,
    };
  } finally {
    await pool.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
