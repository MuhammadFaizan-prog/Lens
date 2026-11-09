/**
 * Responsive editor layout (Windows bugs #2, #3, #8, #11a).
 *
 * Bounds (set before the first run):
 *  - at 1280x720, 1366x768 and 1920x1080 @150 % (a 1280x720 CSS viewport at DPR 1.5):
 *    the preview area is >= 60 % of the stage (centre column) height;
 *    the page never scrolls sideways (scrollWidth <= innerWidth) and the top bar's last button ends
 *    inside the window;
 *    every timeline lane (Zoom ... Audio), scrolled into view in the timeline, is fully visible
 *    (no lane clipped: its top and bottom lie inside the timeline's scroll box) and its "+" is clickable.
 *  - F toggles preview fullscreen: the canvas gets >= 1.3x taller, and F again restores the size.
 *  - dragging the timeline splitter up by 80 px grows the timeline by 80 +- 2 px.
 */
import { test } from "@playwright/test";
import { expect, shot } from "./helpers";
import { closeAll, openLens, PACKAGED } from "./lensApp";
import { uxBundle } from "./uxHelpers";

test.afterAll(() => closeAll());

const SIZES = [
  { name: "1280x720", w: 1280, h: 720, dpr: 1 },
  { name: "1366x768", w: 1366, h: 768, dpr: 1 },
  { name: "1920x1080@150", w: 1280, h: 720, dpr: 1.5 },
];
const LANES = ["lane-zoom", "lane-cut", "lane-takes", "lane-speed", "lane-mask", "lane-annotation", "lane-caption", "lane-audio"];

for (const sz of SIZES) {
  test(`layout fits at ${sz.name}`, async () => {
    const lens = await openLens(uxBundle(`layout-${sz.name}`), { w: sz.w, h: sz.h, dpr: sz.dpr });
    const page = lens.page;
    console.log(PACKAGED ? "packaged app" : "web editor", await page.evaluate(() => devicePixelRatio));
    const m = await page.evaluate(() => {
      const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      const btns = [...document.querySelectorAll(".top-actions > *")].map((e) => e.getBoundingClientRect().right);
      return { stage: r('[data-testid="stage"]').height, area: r('[data-testid="preview-area"]').height, canvas: r('[data-testid="preview"]').height,
        scrollW: document.documentElement.scrollWidth, innerW: innerWidth, lastBtn: Math.max(...btns) };
    });
    console.log(sz.name, JSON.stringify(m), `preview/stage ${(m.area / m.stage).toFixed(3)} canvas/stage ${(m.canvas / m.stage).toFixed(3)}`);
    expect(m.area / m.stage).toBeGreaterThanOrEqual(0.6);
    expect(m.scrollW).toBeLessThanOrEqual(m.innerW);
    expect(m.lastBtn).toBeLessThanOrEqual(m.innerW);
    await shot(page, `layout-${sz.name}${PACKAGED ? "-app" : ""}`);
    for (const lane of LANES) {
      await page.getByTestId(lane).scrollIntoViewIfNeeded();
      const v = await page.evaluate((id) => {
        const body = document.querySelector(".timeline-body")!.getBoundingClientRect();
        const l = document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect();
        return { top: l.top, bottom: l.bottom, bt: body.top, bb: body.bottom };
      }, lane);
      expect(v.top, `${lane} top`).toBeGreaterThanOrEqual(v.bt - 0.5);
      expect(v.bottom, `${lane} bottom`).toBeLessThanOrEqual(v.bb + 0.5);
    }
    for (const add of ["add-zoom", "add-cut", "add-speed", "add-mask", "add-annotation", "add-caption", "add-audio"]) {
      await page.getByTestId(add).scrollIntoViewIfNeeded();
      await expect(page.getByTestId(add)).toBeVisible();
    }
    await shot(page, `layout-${sz.name}-scrolled${PACKAGED ? "-app" : ""}`);
    await lens.close();
  });
}

test("fullscreen toggles with F and the timeline splitter resizes", async () => {
  const lens = await openLens(uxBundle("fs"), { w: 1280, h: 720 });
  const page = lens.page;
  const h0 = (await page.getByTestId("preview").boundingBox())!.height;
  await page.locator("body").press("f");
  await expect(page.locator(".app")).toHaveAttribute("data-fullscreen", "1");
  await page.waitForTimeout(300);
  const h1 = (await page.getByTestId("preview").boundingBox())!.height;
  console.log("fullscreen canvas", h0, "->", h1);
  expect(h1).toBeGreaterThanOrEqual(h0 * 1.3);
  await shot(page, "fullscreen");
  await page.locator("body").press("f");
  await expect(page.locator(".app")).toHaveAttribute("data-fullscreen", "0");
  await page.waitForTimeout(300);
  const h2 = (await page.getByTestId("preview").boundingBox())!.height;
  expect(Math.abs(h2 - h0)).toBeLessThanOrEqual(1);
  // button too
  await page.getByTestId("fullscreen").click();
  await expect(page.locator(".app")).toHaveAttribute("data-fullscreen", "1");
  await page.getByTestId("fullscreen").click();
  await expect(page.locator(".app")).toHaveAttribute("data-fullscreen", "0");
  // splitter
  const tl0 = (await page.locator(".timeline").boundingBox())!.height;
  const sp = (await page.getByTestId("splitter-timeline").boundingBox())!;
  await page.mouse.move(sp.x + 300, sp.y + 2);
  await page.mouse.down();
  await page.mouse.move(sp.x + 300, sp.y - 40, { steps: 4 });
  await page.mouse.move(sp.x + 300, sp.y - 78, { steps: 4 });
  await page.mouse.up();
  const tl1 = (await page.locator(".timeline").boundingBox())!.height;
  console.log("timeline", tl0, "->", tl1);
  expect(Math.abs(tl1 - tl0 - 80)).toBeLessThanOrEqual(2);
  await lens.close();
});
