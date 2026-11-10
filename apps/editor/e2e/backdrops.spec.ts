/**
 * Built-in backdrops v0.1.4 (Windows ask: "add more cool n diff images"): category chips above the
 * Image grid, >= 36 new procedural backdrops, preview == export.
 *
 * Bounds (set before the first run):
 *  - Background > Image lists >= 48 backdrops under "All" (12 classic + >= 36 new), every thumbnail
 *    is drawn (not blank: luma std-dev > 1 on its canvas);
 *  - every category chip shows >= 2 backdrops, fewer than All, and each shown backdrop carries that
 *    category (data-cats); "Classic" shows exactly the original 12;
 *  - grid opening after the first load: Gradient tab -> Image tab until every thumbnail is painted
 *    takes < 100 ms (thumbnails are cached);
 *  - picking 3 new backdrops from 3 different categories (at 480p output, 854x480 > the inline limit, so the full-size render goes
 *    through the worker) stores builtin:<id> in the project and the plan's style.backdropArt; the
 *    preview's backdrop changes vs the previous backdrop: mean |RGB| >= 8 over the four 24x24 corner
 *    patches (always backdrop; a whole-frame mean is diluted by the unchanged recording on top, e.g.
 *    7.7 for the fixture's dark solid #203040 -> aurora-borealis);
 *  - a short export (output frame F) vs the preview of frame F: mean |RGB| over the whole frame <= 12;
 *    the Python compositor's make_background on the same plan style matches the exported frame
 *    within 16 at the 4 corners and the top / left edge midpoints;
 *  - Shuffle under "Neon" picks a different built-in that is in Neon;
 *  - a contact sheet of every thumbnail is written (test-results/screens/backdrops-contact.png, and
 *    LENS_BACKDROP_SHEET when set).
 * Run with LENS_EXPORT=browser for the desktop app's export path (the editor's renderer in a worker).
 */
import { test, type Page } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { EDITOR, expect, seek, shot, waitDrawn } from "./helpers";
import { closeAll, openLens, PACKAGED } from "./lensApp";
import { editProject, exportMp4, proj, px, rgbDist, uxBundle } from "./uxHelpers";

test.afterAll(() => closeAll());

function frameIdx(file: string, n: number): { w: number; h: number; rgb: Buffer } {
  const [w, h] = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { encoding: "utf8" })
    .stdout.trim().split(",").map(Number) as [number, number];
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `select=eq(n\\,${n})`, "-vsync", "0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || r.stdout.length < w * h * 3) throw new Error(`could not decode frame ${n} of ${file}: ${r.stderr}`);
  return { w, h, rgb: r.stdout.subarray(0, w * h * 3) };
}

async function previewRgb(page: Page): Promise<{ w: number; h: number; rgb: Buffer }> {
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

/** Mean |RGB| over the four corner patches (k x k) of two same-size frames: the backdrop only. */
function cornerDiff(a: { w: number; h: number; rgb: Buffer }, b: { w: number; h: number; rgb: Buffer }, k = 24): number {
  let s = 0, n = 0;
  for (const [x0, y0] of [[0, 0], [a.w - k, 0], [0, a.h - k], [a.w - k, a.h - k]] as const)
    for (let y = y0; y < y0 + k; y++)
      for (let x = x0; x < x0 + k; x++)
        for (let c = 0; c < 3; c++) { const i = (y * a.w + x) * 3 + c; s += Math.abs(a.rgb[i]! - b.rgb[i]!); n++; }
  return s / n;
}

const meanDiff = (a: Buffer, b: Buffer) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
  return s / a.length;
};

