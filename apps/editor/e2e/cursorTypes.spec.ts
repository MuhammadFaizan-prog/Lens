/**
 * Cursor matches the UI's cursor type (demand #12), through the editor UI, in the preview and in the
 * exported MP4 (decoded frames measured, not just the plan).
 *
 * Sample: scripts/make_cursor_sample.py (flat grey screen; the cursor parks at a new point every second;
 * a logged cursor-shape event 250 ms into each second: arrow, hand, I-beam, resize <->, busy, resize
 * up/down, arrow). events-untyped.jsonl = the same log without types (an older recording).
 *
 * Measurement: for each second, output frame at +650 ms (parked, any swap long finished); a crop of
 * 2 x cursor size centred on the plan's hotspot is matched (normalized cross-correlation of luma)
 * against every Lens cursor type's art drawn alone at the same spot over the crop's own flat colour
 * (window.__lens.cursorTemplate).
 *
 * Bounds (set before the first run):
 *  - UI: Cursor tab shows "Match UI hover" on (types were logged), 7 segment rows with the logged types;
 *    setting row 5 to "Grab" in its select stores one override {5250..6250, grab} and the row says
 *    "set by you"; Theme select -> Light stores cursor.theme "light";
 *  - typed project (light theme, override), browser export: at every second the best-matching type is
 *    the expected one (row 5: grab), NCC >= 0.80, and >= 0.08 above the runner-up; preview vs export
 *    mean |RGB| <= 12 on those frames;
 *  - smooth swap: some exported frame inside the arrow -> hand change has plan swap progress 0.25..0.75,
 *    and its crop matches the linear blend of the two types (NCC >= 0.75) better than either type alone;
 *  - project without types (untyped log, no matchHover): no swap fields in the plan, arrow (classic) best
 *    at every second with NCC >= 0.80; preview vs export <= 12; with LENS_MAIN_URL (an editor built
 *    from main 7d1a5db, same export path): plan JSON identical to main's and every 5th exported frame
 *    within mean |RGB| 0.5 of main's export.
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

const SAMPLE = path.join(EDITOR, "sample-cursor");
const ALL = ["arrow", "pointer", "text", "grab", "grabbing", "crosshair", "resize-ew", "resize-ns", "resize-nwse", "resize-nesw", "move", "wait", "not-allowed"];
const EXPECTED = ["arrow", "pointer", "text", "resize-ew", "wait", "resize-ns", "arrow"];
const NCC_MIN = 0.8;
const MARGIN_MIN = 0.08;
const BLEND_MIN = 0.75;
const PREVIEW_EXPORT_MAX = 12;
const MAIN_IDENTITY_MAX = 0.5;

function bundle(name: string, typed: boolean): string {
  if (!fs.existsSync(path.join(SAMPLE, "screen.mp4"))) execFileSync("python3", [path.join(EDITOR, "scripts", "make_cursor_sample.py"), SAMPLE]);
  const root = process.env.LENS_E2E_TMP ?? path.resolve(EDITOR, "..", "..", "..", "editor-ux-runs");
  const dir = path.join(root, `${name}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ["screen.mp4", "meta.json", "project.json"]) fs.copyFileSync(path.join(SAMPLE, f), path.join(dir, f));
  fs.copyFileSync(path.join(SAMPLE, typed ? "events.jsonl" : "events-untyped.jsonl"), path.join(dir, "events.jsonl"));
  return dir;
}

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
  await page.waitForTimeout(120);
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

function crop(f: Img, x0: number, y0: number, w: number, h: number): Float64Array {
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (Math.min(f.h - 1, Math.max(0, y0 + y)) * f.w + Math.min(f.w - 1, Math.max(0, x0 + x))) * 3;
      out[y * w + x] = 0.299 * f.rgb[i]! + 0.587 * f.rgb[i + 1]! + 0.114 * f.rgb[i + 2]!;
    }
  return out;
}

function ncc(a: Float64Array, b: Float64Array): number {
  let ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { ma += a[i]!; mb += b[i]!; }
  ma /= a.length; mb /= b.length;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i]! - ma, y = b[i]! - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return sab / Math.sqrt(Math.max(1e-9, saa * sbb));
}

/** Flat colour of the crop: median RGB of its border pixels. */
function borderColour(f: Img, x0: number, y0: number, w: number, h: number): [number, number, number] {
  const px: number[][] = [];
  for (let x = 0; x < w; x++) for (const y of [0, h - 1]) { const i = ((y0 + y) * f.w + x0 + x) * 3; px.push([f.rgb[i]!, f.rgb[i + 1]!, f.rgb[i + 2]!]); }
  for (let y = 0; y < h; y++) for (const x of [0, w - 1]) { const i = ((y0 + y) * f.w + x0 + x) * 3; px.push([f.rgb[i]!, f.rgb[i + 1]!, f.rgb[i + 2]!]); }
  return [0, 1, 2].map((c) => px.map((p) => p[c]!).sort((a, b) => a - b)[px.length >> 1]!) as [number, number, number];
}

