/**
 * Sharper text in zooms (demand #22), through the editor UI, in the preview and in the exported MP4
 * (decoded frames measured).
 *
 * Sample: scripts/make_sharpen_sample.py (grey screen, a panel of 11 px UI text, a black and a white
 * bar), one fixed 2.5x zoom on (640, 360) from 0.6 to 3.6 s, 720p30 output.
 *
 * Bounds (set before the first run):
 *  - UI: Zoom tab has "Sharpen text in zooms" off for this project (no setting); turning it on stores
 *    zoom.sharpen {enabled: true, amount: 0.6} and enables the Amount slider;
 *  - zoomed frame (source 2.0 s, scale 2.5), browser export: Laplacian variance of luma inside the text
 *    panel (2 px in from its edges) >= 1.25 x the same export with sharpening off (>= 25 % sharper);
 *  - ringing: on the flat grey 4..12 output px left / right of each bar's vertical edges (rows in the
 *    middle 80 % of the bar), max |luma - grey| where grey = median luma of the gap between the bars:
 *    <= 10 levels on, and <= off's value + 3;
 *  - preview vs export mean |RGB| <= 12 on the zoomed frame with sharpening on;
 *  - unzoomed frame (output frame 3, scale <= 1.5): sharpening on vs off within mean |RGB| 0.5;
 *  - off (project without the setting): plan has no zoomSharpen; with LENS_MAIN_URL (an editor built
 *    from main 7d1a5db, same export path) its plan JSON is identical to main's and every 5th exported
 *    frame is within mean |RGB| 0.5 of main's export.
 * Run with LENS_EXPORT=browser for the desktop app's export path (the editor's renderer in a worker).
 */
import { test, type Page } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { EDITOR, expect, waitDrawn } from "./helpers";
import { closeAll, openLens } from "./lensApp";
import { exportMp4, proj } from "./uxHelpers";

test.afterAll(() => closeAll());

const SAMPLE = path.join(EDITOR, "sample-sharpen");
const SHARPER_MIN = 1.25;
const RING_ABS_MAX = 10;
const RING_OVER_OFF_MAX = 3;
const PREVIEW_EXPORT_MAX = 12;
const UNZOOMED_MAX = 0.5;
const MAIN_IDENTITY_MAX = 0.5;