function dumpRgb(name: string, f: { w: number; h: number; rgb: Buffer }): void {
  const out = path.join(EDITOR, "test-results", "screens", `${name}.png`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${f.w}x${f.h}`, "-i", "pipe:0", "-frames:v", "1", out], { input: f.rgb });
}

/** Wait until every thumbnail canvas in the grid is painted. */
const allThumbs = (page: Page) =>
  page.waitForFunction(() => {
    const cs = [...document.querySelectorAll('[data-testid="bg-images"] canvas')] as HTMLCanvasElement[];
    return cs.length > 0 && cs.every((c) => c.dataset.ready === "1");
  }, null, { timeout: 60_000 });

/** The preview settled on the current revision with the full-size backdrop (no stand-in). */
async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__lens.state().backdropsPending === 0, null, { timeout: 60_000 });
  await waitDrawn(page);
  await page.waitForTimeout(200);
  await waitDrawn(page);
}

test("backdrop categories, new procedural backdrops, preview == export", async () => {
  test.setTimeout(420_000);
  const dir = uxBundle("backdrops");
  const lens = await openLens(dir, { w: 1366, h: 900 });
  const page = lens.page;
  const exportPath = await page.evaluate(() => (window as any).__lens.store.exportPath());
  console.log(PACKAGED ? "packaged app" : "web editor", "export path:", exportPath);
  await editProject(page, "Short 480p export", `(p) => ({ ...p, output: { ...p.output, resolution: 480, fps: 30 }, edits: { ...p.edits, cuts: [...p.edits.cuts, { startMs: 500, endMs: 6000 }] } })`);
  await page.getByTestId("tab-look").click();

  // ---- the grid, first load
  const t0 = Date.now();
  await page.getByTestId("bg-tab-image").click();
  await allThumbs(page);
  console.log("first grid fill (all thumbnails rendered):", Date.now() - t0, "ms");
  const all = await page.locator('[data-testid="bg-images"] button').evaluateAll((bs) => bs.map((b) => ({ id: b.getAttribute("data-testid")!.slice("bg-image-".length), cats: b.getAttribute("data-cats")!.split(" ") })));
  console.log("All:", all.length);
  expect(all.length).toBeGreaterThanOrEqual(48);
  expect(new Set(all.map((b) => b.id)).size).toBe(all.length);
  const blank = await page.locator('[data-testid="bg-images"] canvas').evaluateAll((cs) =>
    (cs as HTMLCanvasElement[]).filter((c) => {
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      let s = 0, s2 = 0;
      const n = d.length / 4;
      for (let i = 0; i < d.length; i += 4) { const l = 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!; s += l; s2 += l * l; }
      return Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)) <= 1;
    }).map((c) => c.dataset.testid));
  expect(blank).toEqual([]);

  // ---- contact sheet of every thumbnail (not committed; artifacts only)
  const sheet = await page.evaluate(() => {
    const cs = [...document.querySelectorAll('[data-testid="bg-images"] canvas')] as HTMLCanvasElement[];
    const cols = 8, tw = cs[0]!.width, th = cs[0]!.height, pad = 8, lab = 16;
    const out = document.createElement("canvas");
    out.width = cols * (tw + pad) + pad;
    out.height = Math.ceil(cs.length / cols) * (th + pad + lab) + pad;
    const g = out.getContext("2d")!;
    g.fillStyle = "#18181b";
    g.fillRect(0, 0, out.width, out.height);
    g.font = "11px sans-serif";
    g.fillStyle = "#e4e4e7";
    cs.forEach((c, i) => {
      const x = pad + (i % cols) * (tw + pad), y = pad + Math.floor(i / cols) * (th + pad + lab);
      g.drawImage(c, x, y);
      g.fillText(c.dataset.testid!.slice("bg-thumb-".length), x, y + th + 12);
    });
    return out.toDataURL("image/png").split(",")[1]!;
  });
  const sheetFile = path.join(EDITOR, "test-results", "screens", "backdrops-contact.png");
  fs.mkdirSync(path.dirname(sheetFile), { recursive: true });
  fs.writeFileSync(sheetFile, Buffer.from(sheet, "base64"));
  if (process.env.LENS_BACKDROP_SHEET) fs.copyFileSync(sheetFile, process.env.LENS_BACKDROP_SHEET);
  console.log("contact sheet:", sheetFile);

  // ---- categories
  const chips = await page.locator('[data-testid^="bg-cat-"]').evaluateAll((bs) => bs.map((b) => b.getAttribute("data-testid")!.slice("bg-cat-".length)));
  console.log("chips:", chips.join(", "));
  expect(chips[0]).toBe("all");
  expect(chips.length).toBeGreaterThanOrEqual(10);
  for (const c of chips.slice(1)) {
    await page.getByTestId(`bg-cat-${c}`).click();
    const shown = await page.locator('[data-testid="bg-images"] button').evaluateAll((bs) => bs.map((b) => b.getAttribute("data-cats")!.split(" ")));
    console.log(`category ${c}: ${shown.length}`);
    expect(shown.length, c).toBeGreaterThanOrEqual(2);
    expect(shown.length, c).toBeLessThan(all.length);
    for (const cats of shown) expect(cats, c).toContain(c);
    if (c === "classic") expect(shown.length).toBe(12);
  }
  await page.getByTestId("bg-cat-all").click();

  // ---- grid opening after the first load (cached thumbnails)
  await page.getByTestId("bg-tab-gradient").click();
  await page.waitForTimeout(200);
  const openMs = await page.evaluate(async () => {
    const t = performance.now();
    (document.querySelector('[data-testid="bg-tab-image"]') as HTMLElement).click();
    await new Promise<void>((res) => {
      const chk = () => {
        const cs = [...document.querySelectorAll('[data-testid="bg-images"] canvas')] as HTMLCanvasElement[];
        if (cs.length > 40 && cs.every((c) => c.dataset.ready === "1")) res();
        else requestAnimationFrame(chk);
      };
      chk();
    });
    return performance.now() - t;
  });
  console.log("grid open after first load:", openMs.toFixed(1), "ms (bound < 100)");
  expect(openMs).toBeLessThan(100);

  // ---- pick 3 new backdrops (different categories), preview vs export
  const F = 6;
  await seek(page, F);
  let prevFrame = await previewRgb(page);
  const results: Record<string, unknown> = {};
  for (const [cat, id] of [["aurora", "aurora-borealis"], ["geometric", "iso-blocks"], ["neon", "synth-sunset"]] as const) {
    await page.getByTestId(`bg-cat-${cat}`).click();
    await page.getByTestId(`bg-image-${id}`).click();
    expect((await proj(page)).background).toMatchObject({ kind: "image", imagePath: `builtin:${id}` });
    const style = await page.evaluate(() => (window as any).__lens.store.get().plan.style);
    expect(style.backdropArt?.id).toBe(id);
    const tPick = Date.now();
    await settled(page);
    await seek(page, F + 1);
    await seek(page, F);
    const pv = await previewRgb(page);
    console.log(`${id}: preview settled in ~${Date.now() - tPick} ms`);
    const changed = cornerDiff(pv, prevFrame);
    console.log(`${id}: backdrop change vs previous (corner patches) ${changed.toFixed(1)}, whole frame ${meanDiff(pv.rgb, prevFrame.rgb).toFixed(1)}`);
    expect(changed, `${id} changes the backdrop`).toBeGreaterThanOrEqual(8);
    const mp4 = await exportMp4(page, dir);
    await page.evaluate(() => (window as any).__lens.store.closeExport());
    const ef = frameIdx(mp4, F);
    expect([ef.w, ef.h]).toEqual([pv.w, pv.h]);
    const d = meanDiff(pv.rgb, ef.rgb);
    dumpRgb(`backdrops-${id}-preview`, pv);
    dumpRgb(`backdrops-${id}-export`, ef);
    // the reference compositor draws the same art from the plan
    const pts: Array<[number, number]> = [[3, 3], [ef.w - 4, 3], [3, ef.h - 4], [ef.w - 4, ef.h - 4], [ef.w / 2, 3], [3, ef.h / 2]];
    const py = JSON.parse(execFileSync("python3", ["-c", [
      "import json,sys; sys.path.insert(0, sys.argv[1]); from lens_compositor.render import make_background",
      "a=json.loads(sys.argv[2]); bg=make_background(a['style'], a['w'], a['h'])",
      "print(json.dumps([[float(v) for v in bg[int(round(y)), int(round(x))][::-1]] for x, y in a['pts']]))",
    ].join("\n"), path.resolve(EDITOR, "..", "..", "compositor"), JSON.stringify({ style, w: ef.w, h: ef.h, pts })], { encoding: "utf8" }));
    const dists = pts.map(([x, y], i) => rgbDist(px(ef, x, y), py[i]));
    console.log(`${id}: export frame ${F} vs preview mean |RGB| ${d.toFixed(2)} (bound 12); backdrop change vs previous ${changed.toFixed(1)}; python vs export`, dists.map((v) => v.toFixed(1)).join(" "));
    expect(d, `${id} preview vs export`).toBeLessThanOrEqual(12);
    for (const v of dists) expect(v, `${id} python vs export`).toBeLessThanOrEqual(16);
    results[id] = { previewVsExport: d, changed, pythonVsExport: dists };
    prevFrame = pv;
    await shot(page, `backdrops-${id}${PACKAGED ? "-app" : ""}`);
  }

  // ---- shuffle within a category
  await page.getByTestId("bg-cat-neon").click();
  const before = (await proj(page)).background.imagePath;
  await page.getByTestId("bg-shuffle").click();
  const after = (await proj(page)).background.imagePath as string;
  const neon = await page.locator('[data-testid="bg-images"] button').evaluateAll((bs) => bs.map((b) => `builtin:${b.getAttribute("data-testid")!.slice("bg-image-".length)}`));
  console.log("shuffle:", before, "->", after);
  expect(after).not.toBe(before);
  expect(neon).toContain(after);

  fs.writeFileSync(path.join(EDITOR, "test-results", "backdrops-e2e.json"), JSON.stringify({ exportPath, all: all.length, openMs, results }, null, 1));
  await lens.close();
});
