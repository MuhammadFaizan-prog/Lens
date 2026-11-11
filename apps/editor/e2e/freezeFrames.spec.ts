/**
 * Freeze frames, still images and title cards (demand #20), through the editor UI, in the preview and
 * in the exported MP4 (video frames and audio measured, not just the UI).
 *
 * Sample: scripts/make_freeze_sample.py (a red square moving right at 150 src px/s on flat green, a
 * cursor sweeping below it, a 1 kHz tone at source 3.0-3.5 s). Built through the Insert group and the
 * Freeze lane: brand title card at 0, hold freeze 1.0-2.5 s (cursor live), pause 1.5 s at source
 * 2.8 s, image slide 3 s at source 4.5 s; source after 5.2 s cut.
 *
 * Bounds (set before the first run):
 *  - UI: "+ Freeze" adds one Freeze-lane block at the playhead (2 s, cursor live); "+ Pause", "+ Image",
 *    "+ Title card" each add one marker of their kind; the brand title card has brand: true;
 *  - plan: output duration = 5.2 s + 2 s title + 1.5 s pause + 3 s image = 11.7 s (+-1 frame);
 *  - hold, preview AND export: the red square's centroid at source 1.3 s and 2.3 s differs by
 *    <= 1.5 output px (outside a hold it moves 150 src px/s, >= 25 output px over 1 s at 360p); the
 *    cursor still moves >= 20 output px between them (live); preview vs export mean |RGB| <= 12;
 *  - pause: two export frames inside the pause and the first frame after it (all source 2.8 s) differ
 *    by mean |RGB| <= 3;
 *    exported audio: the tone sits at output 6.5-7.0 s (source 3.0 s + 2 s title + 1.5 s pause), its
 *    RMS there is >= 40 dB above the pause's own RMS and above output 5.0-5.5 s (where it would be
 *    without the pause);
 *  - image slide: export pixels 10 % left / right of centre within 40 per channel of the picture's
 *    blue / yellow; the slide background (corner) within 12 per channel of #11131a;
 *  - title card (brand kit on, backdrop inheriting the brand): the accent bar's centre pixel within 40
 *    per channel of the brand primary in the preview; in the export (a 3 px bar through 4:2:0 chroma)
 *    max over the bar's box of G - R >= 90 (primary 163, backdrop ~33); the card's corner differs from
 *    the plain slide colour #11131a by >= 20 in some channel (theme fill); preview vs export mean
 *    |RGB| <= 12 on the card.
 * Run with LENS_EXPORT=browser for the desktop app's export path (the editor's renderer in a worker).
 */
import { test, type Page } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { EDITOR, expect, waitDrawn } from "./helpers";
import { closeAll, openLens, PACKAGED } from "./lensApp";
import { editProject, exportMp4, proj, redCentroid, seekSrc } from "./uxHelpers";

test.afterAll(() => closeAll());

const SAMPLE = path.join(EDITOR, "sample-freeze");
const PRIMARY = "#22c55e";

function freezeBundle(name: string): string {
  if (!fs.existsSync(path.join(SAMPLE, "screen.mp4"))) execFileSync("python3", [path.join(EDITOR, "scripts", "make_freeze_sample.py"), SAMPLE]);
  const root = process.env.LENS_E2E_TMP ?? path.resolve(EDITOR, "..", "..", "..", "editor-ux-runs");
  const dir = path.join(root, `${name}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ["screen.mp4", "meta.json", "events.jsonl", "project.json", "mic.wav"]) fs.copyFileSync(path.join(SAMPLE, f), path.join(dir, f));
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

async function previewRgb(page: Page): Promise<Img> {
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

/** Preview of output frame n (settled on the current revision). */
async function previewAt(page: Page, n: number): Promise<Img> {
  await page.evaluate((f) => (window as any).__lens.store.seek(f), n);
  await page.waitForFunction(() => (window as any).__lens.state().backdropsPending === 0, null, { timeout: 60_000 }).catch(() => undefined);
  await waitDrawn(page);
  await page.waitForTimeout(150);
  await waitDrawn(page);
  return previewRgb(page);
}

const meanDiff = (a: Img, b: Img) => {
  expect([a.w, a.h]).toEqual([b.w, b.h]);
  let s = 0;
  for (let i = 0; i < a.rgb.length; i++) s += Math.abs(a.rgb[i]! - b.rgb[i]!);
  return s / a.rgb.length;
};
const pix = (f: Img, x: number, y: number) => { const i = (Math.round(y) * f.w + Math.round(x)) * 3; return [f.rgb[i]!, f.rgb[i + 1]!, f.rgb[i + 2]!]; };
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const maxCh = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));

/** Centroid of the cursor: dark pixels (sum < 100) inside the screen rect, 8 px in from its corners (the scene has none). */
function darkCentroid(f: Img, r: [number, number, number, number]): { x: number; y: number; n: number } | null {
  let n = 0, sx = 0, sy = 0;
  for (let y = Math.max(0, Math.floor(r[1] + 8)); y < Math.min(f.h, r[1] + r[3] - 8); y++)
    for (let x = Math.max(0, Math.floor(r[0] + 8)); x < Math.min(f.w, r[0] + r[2] - 8); x++) {
      const i = (y * f.w + x) * 3;
      if (f.rgb[i]! + f.rgb[i + 1]! + f.rgb[i + 2]! < 100) { n++; sx += x; sy += y; }
    }
  return n >= 4 ? { x: sx / n, y: sy / n, n } : null;
}

function dump(name: string, f: Img): void {
  const out = path.join(EDITOR, "test-results", "screens", `${name}.png`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${f.w}x${f.h}`, "-i", "pipe:0", "-frames:v", "1", out], { input: f.rgb });
}