function bundle(name: string): string {
  if (!fs.existsSync(path.join(SAMPLE, "screen.mp4"))) execFileSync("python3", [path.join(EDITOR, "scripts", "make_sharpen_sample.py"), SAMPLE]);
  const root = process.env.LENS_E2E_TMP ?? path.resolve(EDITOR, "..", "..", "..", "editor-ux-runs");
  const dir = path.join(root, `${name}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ["screen.mp4", "meta.json", "project.json", "events.jsonl"]) fs.copyFileSync(path.join(SAMPLE, f), path.join(dir, f));
  return dir;
}
/** Copy an export out of the bundle's .lens-export (later exports / closing the editor may clean it up). */
function keep(file: string, dir: string, name: string): string {
  const out = path.join(dir, `${name}.mp4`);
  fs.copyFileSync(file, out);
  return out;
}
/** Decoded video frame count (ffprobe counts packets; first integer of its output). */
function frameCount(file: string): number {
  const r = spawnSync("ffprobe", ["-v", "error", "-count_packets", "-select_streams", "v:0", "-show_entries", "stream=nb_read_packets", "-of", "default=nw=1:nk=1", file], { encoding: "utf8" });
  const m = /\d+/.exec(r.stdout);
  const n = m ? Number(m[0]) : NaN;
  if (!Number.isFinite(n) || n <= 0) throw new Error(`could not count frames of ${file}: stdout ${JSON.stringify(r.stdout)} stderr ${r.stderr}`);
  return n;
}
const truth = () => JSON.parse(fs.readFileSync(path.join(SAMPLE, "truth.json"), "utf8")) as { textBox: number[]; bars: number[][] };

type Img = { w: number; h: number; rgb: Buffer };

function exportFrame(file: string, n: number): Img {
  const [w, h] = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { encoding: "utf8" })
    .stdout.trim().split(",").map(Number) as [number, number];
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `select=eq(n\\,${n})`, "-vsync", "0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || r.stdout.length < w * h * 3) throw new Error(`could not decode frame ${n} of ${file}: ${r.stderr}`);
  return { w, h, rgb: r.stdout.subarray(0, w * h * 3) };
}

async function previewAt(page: Page, n: number): Promise<Img> {
  await page.evaluate((f) => (window as any).__lens.store.seek(f), n);
  await waitDrawn(page);
  await page.waitForTimeout(150);
  await waitDrawn(page);
  const r = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="preview"]') as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    const rgb = new Uint8Array((d.length / 4) * 3);
    for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { rgb[j] = d[i]!; rgb[j + 1] = d[i + 1]!; rgb[j + 2] = d[i + 2]!; }
    let s = "";
    for (let i = 0; i < rgb.length; i += 0x8000) s += String.fromCharCode(...rgb.subarray(i, i + 0x8000));
    return { w: c.width, h: c.height, b64: btoa(s) };
  });
  return { w: r.w, h: r.h, rgb: Buffer.from(r.b64, "base64") };
}

const meanDiff = (a: Img, b: Img) => {
  expect([a.w, a.h]).toEqual([b.w, b.h]);
  let s = 0;
  for (let i = 0; i < a.rgb.length; i++) s += Math.abs(a.rgb[i]! - b.rgb[i]!);
  return s / a.rgb.length;
};
const luma = (f: Img, x: number, y: number) => { const i = (y * f.w + x) * 3; return 0.299 * f.rgb[i]! + 0.587 * f.rgb[i + 1]! + 0.114 * f.rgb[i + 2]!; };

function lapVar(f: Img, x0: number, y0: number, x1: number, y1: number): number {
  let n = 0, s = 0, s2 = 0;
  for (let y = Math.ceil(y0); y < Math.floor(y1); y++)
    for (let x = Math.ceil(x0); x < Math.floor(x1); x++) {
      const v = 4 * luma(f, x, y) - luma(f, x - 1, y) - luma(f, x + 1, y) - luma(f, x, y - 1) - luma(f, x, y + 1);
      n++; s += v; s2 += v * v;
    }
  const m = s / n;
  return s2 / n - m * m;
}
function gradEnergy(f: Img, x0: number, y0: number, x1: number, y1: number): number {
  let n = 0, s = 0;
  for (let y = Math.ceil(y0); y < Math.floor(y1); y++)
    for (let x = Math.ceil(x0); x < Math.floor(x1); x++) {
      const gx = luma(f, x + 1, y) - luma(f, x - 1, y), gy = luma(f, x, y + 1) - luma(f, x, y - 1);
      n++; s += gx * gx + gy * gy;
    }
  return s / n;
}

/** Source px -> output px on output frame n (screen layout through the camera). */
async function mapper(page: Page, n: number): Promise<(x: number, y: number) => [number, number]> {
  const g = await page.evaluate((i) => {
    const plan = (window as any).__lens.store.get().plan, f = plan.frames[i];
    return { crop: plan.source.crop, cam: f.cam, screen: f.layout.screen };
  }, n);
  const [cropX, cropY, srcW, srcH] = g.crop;
  const [cx, cy, sc] = g.cam;
  const [lx, ly, lw, lh] = g.screen;
  const vw = srcW / sc, vh = srcH / sc;
  return (x, y) => [lx + (x - cropX - (cx - vw / 2)) * (lw / vw), ly + (y - cropY - (cy - vh / 2)) * (lh / vh)];
}

function ringing(f: Img, map: (x: number, y: number) => [number, number], bars: number[][]): number {
  // flat grey: the gap between the bars
  const [gx0, gy0] = map(bars[0]![2]! + 10, bars[0]![1]! + 20);
  const [gx1, gy1] = map(bars[1]![0]! - 10, bars[0]![3]! - 20);
  const g: number[] = [];
  for (let y = Math.round(gy0); y < Math.round(gy1); y += 2) for (let x = Math.round(gx0); x < Math.round(gx1); x += 2) g.push(luma(f, x, y));
  g.sort((a, b) => a - b);
  const grey = g[g.length >> 1]!;
  let worst = 0;
  for (const [x0, y0, x1, y1] of bars) {
    const [ox0, oy0] = map(x0!, y0!);
    const [ox1, oy1] = map(x1!, y1!);
    const hgt = oy1 - oy0;
    for (let y = Math.round(oy0 + 0.1 * hgt); y < Math.round(oy1 - 0.1 * hgt); y++)
      for (let d = 4; d <= 12; d++) {
        worst = Math.max(worst, Math.abs(luma(f, Math.round(ox0) - d, y) - grey), Math.abs(luma(f, Math.round(ox1) + d - 1, y) - grey));
      }
  }
  return worst;
}

test("zoom sharpening: UI toggle, sharper zoomed text without ringing, preview = export, off identical to main", async () => {
  test.setTimeout(900_000);
  const dir = bundle("sharpen");
  const T = truth();
  const lens = await openLens(dir, { w: 1600, h: 1000 });
  const page = lens.page;
  const zoomN = 60; // source 2.0 s (no cuts: output = source)
  const flatN = 3;
  const s = await page.evaluate(([a, b]: number[]) => { const fr = (window as any).__lens.store.get().plan.frames; return { zoomed: fr[a!].cam[2], flat: fr[b!].cam[2], n: fr.length, style: (window as any).__lens.store.get().plan.style }; }, [zoomN, flatN]);
  console.log("cam scale zoomed", s.zoomed, "flat", s.flat, "frames", s.n);
  expect(s.zoomed).toBeGreaterThan(2.4);
  expect(s.flat).toBeLessThanOrEqual(1.5);
  expect("zoomSharpen" in s.style).toBe(false);
  const planOff = await page.evaluate(() => JSON.stringify((window as any).__lens.store.get().plan));

  // ---- export with sharpening off (the project as loaded)
  const offFile = keep(await exportMp4(page, dir, 600_000), dir, "export-off");
  await page.evaluate(() => (window as any).__lens.store.closeExport());

  // ---- UI: turn it on
  await page.getByTestId("tab-zoom").click();
  const tg = page.getByTestId("zoom-sharpen");
  await tg.scrollIntoViewIfNeeded();
  await expect(tg).toHaveAttribute("aria-checked", "false");
  await tg.click();
  let p = await proj(page);
  expect(p.zoom.sharpen).toEqual({ enabled: true, amount: 0.6 });
  await expect(tg).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("zoom-sharpen-amount")).toBeVisible();
  fs.mkdirSync(path.join(EDITOR, "test-results", "screens"), { recursive: true });
  await page.screenshot({ path: path.join(EDITOR, "test-results", "screens", "zoom-sharpen-inspector.png") });
  const unavailable = await page.locator(".note.warn", { hasText: "WebGL2" }).count();
  expect(unavailable).toBe(0);

  const prevOn = await previewAt(page, zoomN);
  const onFile = keep(await exportMp4(page, dir, 600_000), dir, "export-on");
  const map = await mapper(page, zoomN);

  const on = exportFrame(onFile, zoomN), off = exportFrame(offFile, zoomN);
  const [tx0, ty0] = map(T.textBox[0]!, T.textBox[1]!);
  const [tx1, ty1] = map(T.textBox[2]!, T.textBox[3]!);
  const lvOn = lapVar(on, tx0 + 2, ty0 + 2, tx1 - 2, ty1 - 2), lvOff = lapVar(off, tx0 + 2, ty0 + 2, tx1 - 2, ty1 - 2);
  const geOn = gradEnergy(on, tx0 + 2, ty0 + 2, tx1 - 2, ty1 - 2), geOff = gradEnergy(off, tx0 + 2, ty0 + 2, tx1 - 2, ty1 - 2);
  const rOn = ringing(on, map, T.bars), rOff = ringing(off, map, T.bars);
  const pe = meanDiff(prevOn, on);
  const flatDiff = meanDiff(exportFrame(onFile, flatN), exportFrame(offFile, flatN));
  console.log(`text box out px ${tx0.toFixed(1)},${ty0.toFixed(1)}..${tx1.toFixed(1)},${ty1.toFixed(1)}`);
  console.log(`laplacian variance on ${lvOn.toFixed(1)} off ${lvOff.toFixed(1)} ratio ${(lvOn / lvOff).toFixed(3)}; gradient energy on ${geOn.toFixed(1)} off ${geOff.toFixed(1)} ratio ${(geOn / geOff).toFixed(3)}`);
  console.log(`ringing on ${rOn.toFixed(2)} off ${rOff.toFixed(2)}; preview vs export ${pe.toFixed(2)}; unzoomed frame on vs off ${flatDiff.toFixed(3)}`);
  for (const [name, f] of [["zoom-sharpen-on", on], ["zoom-sharpen-off", off]] as const) {
    const [x0, y0] = map(T.textBox[0]! - 10, T.textBox[1]! - 10);
    const [x1, y1] = map(T.bars[1]![2]! + 20, T.textBox[3]! + 10);
    spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${f.w}x${f.h}`, "-i", "pipe:0", "-frames:v", "1",
      "-vf", `crop=${Math.round(x1 - x0)}:${Math.round(y1 - y0)}:${Math.round(x0)}:${Math.round(y0)}`, path.join(EDITOR, "test-results", "screens", `${name}.png`)], { input: f.rgb });
  }
  expect(lvOn / lvOff).toBeGreaterThanOrEqual(SHARPER_MIN);
  expect(rOn).toBeLessThanOrEqual(RING_ABS_MAX);
  expect(rOn).toBeLessThanOrEqual(rOff + RING_OVER_OFF_MAX);
  expect(pe).toBeLessThanOrEqual(PREVIEW_EXPORT_MAX);
  expect(flatDiff).toBeLessThanOrEqual(UNZOOMED_MAX);
  await lens.close();

  const MAIN = process.env.LENS_MAIN_URL;
  if (!MAIN) {
    console.log("LENS_MAIN_URL not set: identity against main skipped");
    return;
  }
  const dir2 = bundle("sharpen-main");
  const prev = process.env.LENS_E2E_BASE;
  process.env.LENS_E2E_BASE = MAIN;
  const m = await openLens(dir2, { w: 1600, h: 1000 });
  if (prev === undefined) delete process.env.LENS_E2E_BASE;
  else process.env.LENS_E2E_BASE = prev;
  const mainPlan = await m.page.evaluate(() => JSON.stringify((window as any).__lens.store.get().plan));
  expect(mainPlan === planOff, "plan identical to main's").toBe(true);
  const mainFile = keep(await exportMp4(m.page, dir2, 600_000), dir2, "export-main");
  const frames = frameCount(offFile);
  expect(frameCount(mainFile), "main export has the same frame count").toBe(frames);
  expect(frames).toBe(s.n);
  let worst = 0, compared = 0;
  for (let n = 0; n < frames; n += 5) {
    worst = Math.max(worst, meanDiff(exportFrame(offFile, n), exportFrame(mainFile, n)));
    compared++;
  }
  console.log(`off export vs main export: ${frames} frames, ${compared} compared (every 5th), worst mean |RGB| ${worst.toFixed(3)}`);
  expect(compared).toBe(Math.ceil(frames / 5));
  expect(worst).toBeLessThanOrEqual(MAIN_IDENTITY_MAX);
  await m.close();
});