async function template(page: Page, n: number, shape: string, bg: [number, number, number]) {
  const t = await page.evaluate(([f, s, b]) => (window as any).__lens.cursorTemplate(f, s, b), [n, shape, bg] as [number, string, [number, number, number]]);
  if (!t) throw new Error(`no cursor on frame ${n}`);
  const rgb = Buffer.from(t.b64, "base64");
  return { ...t, img: { w: t.w, h: t.h, rgb } as Img };
}

/** Match the export's cursor crop on frame n against every type. */
async function classify(page: Page, file: string, n: number): Promise<{ best: string; score: number; second: number; scores: Record<string, number> }> {
  const f = exportFrame(file, n);
  const probe = await template(page, n, "arrow", [0, 0, 0]);
  const bg = borderColour(f, probe.x0, probe.y0, probe.w, probe.h);
  const got = crop(f, probe.x0, probe.y0, probe.w, probe.h);
  const scores: Record<string, number> = {};
  for (const s of ALL) {
    const t = await template(page, n, s, bg);
    scores[s] = ncc(got, crop(t.img, 0, 0, t.w, t.h));
  }
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  return { best: sorted[0]![0], score: sorted[0]![1], second: sorted[1]![1], scores };
}

const midFrame = (i: number, fps: number) => Math.round(((i * 1000 + 650) / 1000) * fps);

async function smallChecks(page: Page): Promise<void> {
  // the plan is 540p30, 7 s
  const s = await page.evaluate(() => ({ fps: (window as any).__lens.store.get().plan.output.fps, n: (window as any).__lens.store.get().plan.frames.length }));
  expect(s.fps).toBe(30);
  expect(s.n).toBe(210);
}

test("cursor types: logged types, per-segment override, light theme, smooth swap; preview and export", async () => {
  test.setTimeout(900_000);
  const dir = bundle("cursor-typed", true);
  const lens = await openLens(dir, { w: 1600, h: 1000 });
  const page = lens.page;
  await smallChecks(page);

  // ---- UI
  await page.getByTestId("tab-cursor").click();
  await expect(page.getByTestId("cursor-match-hover")).toHaveAttribute("aria-checked", "true");
  const rows = page.locator('[data-testid^="cursor-run-"][data-shape]');
  await expect(rows).toHaveCount(7);
  const shapes = await rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.shape));
  expect(shapes).toEqual(EXPECTED);
  await page.getByTestId("cursor-run-shape-5").selectOption("grab");
  let p = await proj(page);
  expect(p.overrides).toEqual([{ startMs: 5250, endMs: 6250, cursor: { shape: "grab" } }]);
  await expect(page.getByTestId("cursor-run-5")).toHaveAttribute("data-source", "override");
  await expect(page.getByTestId("cursor-run-5")).toContainText("set by you");
  await page.getByTestId("cursor-theme").selectOption("light");
  p = await proj(page);
  expect(p.cursor.theme).toBe("light");
  fs.mkdirSync(path.join(EDITOR, "test-results", "screens"), { recursive: true });
  await page.screenshot({ path: path.join(EDITOR, "test-results", "screens", "cursor-types-inspector.png") });

  const want = EXPECTED.map((s, i) => (i === 5 ? "grab" : s));
  const fps = 30;

  // ---- swap frame (plan): inside arrow -> hand, progress 0.25..0.75
  const swapN = await page.evaluate(() => {
    const fr = (window as any).__lens.store.get().plan.frames as Array<{ src: number; cur: unknown[] | null }>;
    let best = -1, d = 9;
    fr.forEach((f, i) => { if (f.cur && f.cur.length === 7 && f.cur[5] === "arrow" && f.cur[4] === "pointer") { const m = Math.abs((f.cur[6] as number) - 0.5); if (m < d) { d = m; best = i; } } });
    return best >= 0 ? { n: best, mix: (fr[best]!.cur![6] as number) } : null;
  });
  console.log("swap frame", JSON.stringify(swapN));
  expect(swapN).not.toBeNull();
  expect(swapN!.mix).toBeGreaterThanOrEqual(0.25);
  expect(swapN!.mix).toBeLessThanOrEqual(0.75);

  // previews before export (same revision)
  const previews: Img[] = [];
  for (let i = 0; i < 7; i++) previews.push(await previewAt(page, midFrame(i, fps)));

  // ---- export (browser path)
  const file = await exportMp4(page, dir, 600_000);
  for (let i = 0; i < 7; i++) {
    const n = midFrame(i, fps);
    const c = await classify(page, file, n);
    const top3 = Object.entries(c.scores).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(", ");
    const pe = meanDiff(previews[i]!, exportFrame(file, n));
    console.log(`typed second ${i} frame ${n}: want ${want[i]} best ${c.best} ncc ${c.score.toFixed(3)} margin ${(c.score - c.second).toFixed(3)} [${top3}] preview-vs-export ${pe.toFixed(2)}`);
    expect(c.best, `second ${i}`).toBe(want[i]);
    expect(c.score).toBeGreaterThanOrEqual(NCC_MIN);
    expect(c.score - c.second).toBeGreaterThanOrEqual(MARGIN_MIN);
    expect(pe).toBeLessThanOrEqual(PREVIEW_EXPORT_MAX);
  }
  // swap: a crossfade, not a hard cut
  {
    const n = swapN!.n;
    const f = exportFrame(file, n);
    const ta = await template(page, n, "arrow", [0, 0, 0]);
    const bg = borderColour(f, ta.x0, ta.y0, ta.w, ta.h);
    const A = await template(page, n, "arrow", bg);
    const B = await template(page, n, "pointer", bg);
    const got = crop(f, A.x0, A.y0, A.w, A.h);
    const a = crop(A.img, 0, 0, A.w, A.h);
    const b = crop(B.img, 0, 0, B.w, B.h);
    const m = swapN!.mix;
    const blend = a.map((v, i) => v * (1 - m) + b[i]! * m);
    const sa = ncc(got, a), sb = ncc(got, b), sm = ncc(got, blend);
    console.log(`swap frame ${n} mix ${m.toFixed(3)}: ncc arrow ${sa.toFixed(3)} hand ${sb.toFixed(3)} blend ${sm.toFixed(3)}`);
    expect(sm).toBeGreaterThanOrEqual(BLEND_MIN);
    expect(sm).toBeGreaterThan(sa);
    expect(sm).toBeGreaterThan(sb);
  }
  // ---- "At playhead": from the playhead to the end of its segment, one undo step
  await page.evaluate(() => (window as any).__lens.store.seekSource(2500));
  await waitDrawn(page);
  await page.getByTestId("cursor-type-at-playhead").selectOption("crosshair");
  p = await proj(page);
  const ch = p.overrides.find((o: any) => o.cursor?.shape === "crosshair");
  console.log("at-playhead override", JSON.stringify(ch));
  expect(ch).toBeTruthy();
  expect(Math.abs(ch.startMs - 2500)).toBeLessThanOrEqual(40);
  expect(ch.endMs).toBe(3250);
  await page.evaluate(() => (window as any).__lens.store.undo());
  p = await proj(page);
  expect(p.overrides).toEqual([{ startMs: 5250, endMs: 6250, cursor: { shape: "grab" } }]);
  await lens.close();
});

