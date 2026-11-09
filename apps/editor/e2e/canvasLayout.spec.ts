/**
 * Canvas layout (feat/canvas-layout): aspect picker, screen card drag / corner resize, the Look tab's
 * Screen buttons and crop insets, undo, and the export.
 *
 * Bounds (set before the first run), on the 1280x720 UX sample (16:9 checkerboard, #203040 backdrop):
 *  - picking 9:16 in the toolbar makes the canvas 9:16 (|W/H - 9/16| < 0.01), card null, fit "fit",
 *    and the whole source is visible: source crop is the full 1280x720 and the frame's screen rect
 *    keeps the source aspect (within 1 %) and lies inside the canvas;
 *  - dragging the screen card 300 output px up moves project.card (y down by >= 0.15 of the canvas
 *    height, x within 0.02) and selects the screen;
 *  - dragging the SE corner handle in by (-120, -120) output px changes card w and h (each by >= 0.05);
 *  - Center: card x = (1 - w) / 2, y = (1 - h) / 2 (+-0.002), size kept; Fill: card = {0,0,1,1};
 *    Reset: card null and crop null;
 *  - Crop L = 100 sets project.crop {x 100, y 0, w 1180, h 720}; Undo puts crop back to null;
 *  - a 2 s export of a card dragged up is 9:16 (|w/h - 9/16| < 0.01, h > w); the frame's centre,
 *    where the fitted card sat, shows the backdrop (mean colour within 16 of #203040) and the moved
 *    card's centre does not (mean colour >= 40 from it).
 */
import { test } from "@playwright/test";
import { expect, shot } from "./helpers";
import { closeAll, openLens } from "./lensApp";
import { drag, exportMp4, frameAt, hexRgb, outToPage, proj, rgbDist, smallExport, uxBundle } from "./uxHelpers";

test.afterAll(() => closeAll());

type R = { x: number; y: number; w: number; h: number };