/** RMS in dBFS of the export's audio over [t0, t1) s (mono mix, 48 kHz). */
function rmsDb(pcm: Float32Array, t0: number, t1: number): number {
  const a = Math.floor(t0 * 48000), b = Math.min(pcm.length, Math.floor(t1 * 48000));
  let s = 0;
  for (let i = a; i < b; i++) s += pcm[i]! * pcm[i]!;
  return 10 * Math.log10(Math.max(1e-12, s / Math.max(1, b - a)));
}

test("freeze frame, pause, image slide and brand title card: preview and export", async () => {
  test.setTimeout(600_000);
  const dir = freezeBundle("freeze");
  fs.copyFileSync(path.join(SAMPLE, "picture.png"), path.join(dir, "..", `picture-${path.basename(dir)}.png`));
  const lens = await openLens(dir, { w: 1600, h: 1000 });
  const page = lens.page;
  const exportPath = await page.evaluate(() => (window as any).__lens.store.exportPath());
  console.log(PACKAGED ? "packaged app" : "web editor", "export path:", exportPath);
  // brand kit on (the title card follows it); source after 5.2 s cut so the export stays short
  await editProject(page, "Brand + short", `(p) => ({ ...p, brand: { ...p.brand, enabled: true, colors: { ...p.brand.colors, primary: "${PRIMARY}" } }, background: { ...p.background, inherit: true }, edits: { ...p.edits, cuts: [...p.edits.cuts, { startMs: 5200, endMs: 6000 }] } })`);

  // ---- UI: the Insert group and the Freeze lane
  await expect(page.getByTestId("insert-group")).toBeVisible();
  await expect(page.getByTestId("lane-freeze")).toBeVisible();
  await seekSrc(page, 1000);
  await page.getByTestId("insert-freeze").click();
  let p = await proj(page);
  expect(p.freezes).toHaveLength(1);
  expect(Math.abs(p.freezes[0].startMs - 1000)).toBeLessThanOrEqual(40);
  expect(p.freezes[0].endMs - p.freezes[0].startMs).toBe(2000);
  expect(p.freezes[0].cursor).toBe("live");
  await expect(page.getByTestId("block-freeze-0")).toBeVisible();
  await expect(page.getByTestId("selection-card")).toContainText("Freeze frame");
  // exact range for the measurements: 1.0-2.5 s
  await editProject(page, "Freeze range", `(p) => ({ ...p, freezes: [{ ...p.freezes[0], startMs: 1000, endMs: 2500 }] })`);

  await seekSrc(page, 2800);
  await page.getByTestId("insert-pause").click();
  await seekSrc(page, 4500);
  await page.getByTestId("image-slide-input").setInputFiles(path.join(dir, "..", `picture-${path.basename(dir)}.png`));
  await page.waitForFunction(() => (window as any).__lens.store.get().project.slides.some((s: any) => s.kind === "image"), null, { timeout: 30_000 });
  await seekSrc(page, 0);
  await page.getByTestId("add-slide").click();
  p = await proj(page);
  const kinds = p.slides.map((s: any) => s.kind ?? "text").sort();
  expect(kinds).toEqual(["freeze", "image", "text"]);
  const pause = p.slides.find((s: any) => s.kind === "freeze");
  const image = p.slides.find((s: any) => s.kind === "image");
  const card = p.slides.find((s: any) => (s.kind ?? "text") === "text");
  expect(card.brand).toBe(true);
  expect(image.image.path).toMatch(/^media\//);
  expect(fs.existsSync(path.join(dir, image.image.path))).toBe(true);
  // exact times / lengths for the measurements
  await editProject(page, "Clip times", `(p) => ({ ...p, slides: p.slides.map((s) => s.kind === "freeze" ? { ...s, atMs: 2800, durationMs: 1500 } : s.kind === "image" ? { ...s, atMs: 4500, durationMs: 3000 } : { ...s, atMs: 0, durationMs: 2000, title: "Chapter one" }) })`);
  for (const k of ["freeze", "image", "text"]) await expect(page.locator(`.slide-marker.kind-${k}`)).toHaveCount(1);

  const plan = await page.evaluate(() => (window as any).__lens.store.get().plan);
  const fps = plan.output.fps;
  console.log("plan:", plan.output, "slides:", JSON.stringify(plan.slides));
  expect(Math.abs(plan.output.durationMs - 11700)).toBeLessThanOrEqual(1000 / fps + 1);
  const frameOfSrc = (src: number) => plan.frames.findIndex((f: any) => f.src >= src - 0.5 && !f.slide && !plan.slides.some((s: any) => f.t >= s.outStart && f.t < s.outEnd));
  const fA = frameOfSrc(1300), fB = frameOfSrc(2300), f0 = frameOfSrc(300), f1 = frameOfSrc(800);
  expect(plan.frames[fA].vid).toBe(1000);
  expect(plan.frames[fB].vid).toBe(1000);
  const screen = plan.frames[fA].layout.screen as [number, number, number, number];
  const span = (id: string) => plan.slides.find((s: any) => s.id === id);
  const pSpan = span(pause.id), iSpan = span(image.id), cSpan = span(card.id);
  const fPause = [Math.ceil((pSpan.outStart / 1000) * fps) + 2, Math.floor((pSpan.outEnd / 1000) * fps) - 2];
  const fImage = Math.round(((iSpan.outStart + iSpan.outEnd) / 2000) * fps);
  const fCard = Math.round(((cSpan.outStart + cSpan.outEnd) / 2000) * fps);
  // the accent bar of the card (the last fill op), centre in output px
  const bar = plan.frames[fCard].slide.ops.filter((o: any) => o.op === "fill").pop();
  const bxs = bar.pts.filter((_: number, i: number) => i % 2 === 0), bys = bar.pts.filter((_: number, i: number) => i % 2 === 1);
  const box: number[] = [Math.min(...bxs), Math.min(...bys), Math.max(...bxs), Math.max(...bys)];
  const barX = (box[0]! + box[2]!) / 2, barY = (box[1]! + box[3]!) / 2;
  console.log("accent bar box (output px):", box.map((v) => v.toFixed(1)).join(", "));

  // ---- preview
  const pv = { A: await previewAt(page, fA), B: await previewAt(page, fB), o0: await previewAt(page, f0), o1: await previewAt(page, f1), card: await previewAt(page, fCard), image: await previewAt(page, fImage) };
  const red = (f: Img) => redCentroid(f, screen[0], screen[1], screen[0] + screen[2], screen[1] + screen[3])!;
  const pvHold = Math.hypot(red(pv.A).x - red(pv.B).x, red(pv.A).y - red(pv.B).y);
  const pvMove = red(pv.o1).x - red(pv.o0).x;
  const pvCur = Math.hypot(darkCentroid(pv.A, screen)!.x - darkCentroid(pv.B, screen)!.x, 0);
  console.log(`preview: hold drift ${pvHold.toFixed(2)} px, unfrozen move ${pvMove.toFixed(1)} px, cursor move ${pvCur.toFixed(1)} px`);
  expect(pvHold).toBeLessThanOrEqual(1.5);
  expect(pvMove).toBeGreaterThanOrEqual(25);
  expect(pvCur).toBeGreaterThanOrEqual(20);
  const pvBar = pix(pv.card, barX, barY);
  console.log("preview card bar", pvBar, "corner", pix(pv.card, 3, 3));
  expect(maxCh(pvBar, hex(PRIMARY))).toBeLessThanOrEqual(40);

  // ---- export
  const t0 = Date.now();
  const file = await exportMp4(page, dir, 480_000);
  console.log("export:", file, ((Date.now() - t0) / 1000).toFixed(1), "s");
  const probe = spawnSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file], { encoding: "utf8" }).stdout.trim();
  console.log("export frames:", probe, "plan frames:", plan.output.frames);
  expect(Math.abs(parseInt(probe, 10) - plan.output.frames)).toBeLessThanOrEqual(1);
  const ex = { A: exportFrame(file, fA), B: exportFrame(file, fB), o0: exportFrame(file, f0), o1: exportFrame(file, f1), card: exportFrame(file, fCard), image: exportFrame(file, fImage) };
  for (const [k, v] of Object.entries(ex)) dump(`freeze-export-${k}`, v);
  for (const [k, v] of Object.entries(pv)) dump(`freeze-preview-${k}`, v);
  const exHold = Math.hypot(red(ex.A).x - red(ex.B).x, red(ex.A).y - red(ex.B).y);
  const exMove = red(ex.o1).x - red(ex.o0).x;
  const exCur = Math.abs(darkCentroid(ex.A, screen)!.x - darkCentroid(ex.B, screen)!.x);
  console.log(`export: hold drift ${exHold.toFixed(2)} px, unfrozen move ${exMove.toFixed(1)} px, cursor move ${exCur.toFixed(1)} px`);
  expect(exHold).toBeLessThanOrEqual(1.5);
  expect(exMove).toBeGreaterThanOrEqual(25);
  expect(exCur).toBeGreaterThanOrEqual(20);
  const dHold = meanDiff(pv.A, ex.A), dCard = meanDiff(pv.card, ex.card), dImage = meanDiff(pv.image, ex.image);
  console.log(`preview vs export mean |RGB|: hold ${dHold.toFixed(2)}, card ${dCard.toFixed(2)}, image ${dImage.toFixed(2)}`);
  expect(dHold).toBeLessThanOrEqual(12);
  expect(dCard).toBeLessThanOrEqual(12);
  expect(dImage).toBeLessThanOrEqual(12);

  // pause: frames inside it and the first frame after it all show source 2.8 s
  const after = Math.round((pSpan.outEnd / 1000) * fps);
  expect(plan.frames[after].src).toBe(2800);
  const pz = [exportFrame(file, fPause[0]!), exportFrame(file, fPause[1]!), exportFrame(file, after)];
  const dPause = [meanDiff(pz[0]!, pz[1]!), meanDiff(pz[1]!, pz[2]!)];
  console.log("pause frames (inside, inside, first after) mean |RGB| neighbours:", dPause.map((d) => d.toFixed(2)).join(", "));
  for (const d of dPause) expect(d).toBeLessThanOrEqual(3);

  // image slide
  const W = ex.image.w, H = ex.image.h;
  const left = pix(ex.image, W / 2 - W * 0.1, H / 2), right = pix(ex.image, W / 2 + W * 0.1, H / 2), corner = pix(ex.image, 4, 4);
  console.log("image slide export: left", left, "right", right, "corner", corner);
  expect(maxCh(left, [30, 80, 220])).toBeLessThanOrEqual(40);
  expect(maxCh(right, [240, 200, 40])).toBeLessThanOrEqual(40);
  expect(maxCh(corner, hex("#11131a"))).toBeLessThanOrEqual(12);

  // title card in the brand look
  let gr = -255;
  for (let y = Math.floor(box[1]!); y <= Math.ceil(box[3]!); y++) for (let x = Math.ceil(box[0]! + 3); x <= Math.floor(box[2]! - 3); x++) { const c = pix(ex.card, x, y); gr = Math.max(gr, c[1]! - c[0]!); }
  const exCorner = pix(ex.card, 3, 3);
  console.log("card export: bar centre", pix(ex.card, barX, barY), "max G-R over the bar", gr, "corner", exCorner, "preview corner", pix(pv.card, 3, 3));
  expect(gr).toBeGreaterThanOrEqual(90);
  expect(maxCh(exCorner, hex("#11131a"))).toBeGreaterThanOrEqual(20);

  // audio: the tone moves by the title card + the pause; the pause is silent
  const pcmBuf = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"], { maxBuffer: 256 * 1024 * 1024 }).stdout;
  const pcm = new Float32Array(pcmBuf.buffer, pcmBuf.byteOffset, Math.floor(pcmBuf.length / 4));
  const toneAt = (2000 + 3000 + 1500) / 1000;
  const dbTone = rmsDb(pcm, toneAt + 0.05, toneAt + 0.45);
  const dbPause = rmsDb(pcm, pSpan.outStart / 1000 + 0.05, pSpan.outEnd / 1000 - 0.05);
  const dbNoPause = rmsDb(pcm, 5.05, 5.45);
  console.log(`audio dBFS: tone at ${toneAt}s ${dbTone.toFixed(1)}, pause ${dbPause.toFixed(1)}, where it was without the pause ${dbNoPause.toFixed(1)}`);
  expect(dbTone - dbPause).toBeGreaterThanOrEqual(40);
  expect(dbTone - dbNoPause).toBeGreaterThanOrEqual(40);
});
