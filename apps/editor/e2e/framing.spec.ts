/**
 * Framing on an aspect change (fix/aspect-framing-014, Faizi's Windows v0.1.3 report: a 16:9 recording
 * switched to 9:16 became a small card near the bottom, and he could not choose which part to show).
 *
 * Bounds (set before the first run), on the 1280x720 UX sample (checkerboard, red markers at
 * (900, 250) and (320, 520), #203040 backdrop, the cursor moving right at 120 px/s), exported at 360p:
 *  - a card dragged to the bottom at 16:9, then 9:16 from the toolbar: card null and the screen rect
 *    centred on the canvas (|centre - canvas centre| <= 1 px each way), whole source shown;
 *  - Fit: framing "fit", centred, crop = the full 1280x720;
 *  - Fill: framing "fill", screen rect = the canvas, crop = the centred 9:16 window of the source
 *    (|crop aspect - 9/16| < 0.01, |crop centre x - 640| <= 1); the preview's canvas corners show the
 *    checkerboard (luma std >= 40), not the backdrop;
 *  - Follow cursor: framing "follow" (fit "fill"); every sampled frame's screen rect covers the canvas;
 *    the pan follows the cursor right (2 s kept): screen x at 1.95 s < screen x at 0.5 s by >= 10 output px;
 *  - Custom: the preview enters the edit view (whole source fitted: backdrop above it within 16 of #203040; dimmed outside the window, the window
 *    box selected); dragging the box right by 60 output px moves framingRect.x right by >= 40 source px;
 *    W = 200 gives h = 356 +- 1 (aspect locked); X 800 / Y 72 put marker (900, 250) inside; one Undo
 *    restores the previous rect exactly; Done leaves the edit view (window box and dim gone); Reset gives the centred window;
 *  - a 2 s export in Custom: 9:16, the red marker's centroid within 4 % of the frame width / height
 *    of where the preview shows it, and the export frame at 1.0 s vs the preview of the same frame:
 *    mean absolute difference <= 12 (per channel, every pixel);
 *  - saved and reopened: project.json carries output.framing "custom" and the same framingRect, and the
 *    reopened plan has the same source crop.
 */
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import { expect, shot } from "./helpers";
import { closeAll, openLens } from "./lensApp";
import { drag, exportMp4, frameAt, hexRgb, lumaStd, outToPage, proj, redCentroid, rgbDist, smallExport, uxBundle } from "./uxHelpers";

test.afterAll(() => closeAll());