test("aspect picker, screen card move / resize / buttons / crop, undo and export", async () => {
  const dir = uxBundle("canvas-layout");
  const lens = await openLens(dir, { w: 1600, h: 1000 });
  const page = lens.page;
  const planInfo = () => page.evaluate(() => {
    const s = (window as any).__lens.store.get();
    const p = s.plan, f = p.frames[s.frame];
    const [x, y, w, h] = f.layout.screen;
    return { W: p.output.width, H: p.output.height, crop: p.source.crop as number[], screen: { x, y, w, h } };
  });
  const settle = () => page.waitForFunction(() => {
    const s = (window as any).__lens.state();
    const c = document.querySelector('[data-testid="preview"]') as HTMLCanvasElement | null;
    return !!c && c.dataset.frame === String(s.frame) && c.dataset.revision === String(s.revision);
  }, null, { timeout: 30_000 });

  // ---- 9:16 from the toolbar picker: canvas changes, nothing cropped
  await page.getByTestId("tb-aspect").selectOption("9:16");
  await expect.poll(async () => (await proj(page)).output.aspect).toBe("9:16");
  await settle();
  const a = await planInfo();
  const p0 = await proj(page);
  console.log("9:16", JSON.stringify(a), "card", p0.card, "fit", p0.output.fit);
  expect(Math.abs(a.W / a.H - 9 / 16)).toBeLessThan(0.01);
  expect(p0.card ?? null).toBeNull();
  expect(p0.output.fit).toBe("fit");
  expect(a.crop.slice(2)).toEqual([1280, 720]);
  expect(Math.abs(a.screen.w / a.screen.h / (1280 / 720) - 1)).toBeLessThan(0.01);
  expect(a.screen.x).toBeGreaterThanOrEqual(-0.5);
  expect(a.screen.y).toBeGreaterThanOrEqual(-0.5);
  expect(a.screen.x + a.screen.w).toBeLessThanOrEqual(a.W + 0.5);
  expect(a.screen.y + a.screen.h).toBeLessThanOrEqual(a.H + 0.5);
  await shot(page, "canvas-layout-916");

  // ---- drag the card up 300 output px
  const s0 = a.screen;
  const from = await outToPage(page, s0.x + s0.w / 2, s0.y + s0.h / 2);
  const to = await outToPage(page, s0.x + s0.w / 2, s0.y + s0.h / 2 - 300);
  await drag(page, from, to);
  await settle();
  const p1 = await proj(page);
  console.log("after drag card", JSON.stringify(p1.card));
  expect(p1.card).toBeTruthy();
  expect(s0.y / a.H - p1.card.y).toBeGreaterThanOrEqual(0.15);
  expect(Math.abs(p1.card.x - s0.x / a.W)).toBeLessThanOrEqual(0.02);
  await expect(page.getByTestId("co-sel-screen")).toBeVisible();

  // ---- corner resize (SE handle in by 120 px each way)
  const c1: R = { x: p1.card.x * a.W, y: p1.card.y * a.H, w: p1.card.w * a.W, h: p1.card.h * a.H };
  const hFrom = await outToPage(page, c1.x + c1.w, c1.y + c1.h);
  const hTo = await outToPage(page, c1.x + c1.w - 120, c1.y + c1.h - 120);
  await drag(page, hFrom, hTo);
  await settle();
  const p2 = await proj(page);
  console.log("after resize card", JSON.stringify(p2.card));
  expect(p1.card.w - p2.card.w).toBeGreaterThanOrEqual(0.05);
  expect(p1.card.h - p2.card.h).toBeGreaterThanOrEqual(0.05);
  await shot(page, "canvas-layout-resized");

  // ---- Center / Fill / Reset
  await page.getByTestId("screen-center").click();
  await settle();
  const p3 = await proj(page);
  console.log("center", JSON.stringify(p3.card));
  expect(Math.abs(p3.card.x - (1 - p3.card.w) / 2)).toBeLessThanOrEqual(0.002);
  expect(Math.abs(p3.card.y - (1 - p3.card.h) / 2)).toBeLessThanOrEqual(0.002);
  expect(Math.abs(p3.card.w - p2.card.w)).toBeLessThanOrEqual(0.002);
  expect(Math.abs(p3.card.h - p2.card.h)).toBeLessThanOrEqual(0.002);
  await page.getByTestId("screen-fill").click();
  await settle();
  expect((await proj(page)).card).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  await page.getByTestId("screen-reset").click();
  await settle();
  const p4 = await proj(page);
  expect(p4.card ?? null).toBeNull();
  expect(p4.crop ?? null).toBeNull();

  // ---- crop L field, then undo
  await page.getByTestId("screen-crop-mode").click();
  const l = page.getByTestId("crop-l");
  await l.fill("100");
  await l.press("Enter");
  await expect.poll(async () => (await proj(page)).crop).toEqual({ x: 100, y: 0, w: 1180, h: 720 });
  await settle();
  await shot(page, "canvas-layout-crop");
  await page.getByTestId("undo").click();
  await expect.poll(async () => (await proj(page)).crop ?? null).toBeNull();
  await settle();

  // ---- export a 2 s clip with the card dragged up
  const b = await planInfo();
  const sFrom = await outToPage(page, b.screen.x + b.screen.w / 2, b.screen.y + b.screen.h / 2);
  const sTo = await outToPage(page, b.screen.x + b.screen.w / 2, b.screen.y + b.screen.h / 2 - 380);
  await drag(page, sFrom, sTo);
  await settle();
  const card = (await proj(page)).card as R;
  console.log("export card", JSON.stringify(card));
  expect(card).toBeTruthy();
  expect(card.y + card.h).toBeLessThan(0.45); // the canvas centre is clear of the card
  await smallExport(page, 2000);
  const mp4 = await exportMp4(page, dir);
  const f = frameAt(mp4, 1.0);
  const bg = hexRgb("#203040");
  const meanBox = (cx: number, cy: number, r: number) => {
    const s = [0, 0, 0];
    let n = 0;
    for (let y = Math.round(cy - r); y <= Math.round(cy + r); y++)
      for (let x = Math.round(cx - r); x <= Math.round(cx + r); x++) {
        const i = (y * f.w + x) * 3;
        s[0] += f.rgb[i]!; s[1] += f.rgb[i + 1]!; s[2] += f.rgb[i + 2]!; n++;
      }
    return s.map((v) => v / n);
  };
  const centre = meanBox(f.w / 2, f.h / 2, 8);
  // the card's centre, nudged off the source's centre marker (none there; markers at 900,250 / 320,520)
  const cardMid = meanBox((card.x + card.w / 2) * f.w, (card.y + card.h / 2) * f.h, 8);
  console.log("export", f.w, "x", f.h, "centre", centre.map(Math.round), "card", cardMid.map(Math.round));
  expect(f.h).toBeGreaterThan(f.w);
  expect(Math.abs(f.w / f.h - 9 / 16)).toBeLessThan(0.01);
  expect(rgbDist(centre, bg)).toBeLessThanOrEqual(16);
  expect(rgbDist(cardMid, bg)).toBeGreaterThanOrEqual(40);
  await lens.close();
});
