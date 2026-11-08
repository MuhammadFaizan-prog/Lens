import { expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EDITOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SHOTS = path.join(EDITOR, "test-results", "screens");

export interface LensState {
  status: string;
  frame: number;
  frames: number;
  fps: number;
  src: number;
  playing: boolean;
  revision: number;
  cuts: Array<{ startMs: number; endMs: number }>;
  planCuts: Array<{ startMs: number; endMs: number }>;
  zooms: Array<{ startMs: number; endMs: number; scale: number; auto: boolean }>;
  caption: { words: string[]; active: number } | null;
  canUndo: boolean;
  canRedo: boolean;
  project: Record<string, any>;
}

export async function state(page: Page): Promise<LensState> {
  return page.evaluate(() => (window as any).__lens.state());
}

/** Decoded-frame LRU size in tests (24 in the app): 8 x 1280x720 bitmaps per track keeps Chromium small. */
export const TEST_MAX_BITMAPS = 8;

export async function openEditor(page: Page): Promise<void> {
  await page.addInitScript((n) => ((window as any).__lensMaxBitmaps = n), TEST_MAX_BITMAPS);
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__lens?.state().status === "ready", null, { timeout: 90_000 });
  await waitDrawn(page);
}

/** Wait until the preview canvas shows the store's current frame and revision. */
export async function waitDrawn(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const s = (window as any).__lens.state();
    const c = document.querySelector('[data-testid="preview"]') as HTMLCanvasElement | null;
    return !!c && c.dataset.frame === String(s.frame) && c.dataset.revision === String(s.revision);
  }, null, { timeout: 30_000 });
}

export async function seek(page: Page, frame: number): Promise<void> {
  await page.evaluate((f) => (window as any).__lens.store.seek(f), frame);
  await waitDrawn(page);
}

/** RGB of the preview canvas on an 8 px grid (keeps the test process small), for comparing renders. */
export async function canvasPixels(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid="preview"]') as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    const out: number[] = [];
    for (let y = 0; y < c.height; y += 8)
      for (let x = 0; x < c.width; x += 8) {
        const i = (y * c.width + x) * 4;
        out.push(d[i]!, d[i + 1]!, d[i + 2]!);
      }
    return out;
  });
}

export function meanAbsDiff(a: number[], b: number[]): number {
  if (a.length !== b.length) return Infinity;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
  return s / a.length;
}

export async function shot(page: Page, name: string): Promise<string> {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

export async function settle(page: Page): Promise<void> {
  // let slider gesture debounce (400 ms) commit and the preview redraw
  await page.waitForTimeout(500);
  await waitDrawn(page);
}

export { expect };