test("framing: centred on aspect change, fit / fill / follow / custom, undo, export matches preview, persists", async () => {
  test.setTimeout(420_000);
  const dir = uxBundle("framing");
  const lens = await openLens(dir, { w: 1600, h: 1000 });
  const page = lens.page;
  const settle = () => page.waitForFunction(() => {
    const s = (window as any).__lens.state();
    const c = document.querySelector('[data-testid="preview"]') as HTMLCanvasElement | null;
    return !!c && c.dataset.frame === String(s.frame) && c.dataset.revision === String(s.revision);
  }, null, { timeout: 30_000 });
  const planInfo = () => page.evaluate(() => {
    const s = (window as any).__lens.store.get();
    const p = s.plan, f = p.frames[s.frame];
    const [x, y, w, h] = f.layout.screen;
    return { W: p.output.width, H: p.output.height, crop: p.source.crop as number[], screen: { x, y, w, h }, frame: s.frame as number };
  });
  /** The preview canvas as RGB (output px). */
  const previewRgb = () => page.evaluate(() => {
    const c = document.querySelector('[data-testid="preview"]') as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    const rgb: number[] = new Array((d.length / 4) * 3);
    for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { rgb[j] = d[i]!; rgb[j + 1] = d[i + 1]!; rgb[j + 2] = d[i + 2]!; }
    return { w: c.width, h: c.height, rgb };
  });
  const seekFrame = async (i: number) => {
    await page.evaluate((n) => (window as any).__lens.store.seek(n), i);
    await settle();
  };

  // small, fast exports: 360p30, first 2 s (also makes the preview 360p, so preview == export size)
  await smallExport(page, 2000);
  await settle();

  // ---- a free card dragged to the bottom at 16:9, then 9:16 from the toolbar: centred again
  const a0 = await planInfo();
  const from = await outToPage(page, a0.screen.x + a0.screen.w / 2, a0.screen.y + a0.screen.h / 2);
  const to = await outToPage(page, a0.screen.x + a0.screen.w / 2, a0.screen.y + a0.screen.h / 2 + 90);
  await drag(page, from, to);
  await settle();
  expect((await proj(page)).card).toBeTruthy();
  await page.getByTestId("tb-aspect").selectOption("9:16");
  await expect.poll(async () => (await proj(page)).output.aspect).toBe("9:16");
  await settle();
  const a = await planInfo();
  console.log("9:16 fit", JSON.stringify(a));
  expect((await proj(page)).card ?? null).toBeNull();
  expect(Math.abs(a.W / a.H - 9 / 16)).toBeLessThan(0.01);
  expect(Math.abs(a.screen.x + a.screen.w / 2 - a.W / 2)).toBeLessThanOrEqual(1);
  expect(Math.abs(a.screen.y + a.screen.h / 2 - a.H / 2)).toBeLessThanOrEqual(1);
  expect(a.crop).toEqual([0, 0, 1280, 720]);
  await shot(page, "framing-916-centred");

  // ---- the Look tab: tiles under the aspect picker and in the Screen section
  await page.getByTestId("tab-look").click();
  await expect(page.getByTestId("out-framing-fit")).toBeVisible();
  await expect(page.getByTestId("framing-custom-panel")).toHaveCount(0);

  // ---- Fill
  await page.getByTestId("framing-fill").click();
  await expect.poll(async () => (await proj(page)).output.framing).toBe("fill");
  await settle();
  const f1 = await planInfo();
  console.log("fill", JSON.stringify(f1));
  expect(f1.screen).toEqual({ x: 0, y: 0, w: f1.W, h: f1.H });
  expect(Math.abs(f1.crop[2]! / f1.crop[3]! - 9 / 16)).toBeLessThan(0.01);
  expect(Math.abs(f1.crop[0]! + f1.crop[2]! / 2 - 640)).toBeLessThanOrEqual(1);
  expect(f1.crop[3]).toBe(720);
  const pf = await previewRgb();
  for (const [x, y] of [[4, 4], [pf.w - 28, 4], [4, pf.h - 28], [pf.w - 28, pf.h - 28]] as const) {
    expect(lumaStd({ w: pf.w, rgb: Buffer.from(pf.rgb) }, x, y, x + 24, y + 24)).toBeGreaterThanOrEqual(40);
  }
  await expect(page.getByTestId("out-framing-fill")).toHaveAttribute("aria-checked", "true");
  await shot(page, "framing-fill");

  // ---- Fit (out-framing tile under the aspect picker)
  await page.getByTestId("out-framing-fit").click();
  await expect.poll(async () => (await proj(page)).output.framing).toBe("fit");
  await settle();
  const f0 = await planInfo();
  expect(f0.crop).toEqual([0, 0, 1280, 720]);
  expect(Math.abs(f0.screen.y + f0.screen.h / 2 - f0.H / 2)).toBeLessThanOrEqual(1);

  // ---- Follow cursor
  await page.getByTestId("framing-follow").click();
  await expect.poll(async () => (await proj(page)).output.framing).toBe("follow");
  expect((await proj(page)).output.fit).toBe("fill");
  await settle();
  const pan = await page.evaluate(() => {
    const p = (window as any).__lens.store.get().plan;
    const W = p.output.width, H = p.output.height;
    const covers = p.frames.every((f: any) => { const [x, y, w, h] = f.layout.screen; return x <= 0.01 && y <= 0.01 && x + w >= W - 0.02 && y + h >= H - 0.02; });
    const at = (ms: number) => p.frames.reduce((b: any, f: any) => (Math.abs(f.src - ms) < Math.abs(b.src - ms) ? f : b)).layout.screen[0];
    return { covers, x05: at(500), x19: at(1950), n: p.frames.length };
  });
  console.log("follow", JSON.stringify(pan));
  expect(pan.covers).toBe(true);
  // only 2 s are kept: the cursor moves 240 source px right in it, the crop pans with it
  expect(pan.x05 - pan.x19).toBeGreaterThanOrEqual(10);
  await shot(page, "framing-follow");

  // ---- Custom: edit view
  await page.getByTestId("framing-custom").click();
  await expect.poll(async () => (await proj(page)).output.framing).toBe("custom");
  await expect(page.getByTestId("preview")).toHaveAttribute("data-framing-edit", "1");
  await expect(page.getByTestId("co-sel-framing")).toBeVisible();
  await expect(page.getByTestId("framing-dim")).toHaveCount(1);
  await settle();
  const r0 = (await proj(page)).output.framingRect;
  console.log("custom start", JSON.stringify(r0));
  // the edit view shows the whole source, fitted: the backdrop above it (the dim is an overlay only)
  const pe = await previewRgb();
  const top = [0, 1, 2].map((k) => pe.rgb[(6 * pe.w + Math.round(pe.w / 2)) * 3 + k]!);
  console.log("edit view top", top);
  expect(rgbDist(top, hexRgb("#203040"))).toBeLessThanOrEqual(16);
  await shot(page, "framing-custom-edit");

  // drag the window box right by 60 output px
  const box = await page.getByTestId("co-sel-framing").getAttribute("data-box");
  const [bx, by, bw, bh] = box!.split(",").map(Number) as [number, number, number, number];
  const d0 = await outToPage(page, bx + bw / 2, by + bh / 2);
  const d1 = await outToPage(page, bx + bw / 2 + 60, by + bh / 2);
  await drag(page, d0, d1);
  await settle();
  const r1 = (await proj(page)).output.framingRect;
  console.log("custom dragged", JSON.stringify(r1));
  expect(r1.x - r0.x).toBeGreaterThanOrEqual(40);
  expect(r1.w).toBe(r0.w);

  // numeric fields: W 200 -> H follows the canvas aspect; X / Y onto the marker
  const field = async (id: string, v: number) => {
    const el = page.getByTestId(id);
    await el.fill(String(v));
    await el.press("Enter");
    await settle();
  };
  await field("framing-w", 200);
  const r2 = (await proj(page)).output.framingRect;
  expect(r2.w).toBe(200);
  expect(Math.abs(r2.h - 356)).toBeLessThanOrEqual(1);
  await field("framing-x", 800);
  await field("framing-y", 72);
  const r3 = (await proj(page)).output.framingRect;
  console.log("custom fields", JSON.stringify(r3));
  expect(r3.x).toBe(800);
  expect(r3.y).toBe(72);
  // one Undo puts the Y edit back exactly (one step), then set it again
  await page.getByTestId("undo").click();
  await expect.poll(async () => (await proj(page)).output.framingRect.y).toBe(r2.y);
  expect((await proj(page)).output.framingRect.x).toBe(800);
  await field("framing-y", 72);

  // Done: back to the real framing
  await page.getByTestId("framing-adjust").click();
  await expect(page.getByTestId("preview")).toHaveAttribute("data-framing-edit", "0");
  await expect(page.getByTestId("co-sel-framing")).toHaveCount(0);
  await expect(page.getByTestId("framing-dim")).toHaveCount(0);
  await settle();
  const c1 = await planInfo();
  expect(c1.crop).toEqual([800, 72, 200, 356]);
  expect(c1.screen).toEqual({ x: 0, y: 0, w: c1.W, h: c1.H });
  await shot(page, "framing-custom");

  // ---- export 2 s and compare the frame at 1.0 s with the preview of the same frame
  await seekFrame(30);
  const pv = await previewRgb();
  const pvRed = redCentroid({ w: pv.w, h: pv.h, rgb: Buffer.from(pv.rgb) });
  console.log("preview red", JSON.stringify(pvRed), pv.w, "x", pv.h);
  expect(pvRed).toBeTruthy();
  const mp4 = await exportMp4(page, dir);
  const ex = frameAt(mp4, 1.0);
  expect(ex.h).toBeGreaterThan(ex.w);
  expect(Math.abs(ex.w / ex.h - 9 / 16)).toBeLessThan(0.01);
  expect([ex.w, ex.h]).toEqual([pv.w, pv.h]);
  let sum = 0;
  for (let i = 0; i < ex.rgb.length; i++) sum += Math.abs(ex.rgb[i]! - pv.rgb[i]!);
  const meanDiff = sum / ex.rgb.length;
  const exRed = redCentroid(ex);
  console.log("export", ex.w, "x", ex.h, "mean |diff|", meanDiff.toFixed(2), "red", JSON.stringify(exRed));
  expect(meanDiff).toBeLessThanOrEqual(12);
  expect(exRed).toBeTruthy();
  expect(Math.abs(exRed!.x - pvRed!.x)).toBeLessThanOrEqual(0.04 * ex.w);
  expect(Math.abs(exRed!.y - pvRed!.y)).toBeLessThanOrEqual(0.04 * ex.h);

  // close what the export left open (dialog / progress sheet) before using the Inspector again
  await page.evaluate(() => { const s = (window as any).__lens.store; s.closeExportDialog(); s.closeExport(); });
  await page.keyboard.press("Escape");
  await shot(page, "framing-after-export");

  // ---- Reset: the centred window, still custom
  await page.getByTestId("framing-reset").click({ timeout: 20_000 });
  await settle();
  const rr = (await proj(page)).output.framingRect;
  expect(Math.abs(rr.x + rr.w / 2 - 640)).toBeLessThanOrEqual(1);
  expect(rr.h).toBe(720);
  await page.getByTestId("undo").click({ timeout: 20_000 });
  await expect.poll(async () => (await proj(page)).output.framingRect.x).toBe(800);
  await settle();

  // ---- saved and reopened
  await page.evaluate(() => (window as any).__lens.store.save());
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8")).output?.framing).toBe("custom");
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8")).output;
  expect(saved.framingRect).toEqual({ x: 800, y: 72, w: 200, h: 356 });
  await lens.close();
  const again = await openLens(dir, { w: 1600, h: 1000 });
  const crop2 = await again.page.evaluate(() => (window as any).__lens.store.get().plan.source.crop);
  expect(crop2).toEqual([800, 72, 200, 356]);
  await again.close();
});