test("cursor types: a project without types renders as before (arrow, plan and export identical to main)", async () => {
  test.setTimeout(900_000);
  const dir = bundle("cursor-untyped", false);
  const lens = await openLens(dir, { w: 1600, h: 1000 });
  const page = lens.page;
  await smallChecks(page);
  const long = await page.evaluate(() => ((window as any).__lens.store.get().plan.frames as Array<{ cur: unknown[] | null }>).filter((f) => f.cur && f.cur.length !== 5).length);
  expect(long).toBe(0);
  const p = await proj(page);
  expect(p.cursor.matchHover).toBeUndefined();
  const planJson = await page.evaluate(() => JSON.stringify((window as any).__lens.store.get().plan));
  const fps = 30;
  const previews: Img[] = [];
  for (let i = 0; i < 7; i++) previews.push(await previewAt(page, midFrame(i, fps)));
  const file = await exportMp4(page, dir, 600_000);
  for (let i = 0; i < 7; i++) {
    const n = midFrame(i, fps);
    const c = await classify(page, file, n);
    const pe = meanDiff(previews[i]!, exportFrame(file, n));
    console.log(`untyped second ${i} frame ${n}: best ${c.best} ncc ${c.score.toFixed(3)} margin ${(c.score - c.second).toFixed(3)} preview-vs-export ${pe.toFixed(2)}`);
    expect(c.best).toBe("arrow");
    expect(c.score).toBeGreaterThanOrEqual(NCC_MIN);
    expect(pe).toBeLessThanOrEqual(PREVIEW_EXPORT_MAX);
  }
  await lens.close();

  const MAIN = process.env.LENS_MAIN_URL;
  if (!MAIN) {
    console.log("LENS_MAIN_URL not set: identity against main skipped");
    return;
  }
  // the same bundle (fresh copy) in an editor built from main 7d1a5db
  const dir2 = bundle("cursor-untyped-main", false);
  const prev = process.env.LENS_E2E_BASE;
  process.env.LENS_E2E_BASE = MAIN;
  const m = await openLens(dir2, { w: 1600, h: 1000 });
  if (prev === undefined) delete process.env.LENS_E2E_BASE;
  else process.env.LENS_E2E_BASE = prev;
  const mainPlan = await m.page.evaluate(() => JSON.stringify((window as any).__lens.store.get().plan));
  expect(mainPlan === planJson, "plan identical to main's").toBe(true);
  const mainFile = await exportMp4(m.page, dir2, 600_000);
  let worst = 0;
  for (let n = 0; n < 210; n += 5) worst = Math.max(worst, meanDiff(exportFrame(file, n), exportFrame(mainFile, n)));
  console.log(`untyped export vs main export: worst mean |RGB| over every 5th frame ${worst.toFixed(3)}`);
  expect(worst).toBeLessThanOrEqual(MAIN_IDENTITY_MAX);
  await m.close();
});
