/**
 * Preview fills the stage and 9:16 crops in and follows (Windows bugs #2 and #8).
 * Bounds (set before the first run): at 1280x720 the 16:9 preview canvas is >= 60 % of the stage
 * height or its width is >= 95 % of the preview area width; with 9:16 the canvas fills the preview
 * area height (>= 97 %); 9:16 Fill: the screen rect is the full output height on every frame and the
 * exported frame's top and bottom rows show recording (checkerboard), not the backdrop; the crop
 * follows the cursor (the sample cursor moves right: the screen x at 5 s is >= 100 output px left of
 * the x at 0.5 s); 9:16 Fit keeps the backdrop above and below; the Social Vertical preset selects Fill;
 * 100% shows one output px per device px.
 */
import { test } from "@playwright/test";
import { expect, shot } from "./helpers";
import { closeAll, openLens, PACKAGED } from "./lensApp";
import { editProject, exportMp4, frameAt, hexRgb, px, rgbDist, seekSrc, smallExport, uxBundle } from "./uxHelpers";

test.afterAll(() => closeAll());

test("preview fills the stage; 9:16 fill follows the cursor, fit is kept", async () => {
  const dir = uxBundle("vertical");
  const lens = await openLens(dir, { w: 1280, h: 720 });
  const page = lens.page;
  const m = async () => page.evaluate(() => {
    const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
    return { stage: r('[data-testid="stage"]').height, areaH: r('[data-testid="preview-area"]').height, areaW: r('[data-testid="preview-area"]').width, cw: r('[data-testid="preview"]').width, ch: r('[data-testid="preview"]').height };
  });
  const a = await m();
  console.log("16:9", a);
  expect(a.ch / a.stage >= 0.6 || a.cw / a.areaW >= 0.95).toBe(true);
  await editProject(page, "9:16", '(p) => ({ ...p, output: { ...p.output, aspect: "9:16", fit: "fill" } })');
  await seekSrc(page, 500);
  const b = await m();
  console.log("9:16", b);
  expect(b.ch / b.areaH).toBeGreaterThanOrEqual(0.97);
  const plan = await page.evaluate(() => { const p = (window as any).__lens.store.get().plan; return { fps: p.output.fps, H: p.output.height, W: p.output.width, xs: p.frames.map((f: any) => f.layout.screen[0]), hs: p.frames.map((f: any) => f.layout.screen[3]) }; });
  expect(Math.min(...plan.hs)).toBeGreaterThanOrEqual(plan.H - 1);
  const x05 = plan.xs[Math.round(0.5 * plan.fps)], x5 = plan.xs[Math.round(5 * plan.fps)];
  console.log("fill screen x at 0.5 s", x05, "at 5 s", x5);
  expect(x05 - x5).toBeGreaterThanOrEqual(100);
  await shot(page, `vertical-fill${PACKAGED ? "-app" : ""}`);
  await smallExport(page, 2000);
  const mp4 = await exportMp4(page, dir);
  const f = frameAt(mp4, 1.0);
  await page.evaluate(() => (window as any).__lens.store.closeExport()); // the sheet would cover the 100% button
  const bg = hexRgb("#203040");
  let bgRows = 0;
  for (const y of [1, 2, f.h - 2, f.h - 3]) for (let x = 4; x < f.w; x += 16) if (rgbDist(px(f, x, y), bg) < 12) bgRows++;
  console.log("fill export", f.w, "x", f.h, "backdrop pixels on top/bottom rows", bgRows);
  expect(f.h).toBeGreaterThan(f.w);
  expect(bgRows).toBe(0);
  // Fit: backdrop above and below
  await editProject(page, "Fit", '(p) => ({ ...p, output: { ...p.output, fit: "fit" } })');
  const fit = await page.evaluate(() => { const p = (window as any).__lens.store.get().plan; return p.frames[0].layout.screen; });
  expect(fit[3]).toBeLessThan(fit[2]); // letterboxed 16:9 inside 9:16
  await shot(page, `vertical-fit${PACKAGED ? "-app" : ""}`);
  // Social Vertical preset selects fill
  await page.evaluate(() => { const s = (window as any).__lens.store; s.applyStylePreset("social-vertical"); });
  expect(await page.evaluate(() => (window as any).__lens.store.get().project.output.fit)).toBe("fill");
  // 100 %
  await page.getByTestId("preview-zoom-100").click();
  const c100 = await page.evaluate(() => { const c = document.querySelector('[data-testid="preview"]') as HTMLCanvasElement; return { css: c.getBoundingClientRect().width * devicePixelRatio, w: c.width }; });
  expect(Math.abs(c100.css - c100.w)).toBeLessThanOrEqual(2);
  await lens.close();
});
