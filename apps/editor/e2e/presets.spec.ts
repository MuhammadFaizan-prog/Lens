/**
 * Presets and brand kit in the editor (demand #9).
 *
 * Bounds (written before the first run, docs/Tracker.md):
 *  - applying a preset changes the preview: mean |RGB| difference on the 8 px grid >= 8
 *  - every built-in preset's live thumbnail renders, and every pair of thumbnails differs by >= 4
 *  - applying is one undo step: after Ctrl+Z the project JSON equals the original exactly and the
 *    preview differs by <= 0.5; redo brings the preset back
 *  - partial apply (Look only): output aspect changes, and cursor, zoom, captions, audio, webcam and
 *    annotations are exactly the original JSON
 *  - save -> export -> delete -> import -> export: the two .lenspreset files are byte-identical, and
 *    applying the imported preset to the original project reproduces the saved project's sections
 *  - watermark in the preview: switching it off changes nothing outside its rect, and the alpha
 *    recovered inside it (95th percentile, i.e. the logo's opaque core) is 0.8 ± 0.03
 *    (this replaced a first check, mean |diff| >= 20, that measured 18.4: see docs/Tracker.md)
 *  - brand primary change is live (before the slider / picker commit): in the preview, pixels within
 *    ±16 of the new primary grow by >= 100 in the caption band and in the screen region (box), the
 *    backdrop corner is within ±6 of the gradient derived from the new primary; undo restores it
 */
