/** Shared pieces of the editor UX specs (Windows bugs #2-#20): a fresh copy of sample-ux per test. */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { EDITOR } from "./helpers";

export const UX_SAMPLE = path.join(EDITOR, "sample-ux");

/** A throwaway copy of the UX sample (tests save / export into it). Optional project patch. */
export function uxBundle(name: string, patch: Record<string, unknown> = {}): string {
  if (!fs.existsSync(path.join(UX_SAMPLE, "screen.mp4"))) execFileSync("python3", [path.join(EDITOR, "scripts", "make_ux_sample.py"), UX_SAMPLE]);
  const root = process.env.LENS_E2E_TMP ?? path.resolve(EDITOR, "..", "..", "..", "editor-ux-runs");
  const dir = path.join(root, `${name}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ["screen.mp4", "meta.json", "events.jsonl", "project.json"]) fs.copyFileSync(path.join(UX_SAMPLE, f), path.join(dir, f));
  if (Object.keys(patch).length) {
    const p = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
    fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify(deepMerge(p, patch), null, 1));
  }
  return dir;
}

function deepMerge(a: any, b: any): any {
  if (typeof a !== "object" || typeof b !== "object" || !a || !b || Array.isArray(b)) return b;
  const o = { ...a };
  for (const [k, v] of Object.entries(b)) o[k] = k in o ? deepMerge(o[k], v) : v;
  return o;
}

export const urlFor = (dir: string) => `/?dir=${encodeURIComponent(dir)}`;

/** Export through the UI (Export MP4) and return the MP4 path once done. */
export async function exportMp4(page: Page, dir: string, timeoutMs = 240_000): Promise<string> {
  await page.getByTestId("export").click();
  const warn = page.getByTestId("export-warning-anyway");
  if (await warn.isVisible().catch(() => false)) await warn.click();
  await page.waitForFunction(() => {
    const e = (window as any).__lens.store.get().exporting;
    return e && (e.state === "done" || e.state === "error");
  }, null, { timeout: timeoutMs, polling: 500 });
  const ex = await page.evaluate(() => (window as any).__lens.store.get().exporting);
  if (ex.state !== "done") throw new Error(`export failed: ${ex.error}`);
  const file = path.join(dir, ".lens-export", ex.id, "export.mp4");
  if (fs.existsSync(file)) return file;
  // fall back to downloading it from the server
  const buf = await page.evaluate(async (u) => Array.from(new Uint8Array(await (await fetch(u)).arrayBuffer())), `/api/export/${ex.id}/file?dir=${encodeURIComponent(dir)}`);
  const out = path.join(os.tmpdir(), `lens-ux-${ex.id}.mp4`);
  fs.writeFileSync(out, Buffer.from(buf));
  return out;
}

/** One frame of a video at time t (s) as RGB, at its own size. */
export function frameAt(file: string, t: number): { w: number; h: number; rgb: Buffer } {
  const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { encoding: "utf8" });
  const [w, h] = probe.stdout.trim().split(",").map(Number) as [number, number];
  const r = spawnSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || r.stdout.length < w * h * 3) throw new Error(`could not decode ${file} at ${t}s: ${r.stderr}`);
  return { w, h, rgb: r.stdout.subarray(0, w * h * 3) };
}

/** Std-dev of luma in a box (a sharp 8 px checkerboard is ~127, a blurred one is near 0). */
export function lumaStd(f: { w: number; rgb: Buffer }, x0: number, y0: number, x1: number, y1: number): number {
  let n = 0, s = 0, s2 = 0;
  for (let y = Math.round(y0); y < Math.round(y1); y++)
    for (let x = Math.round(x0); x < Math.round(x1); x++) {
      const i = (y * f.w + x) * 3;
      const l = 0.299 * f.rgb[i]! + 0.587 * f.rgb[i + 1]! + 0.114 * f.rgb[i + 2]!;
      n++; s += l; s2 += l * l;
    }
  const m = s / n;
  return Math.sqrt(Math.max(0, s2 / n - m * m));
}

/** Centroid of strongly red pixels (the sample's marker dots) inside a box. */
export function redCentroid(f: { w: number; h: number; rgb: Buffer }, x0 = 0, y0 = 0, x1 = f.w, y1 = f.h): { x: number; y: number; n: number } | null {
  let n = 0, sx = 0, sy = 0;
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(f.h, y1); y++)
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(f.w, x1); x++) {
      const i = (y * f.w + x) * 3;
      const r = f.rgb[i]!, g = f.rgb[i + 1]!, b = f.rgb[i + 2]!;
      const wgt = r > 150 && g < 90 && b < 90 ? r - Math.max(g, b) : 0;
      if (wgt > 0) { n += wgt; sx += x * wgt; sy += y * wgt; }
    }
  return n ? { x: sx / n, y: sy / n, n } : null;
}

/** Bounding box of an element in page px. */
export async function rectOf(page: Page, testId: string) {
  return page.getByTestId(testId).boundingBox();
}

/** Apply a project edit in the page (one undo step) and wait for the preview to redraw. */
export async function editProject(page: Page, label: string, fn: string): Promise<void> {
  await page.evaluate(([l, f]) => (window as any).__lens.store.edit(l, new Function("p", `return (${f})(p)`) as any), [label, fn]);
  await page.waitForTimeout(150);
}

/** Output 360p30 and only [0, keepMs) of the source: small, fast exports on the 2-core test box. */
export async function smallExport(page: Page, keepMs: number): Promise<void> {
  await editProject(page, "Small export", `(p) => ({ ...p, output: { ...p.output, resolution: 360, fps: 30 }, edits: { ...p.edits, cuts: [...p.edits.cuts, { startMs: ${keepMs}, endMs: 6000 }] } })`);
}

export async function proj(page: Page): Promise<any> {
  return page.evaluate(() => (window as any).__lens.store.get().project);
}

/** Seek to source time ms and wait for the preview. */
export async function seekSrc(page: Page, ms: number): Promise<void> {
  await page.evaluate((t) => (window as any).__lens.store.seekSource(t), ms);
  await page.waitForFunction(() => {
    const s = (window as any).__lens.state();
    const c = document.querySelector('[data-testid="preview"]') as HTMLCanvasElement | null;
    return !!c && c.dataset.frame === String(s.frame) && c.dataset.revision === String(s.revision);
  }, null, { timeout: 30_000 });
}

/** Page point of an output-px point on the preview. */
export async function outToPage(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const b = (await page.getByTestId("preview").boundingBox())!;
  const W = await page.evaluate(() => (window as any).__lens.store.get().plan.output.width);
  const H = await page.evaluate(() => (window as any).__lens.store.get().plan.output.height);
  return { x: b.x + (x * b.width) / W, y: b.y + (y * b.height) / H };
}

/** Output-px point of a source-px point on the current frame (screen layout through the camera). */
export async function srcToOut(page: Page, sx: number, sy: number): Promise<{ x: number; y: number }> {
  return page.evaluate(([x, y]: [number, number]) => {
    const s = (window as any).__lens.store.get();
    const plan = s.plan, f = plan.frames[s.frame];
    const [cropX, cropY, srcW, srcH] = plan.source.crop;
    const [cx, cy, sc] = f.cam;
    const [lx, ly, lw, lh] = f.layout.screen;
    const vw = srcW / sc, vh = srcH / sc;
    return { x: lx + (x - cropX - (cx - vw / 2)) * (lw / vw), y: ly + (y - cropY - (cy - vh / 2)) * (lh / vh) };
  }, [sx, sy] as [number, number]);
}

/** Drag on the page with intermediate steps (pointer events). */
export async function drag(page: Page, a: { x: number; y: number }, b: { x: number; y: number }, steps = 8): Promise<void> {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps });
  await page.mouse.move(b.x, b.y, { steps });
  await page.mouse.up();
  await page.waitForTimeout(200);
}

/** Pixel at (x, y) of a decoded frame. */
export function px(f: { w: number; rgb: Buffer }, x: number, y: number): [number, number, number] {
  const i = (Math.round(y) * f.w + Math.round(x)) * 3;
  return [f.rgb[i]!, f.rgb[i + 1]!, f.rgb[i + 2]!];
}

export function hexRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbDist(a: number[], b: number[]): number {
  return Math.max(Math.abs(a[0]! - b[0]!), Math.abs(a[1]! - b[1]!), Math.abs(a[2]! - b[2]!));
}
