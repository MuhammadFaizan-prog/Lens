/**
 * On-canvas manipulation (Windows bug #12): drag a blur from A to B on the preview, export, and the
 * export is blurred at B (and sharp at A). Also: arrow-key nudge, corner resize, caption drag.
 * Bounds (set before the first run): after the drag the mask's centre is within 6 source px of B;
 * in the exported frame the 8 px checkerboard's luma std-dev inside the mask at B is <= 25 (blurred)
 * and >= 80 at A (sharp; an unblurred checker is ~127); ArrowRight moves the mask by +1 output px
 * (+-0.6 source px at this scale), Shift+ArrowRight by +10; dragging the SE handle grows the mask;
 * dragging the caption up moves captions.style.y up and sets position custom.
 */
import { test } from "@playwright/test";
import { expect, shot } from "./helpers";
import { closeAll, openLens, PACKAGED } from "./lensApp";
import { drag, exportMp4, frameAt, lumaStd, outToPage, proj, seekSrc, smallExport, srcToOut, uxBundle } from "./uxHelpers";

test.afterAll(() => closeAll());

test("drag a blur from A to B and the export blurs at B", async () => {
  const dir = uxBundle("blur");
  const lens = await openLens(dir, { w: 1280, h: 720 });
  const page = lens.page;
  await smallExport(page, 2000);
  await seekSrc(page, 500);
  await page.getByTestId("add-mask").click();
  const m0 = (await proj(page)).masks[0];
  expect(m0.kind).toBe("blur");
  const A = { x: m0.rect.x + m0.rect.w / 2, y: m0.rect.y + m0.rect.h / 2 };
  const B = { x: 980, y: 160 }; // source px
  await page.keyboard.press("Escape");
  // click the mask on the canvas to select it, then drag its body from A to B
  const a = await srcToOut(page, A.x, A.y);
  const b = await srcToOut(page, B.x, B.y);
  const pa = await outToPage(page, a.x, a.y);
  await page.mouse.click(pa.x, pa.y);
  await expect(page.getByTestId("co-sel-mask")).toBeVisible();
  await drag(page, pa, await outToPage(page, b.x, b.y));
  const m1 = (await proj(page)).masks[0];
  const c1 = { x: m1.rect.x + m1.rect.w / 2, y: m1.rect.y + m1.rect.h / 2 };
  console.log("mask centre", A, "->", c1, "target", B);
  expect(Math.hypot(c1.x - B.x, c1.y - B.y)).toBeLessThanOrEqual(6);
  await shot(page, `blur-moved${PACKAGED ? "-app" : ""}`);
  // export: blurred at B, sharp at A (frame at 1.0 s, mask fully faded in)
  const mp4 = await exportMp4(page, dir);
  const f = frameAt(mp4, 1.0);
  const sc = await page.evaluate(() => { const s = (window as any).__lens.store.get(); const fr = s.plan.frames[30]; return { lay: fr.layout.screen, cam: fr.cam }; });
  const [lx, ly, lw, lh] = sc.lay;
  const k = lw / 1280; // camera at 1x
  const box = (c: { x: number; y: number }, hw: number, hh: number) => [lx + (c.x - hw) * k, ly + (c.y - hh) * k, lx + (c.x + hw) * k, ly + (c.y + hh) * k] as const;
  const atB = lumaStd(f, ...box(c1, m1.rect.w / 2 - 24, m1.rect.h / 2 - 24));
  const atA = lumaStd(f, ...box(A, m0.rect.w / 2 - 24, m0.rect.h / 2 - 24));
  console.log(`export luma std: at B ${atB.toFixed(1)} (blurred), at A ${atA.toFixed(1)} (sharp)`);
  expect(atB).toBeLessThanOrEqual(25);
  expect(atA).toBeGreaterThanOrEqual(80);
  await lens.close();
});

test("nudge, resize and caption drag on the canvas", async () => {
  const lens = await openLens(uxBundle("nudge"), { w: 1280, h: 720 });
  const page = lens.page;
  await seekSrc(page, 500);
  await page.getByTestId("add-mask").click();
  await page.keyboard.press("Escape");
  const m0 = (await proj(page)).masks[0];
  const o = await srcToOut(page, m0.rect.x + m0.rect.w / 2, m0.rect.y + m0.rect.h / 2);
  const p = await outToPage(page, o.x, o.y);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.press("ArrowRight");
  const m1 = (await proj(page)).masks[0];
  const W = await page.evaluate(() => (window as any).__lens.store.get().plan.output.width);
  const lw = await page.evaluate(() => (window as any).__lens.store.get().plan.frames[0].layout.screen[2]);
  const onePx = 1280 / lw; // source px per output px
  console.log("nudge +1 output px:", m1.rect.x - m0.rect.x, "source px (expected", onePx.toFixed(2), ") output width", W);
  expect(Math.abs(m1.rect.x - m0.rect.x - onePx)).toBeLessThanOrEqual(0.6);
  await page.keyboard.press("Shift+ArrowRight");
  const m2 = (await proj(page)).masks[0];
  expect(Math.abs(m2.rect.x - m1.rect.x - 10 * onePx)).toBeLessThanOrEqual(0.6);
  // the frame step keys still step frames once the pointer goes elsewhere
  // resize from the SE handle
  const h = (await page.getByTestId("co-handle-se").boundingBox())!;
  await drag(page, { x: h.x + h.width / 2, y: h.y + h.height / 2 }, { x: h.x + 60, y: h.y + 40 });
  const m3 = (await proj(page)).masks[0];
  console.log("resize", m2.rect, "->", m3.rect);
  expect(m3.rect.w).toBeGreaterThan(m2.rect.w + 40);
  expect(m3.rect.h).toBeGreaterThan(m2.rect.h + 20);
  expect(m3.rect.x).toBe(m2.rect.x);
  // a hand-written caption, dragged up on the canvas
  await page.getByTestId("add-caption").click();
  await page.keyboard.press("Escape");
  await seekSrc(page, 1200);
  const cap = await page.evaluate(() => { const s = (window as any).__lens.store.get(); return s.plan.frames[s.frame].caption; });
  expect(cap).not.toBeNull();
  const y0 = (await proj(page)).captions.style.y;
  const H = await page.evaluate(() => (window as any).__lens.store.get().plan.output.height);
  const cp = await outToPage(page, W / 2, H * 0.9);
  await page.mouse.click(cp.x, cp.y);
  await expect(page.getByTestId("co-sel-caption")).toBeVisible();
  const body = (await page.getByTestId("co-body").boundingBox())!;
  await drag(page, { x: body.x + body.width / 2, y: body.y + body.height / 2 }, { x: body.x + body.width / 2, y: body.y + body.height / 2 - 120 });
  const st = (await proj(page)).captions.style;
  console.log("caption y", y0, "->", st.y, st.position);
  expect(st.position).toBe("custom");
  expect(st.y).toBeLessThan(0.8);
  await shot(page, `canvas-edit${PACKAGED ? "-app" : ""}`);
  await lens.close();
});