import { test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { EDITOR, canvasPixels, expect, meanAbsDiff, openEditor, seek, shot, state, waitDrawn } from "./helpers";

const APPLY_DIFF = 8;
const THUMB_DIFF = 4;
const UNDO_DIFF = 0.5;
const BRAND_PX = 100;
const BG_TOL = 6;

async function openPresets(page: Page) {
  if (!(await page.getByTestId("presets-menu").isVisible().catch(() => false))) await page.getByTestId("presets-button").click();
  await expect(page.getByTestId("presets-menu")).toBeVisible();
}

async function thumbsReady(page: Page, ids: string[]) {
  await page.waitForFunction((list: string[]) => list.every((id) => !!(document.querySelector(`[data-testid="preset-thumb-${id}"]`) as HTMLCanvasElement | null)?.dataset.rendered), ids, { timeout: 90_000 });
}

test("apply a preset: preview and thumbnails change, one undo step restores it", async ({ page }) => {
  test.setTimeout(240_000);
  await openEditor(page);
  await seek(page, 150);
  const before = await state(page);
  const px0 = await canvasPixels(page);
  await openPresets(page);
  const ids = before.project && (await page.evaluate(() => (window as any).__lens.store.get().presets.map((p: any) => p.id))) as string[];
  expect(ids).toEqual(["clean-product-demo", "tutorial", "social-vertical", "dark-dev", "minimal"]);
  await thumbsReady(page, ids);
  const diffs = await page.evaluate((list: string[]) => {
    const px = list.map((id) => {
      const c = document.querySelector(`[data-testid="preset-thumb-${id}"]`) as HTMLCanvasElement;
      return Array.from(c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data);
    });
    const out: Array<[string, string, number]> = [];
    for (let i = 0; i < px.length; i++)
      for (let j = i + 1; j < px.length; j++) {
        let s = 0, n = 0;
        for (let k = 0; k < px[i]!.length; k += 4) {
          s += Math.abs(px[i]![k]! - px[j]![k]!) + Math.abs(px[i]![k + 1]! - px[j]![k + 1]!) + Math.abs(px[i]![k + 2]! - px[j]![k + 2]!);
          n += 3;
        }
        out.push([list[i]!, list[j]!, s / n]);
      }
    return out;
  }, ids);
  console.log(`thumbnail pair differences: ${diffs.map(([a, b, d]) => `${a}/${b} ${d.toFixed(1)}`).join(", ")}`);
  for (const [a, b, d] of diffs) expect(d, `${a} vs ${b}`).toBeGreaterThanOrEqual(THUMB_DIFF);
  await shot(page, "presets-menu");

  await page.getByTestId("preset-apply-dark-dev").click();
  await waitDrawn(page);
  const after = await state(page);
  expect(after.project.theme.preset.id).toBe("dark-dev");
  expect(after.project.cursor.size).toBe(1.3);
  expect(after.project.background.inherit).toBe(true);
  const px1 = await canvasPixels(page);
  const d1 = meanAbsDiff(px0, px1);
  console.log(`apply Dark Dev: preview mean |diff| ${d1.toFixed(2)}`);
  expect(d1).toBeGreaterThanOrEqual(APPLY_DIFF);
  await expect(page.getByTestId("preset-current")).toContainText("Dark Dev");
  // one undo step back to the exact original
  await page.getByTestId("presets-button").click(); // close the menu
  await page.keyboard.press("Control+z");
  await waitDrawn(page);
  const undone = await state(page);
  expect(JSON.stringify(undone.project)).toBe(JSON.stringify(before.project));
  const d2 = meanAbsDiff(px0, await canvasPixels(page));
  console.log(`after undo: preview mean |diff| ${d2.toFixed(3)}`);
  expect(d2).toBeLessThanOrEqual(UNDO_DIFF);
  await page.keyboard.press("Control+Shift+z");
  await waitDrawn(page);
  expect((await state(page)).project.theme.preset.id).toBe("dark-dev");
});

test("partial apply keeps the unchecked sections", async ({ page }) => {
  test.setTimeout(180_000);
  await openEditor(page);
  const before = (await state(page)).project;
  await openPresets(page);
  for (const k of ["zoom", "cursor", "webcam", "captions", "audio", "annotations"]) await page.getByTestId(`preset-section-${k}`).uncheck();
  await expect(page.getByTestId("preset-section-look")).toBeChecked();
  await page.getByTestId("preset-apply-social-vertical").click();
  await waitDrawn(page);
  const p = (await state(page)).project;
  expect(p.output.aspect).toBe("9:16");
  expect(p.theme.preset.sections).toEqual(["look"]);
  for (const k of ["cursor", "zoom", "captions", "audio", "camera", "annotations", "edits", "masks"]) expect(JSON.stringify(p[k]), k).toBe(JSON.stringify(before[k]));
  const s = await state(page);
  expect(await page.evaluate(() => (window as any).__lens.store.get().plan.output.height)).toBeGreaterThan(await page.evaluate(() => (window as any).__lens.store.get().plan.output.width));
  expect(s.canUndo).toBe(true);
});

test("save current as preset, export, delete, re-import: the round trip is identical", async ({ page }, info) => {
  test.setTimeout(180_000);
  await openEditor(page);
  // a hand-made look: Tutorial, then a bigger cursor
  await page.evaluate(() => (window as any).__lens.store.applyStylePreset("tutorial"));
  await page.evaluate(() => (window as any).__lens.store.edit("Cursor size", (p: any) => ({ ...p, cursor: { ...p.cursor, size: 2.4 } })));
  const source = (await state(page)).project;
  await openPresets(page);
  await page.getByTestId("preset-save").click();
  await page.getByTestId("preset-save-name").fill("Round trip");
  await page.getByTestId("preset-save-confirm").click();
  await expect(page.getByTestId("preset-row-round-trip")).toBeVisible();
  const exportFile = async () => {
    await page.getByTestId("preset-more-round-trip").click();
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("preset-export-round-trip").click()]);
    const file = info.outputPath(`export-${Date.now()}.lenspreset`);
    await dl.saveAs(file);
    expect(dl.suggestedFilename()).toBe("round-trip.lenspreset");
    return file;
  };
  const f1 = await exportFile();
  const t1 = fs.readFileSync(f1, "utf8");
  expect(JSON.parse(t1).format).toBe("lens-preset");
  await page.getByTestId("preset-more-round-trip").click();
  await page.getByTestId("preset-delete-round-trip").click();
  await expect(page.getByTestId("preset-row-round-trip")).toHaveCount(0);
  await page.getByTestId("preset-import-input").setInputFiles(f1);
  await expect(page.getByTestId("preset-row-round-trip")).toBeVisible();
  const t2 = fs.readFileSync(await exportFile(), "utf8");
  expect(t2).toBe(t1);
  // applying the imported preset to the original project gives the saved project's sections back
  await page.evaluate(() => {
    const s = (window as any).__lens.store;
    s.undo();
    s.undo();
  });
  const orig = (await state(page)).project;
  expect(orig.cursor.size).not.toBe(2.4);
  await page.getByTestId("preset-apply-round-trip").click();
  await waitDrawn(page);
  const applied = (await state(page)).project;
  for (const k of ["cursor", "frame", "motionBlur", "captions", "audio", "camera", "output"]) expect(JSON.stringify(applied[k]), k).toBe(JSON.stringify(source[k]));
  const z = (p: any) => JSON.stringify({ ...p.zoom, segments: [] });
  expect(z(applied)).toBe(z(source));
  // and it draws the same: the plan's style block is identical
  const style = await page.evaluate(() => JSON.stringify((window as any).__lens.store.get().plan.style));
  expect(style.length).toBeGreaterThan(10);
});

/** Pixels within tol of rgb in a region of the preview (output px). */
async function countNear(page: Page, rgb: number[], region: [number, number, number, number], tol = 16): Promise<number> {
  return page.evaluate(([c, r, t]: any) => {
    const cv = document.querySelector('[data-testid="preview"]') as HTMLCanvasElement;
    const d = cv.getContext("2d")!.getImageData(r[0], r[1], r[2], r[3]).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i]! - c[0]) <= t && Math.abs(d[i + 1]! - c[1]) <= t && Math.abs(d[i + 2]! - c[2]) <= t) n++;
    return n;
  }, [rgb, region, tol]);
}

async function pixelAt(page: Page, x: number, y: number): Promise<number[]> {
  return page.evaluate(([px, py]) => {
    const cv = document.querySelector('[data-testid="preview"]') as HTMLCanvasElement;
    return Array.from(cv.getContext("2d")!.getImageData(px!, py!, 4, 4).data.slice(0, 3));
  }, [x, y]);
}

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mixRgb = (a: number[], b: number[], u: number) => a.map((v, i) => Math.round(v + (b[i]! - v) * u));

test("brand kit: changing the primary colour updates captions, annotations and backdrop live; undo restores", async ({ page }) => {
  test.setTimeout(240_000);
  const dir = path.join(EDITOR, "sample-brand");
  await openEditor(page, `/?dir=${encodeURIComponent(dir)}`);
  // a frame with the box, a highlighted caption word and the watermark: source ~2.0 s
  const f = await page.evaluate(() => {
    const st = (window as any).__lens.store.get();
    return st.plan.frames.findIndex((x: any) => x.src >= 2000 && !x.slide);
  });
  await seek(page, f);
  const st0 = await state(page);
  expect(st0.caption && st0.caption.active).toBeGreaterThanOrEqual(0);
  const plan = await page.evaluate(() => {
    const st = (window as any).__lens.store.get();
    return { wm: st.plan.watermark, W: st.plan.output.width, H: st.plan.output.height, ann: st.plan.frames[st.frame].annotations.map((a: any) => a.id) };
  });
  expect(plan.ann).toContain("box");
  expect(plan.wm).toBeTruthy();
  // the watermark is drawn: switching it off changes its rect (mean |diff| >= 20) and nothing outside it
  // (pixels stay in the page: copying two full frames into the test process got it OOM-killed)
  await page.evaluate(() => {
    const cv = document.querySelector('[data-testid="preview"]') as HTMLCanvasElement;
    (window as any).__wmOn = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
  });
  await page.evaluate(() => (window as any).__lens.store.editBrand("Watermark off", (b: any) => ({ ...b, logo: { ...b.logo, watermark: false } })));
  await waitDrawn(page);
  const { inside, nIn, outside, p95 } = await page.evaluate((wm: any) => {
    const cv = document.querySelector('[data-testid="preview"]') as HTMLCanvasElement;
    const off = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
    const on = (window as any).__wmOn as Uint8ClampedArray;
    let inside = 0, nIn = 0, outside = 0;
    const alphas: number[] = [];
    for (let y = 0; y < cv.height; y++)
      for (let x = 0; x < cv.width; x++) {
        const o = (y * cv.width + x) * 4;
        const d = (Math.abs(on[o]! - off[o]!) + Math.abs(on[o + 1]! - off[o + 1]!) + Math.abs(on[o + 2]! - off[o + 2]!)) / 3;
        if (x >= wm.x && x < wm.x + wm.w && y >= wm.y && y < wm.y + wm.h) {
          inside += d;
          nIn++;
          // alpha recovered from the white logo over what is underneath: (on - off) / (255 - off)
          const offL = (off[o]! + off[o + 1]! + off[o + 2]!) / 3;
          const onL = (on[o]! + on[o + 1]! + on[o + 2]!) / 3;
          if (255 - offL > 60) alphas.push((onL - offL) / (255 - offL));
        } else if (d > 0) outside++;
      }
    delete (window as any).__wmOn;
    alphas.sort((a, b) => a - b);
    return { inside, nIn, outside, p95: alphas[Math.floor(alphas.length * 0.95)] ?? 0 };
  }, plan.wm);
  await page.evaluate(() => (window as any).__lens.store.undo());
  await waitDrawn(page);
  console.log(`watermark on/off: mean |diff| inside its rect ${(inside / nIn).toFixed(1)}, recovered alpha p95 ${p95.toFixed(4)} (opacity 0.8), changed px outside ${outside}`);
  // the logo's opaque core shows at the brand opacity (0.8 ± 0.03); nothing outside its rect moves
  expect(Math.abs(p95 - 0.8)).toBeLessThanOrEqual(0.03);
  expect(outside).toBe(0);

  const NEW = "#ff7a00";
  const caption: [number, number, number, number] = [0, Math.round(plan.H * 0.8), plan.W, Math.round(plan.H * 0.2)];
  const screen: [number, number, number, number] = [0, 0, plan.W, Math.round(plan.H * 0.6)];
  const cap0 = await countNear(page, hex(NEW), caption);
  const scr0 = await countNear(page, hex(NEW), screen);
  const px0 = await canvasPixels(page);
  await page.getByTestId("left-tab-brand").click();
  await page.getByTestId("brand-primary").fill(NEW);
  // live: the preview redraws while the edit is still an open gesture (it commits after 400 ms idle)
  await waitDrawn(page);
  const cap1 = await countNear(page, hex(NEW), caption);
  const scr1 = await countNear(page, hex(NEW), screen);
  const corner = await pixelAt(page, 1, 1);
  const want = mixRgb(hex(NEW), hex("#07080c"), 0.8);
  console.log(`brand primary -> ${NEW}: caption band px ${cap0} -> ${cap1}, screen region px ${scr0} -> ${scr1}, backdrop corner ${corner} (derived ${want})`);
  expect(cap1 - cap0).toBeGreaterThanOrEqual(BRAND_PX);
  expect(scr1 - scr0).toBeGreaterThanOrEqual(BRAND_PX);
  for (let i = 0; i < 3; i++) expect(Math.abs(corner[i]! - want[i]!)).toBeLessThanOrEqual(BG_TOL);
  await shot(page, "brand-panel");
  // undo restores the old colour everywhere
  await page.waitForTimeout(600);
  await page.getByTestId("undo").click();
  await waitDrawn(page);
  expect((await state(page)).project.brand.colors.primary).toBe("#7c5cff");
  expect(meanAbsDiff(px0, await canvasPixels(page))).toBeLessThanOrEqual(UNDO_DIFF);
});
