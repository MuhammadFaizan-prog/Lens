/**
 * Resizable panes (Windows v0.1.3 report: "i cant shrink or grow this window left or right", the
 * timeline lane names were cut to "A…").
 *
 * Bounds (set before the first run):
 *  - dragging the lane-header handle +80 px grows the column by 80 +- 2 px; afterwards neither the
 *    "Audio" nor the "Annotations" name is truncated (scrollWidth <= clientWidth);
 *  - at the default width (200 px) no lane name is truncated;
 *  - the column never goes below 90 px or above 320 px; at 90 px every name still shows >= 24 px and
 *    every "+" sits inside the column and takes a click; right-click on a name opens the lane menu;
 *    double-click resets the default;
 *  - after the resize a click on the ruler at 40 % of the timeline seeks to 40 % of the recording
 *    (+- 1.5 frames), and a block dragged +100 px (Alt: no snapping) moves by 100 px of time (+- 2 px);
 *  - a reload keeps the column width;
 *  - dragging the Inspector splitter 80 px left grows the Inspector by 80 +- 2 px and the preview
 *    canvas reflows (its box changes); the width survives a reload; double-click resets it.
 */
import { test, type Page } from "@playwright/test";
import { expect, openEditor, shot, state } from "./helpers";

const width = async (page: Page, testId: string) => (await page.getByTestId(testId).boundingBox())!.width;
const truncated = (page: Page, kind: string) =>
  page.getByTestId(`lane-name-${kind}`).evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth, cut: e.scrollWidth > e.clientWidth }));

/** A point on the lane-header handle inside the visible timeline (the body scrolls vertically). */
async function handlePoint(page: Page) {
  await page.evaluate(() => ((document.querySelector(".timeline-body") as HTMLElement).scrollTop = 0));
  const h = (await page.getByTestId("tl-labels-resizer").boundingBox())!;
  const body = (await page.locator(".timeline-body").boundingBox())!;
  return { x: h.x + h.width / 2, y: Math.max(h.y, body.y) + 40 };
}

async function drag(page: Page, x: number, y: number, dx: number, steps = 8): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(x + (dx * i) / steps, y);
  await page.mouse.up();
}

/** Pixels per second of the timeline, from the inner track width (innerW = dur * pps + 24). */
async function geometry(page: Page) {
  return page.evaluate(() => {
    const st = (window as any).__lens.store.get();
    const dur = st.bundle.meta.durationMs as number;
    const inner = document.querySelector(".tl-inner") as HTMLElement;
    const sc = document.querySelector('[data-testid="timeline-scroll"]') as HTMLElement;
    const innerW = inner.getBoundingClientRect().width;
    return { dur, innerW, pps: (innerW - 24) / (dur / 1000), scLeft: sc.getBoundingClientRect().left, scroll: sc.scrollLeft, fps: st.plan.output.fps as number };
  });
}

test("lane-header column and Inspector resize, remember their width, and keep the timeline math aligned", async ({ page }) => {
  await openEditor(page);
  const w0 = await width(page, "tl-labels");
  console.log("default label column", w0, "annotations", JSON.stringify(await truncated(page, "annotation")), "audio", JSON.stringify(await truncated(page, "audio")));
  // the default already fits the longest name (it was cut to "A…" at the old fixed 132 px)
  expect((await truncated(page, "annotation")).cut, "Annotations truncated at the default width").toBe(false);

  // ---- +80 px
  let hp = await handlePoint(page);
  await drag(page, hp.x, hp.y, 80);
  const w1 = await width(page, "tl-labels");
  console.log("label column", w0, "->", w1);
  expect(Math.abs(w1 - w0 - 80)).toBeLessThanOrEqual(2);
  for (const k of ["audio", "annotation", "takes", "motion3d", "mask", "speed"]) {
    const t = await truncated(page, k);
    expect(t.cut, `${k} name truncated (${t.sw} > ${t.cw})`).toBe(false);
  }
  await expect(page.getByTestId("tl-label-audio")).toHaveAttribute("title", "Audio");
  await shot(page, "resize-panes-labels-wide");

  // ---- ruler click seeks to the right time after the resize
  let g = await geometry(page);
  const ruler = (await page.locator(".tl-ruler").boundingBox())!;
  const want = g.dur * 0.4;
  const rx = g.scLeft - g.scroll + (want / 1000) * g.pps;
  await page.mouse.click(rx, ruler.y + ruler.height / 2);
  await page.waitForTimeout(150);
  const src = (await state(page)).src;
  console.log("ruler seek", { want, src, pps: g.pps, frameMs: 1000 / g.fps });
  expect(Math.abs(src - want)).toBeLessThanOrEqual(1.5 * (1000 / g.fps));
  // the playhead sits at the seeked frame's time, on the same x scale as the ruler (the seek lands on
  // a frame, so it can be up to one frame of pixels from the click)
  const ph = (await page.getByTestId("playhead").boundingBox())!;
  const phx = ph.x + ph.width / 2;
  expect(Math.abs(phx - (g.scLeft - g.scroll + (src / 1000) * g.pps))).toBeLessThanOrEqual(1.5);
  expect(Math.abs(phx - rx)).toBeLessThanOrEqual((1000 / g.fps / 1000) * g.pps * 1.5 + 1.5);

  // ---- a block dragged +100 px moves by 100 px of time
  await page.getByTestId("lane-speed").scrollIntoViewIfNeeded();
  const sl = (await page.getByTestId("lane-speed").boundingBox())!;
  await page.mouse.dblclick(sl.x + sl.width * 0.2, sl.y + sl.height / 2);
  const blk = page.getByTestId("block-speed-0");
  await expect(blk).toBeVisible();
  const s0 = Number(await blk.getAttribute("data-start"));
  const bb = (await blk.boundingBox())!;
  g = await geometry(page);
  await page.keyboard.down("Alt");
  await drag(page, bb.x + bb.width / 2, bb.y + bb.height / 2, 100, 10);
  await page.keyboard.up("Alt");
  const s1 = Number(await blk.getAttribute("data-start"));
  const movedPx = ((s1 - s0) / 1000) * g.pps;
  console.log("block drag", { s0, s1, movedPx });
  expect(Math.abs(movedPx - 100)).toBeLessThanOrEqual(2);
  // the block's box followed the mouse too
  const bb1 = (await blk.boundingBox())!;
  expect(Math.abs(bb1.x - bb.x - 100)).toBeLessThanOrEqual(2);

  // ---- clamps: far left -> 90, far right -> 320
  hp = await handlePoint(page);
  await drag(page, hp.x, hp.y, -600);
  expect(Math.round(await width(page, "tl-labels"))).toBe(90);
  // narrow: every name still shows its start and every "+" stays inside the column and takes a click
  const col = (await page.getByTestId("tl-labels").boundingBox())!;
  for (const k of ["zoom", "cut", "takes", "speed", "motion3d", "mask", "annotation", "caption", "audio"]) {
    const nw = await page.getByTestId(`lane-name-${k}`).evaluate((e) => e.clientWidth);
    expect(nw, `${k} name width at 90 px`).toBeGreaterThanOrEqual(24);
    if (k === "takes") continue;
    const add = page.getByTestId(`add-${k}`);
    await add.scrollIntoViewIfNeeded();
    const ab = (await add.boundingBox())!;
    expect(ab.x + ab.width, `add-${k} inside the column`).toBeLessThanOrEqual(col.x + col.width + 0.5);
    await add.click({ trial: true });
  }
  // the lane menu is still reachable on a right-click of the name
  await page.getByTestId("tl-label-speed").click({ button: "right" });
  await expect(page.getByTestId("lane-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await shot(page, "resize-panes-labels-narrow");
  hp = await handlePoint(page);
  await drag(page, hp.x, hp.y, 800);
  expect(Math.round(await width(page, "tl-labels"))).toBe(320);
  // back to +80 for the reload check
  hp = await handlePoint(page);
  await drag(page, hp.x, hp.y, w1 - 320);
  expect(Math.abs((await width(page, "tl-labels")) - w1)).toBeLessThanOrEqual(1);

  // ---- Inspector: splitter 80 px to the left grows it, the preview reflows
  const i0 = await width(page, "inspector");
  const p0 = (await page.getByTestId("preview").boundingBox())!;
  const sp = (await page.getByTestId("splitter-right").boundingBox())!;
  await drag(page, sp.x + sp.width / 2, sp.y + 200, -80);
  await page.waitForTimeout(200);
  const i1 = await width(page, "inspector");
  const p1 = (await page.getByTestId("preview").boundingBox())!;
  console.log("inspector", i0, "->", i1, "preview", JSON.stringify(p0), "->", JSON.stringify(p1));
  expect(Math.abs(i1 - i0 - 80)).toBeLessThanOrEqual(2);
  expect(Math.abs(p1.x - p0.x) + Math.abs(p1.width - p0.width)).toBeGreaterThan(1);
  await shot(page, "resize-panes-inspector");

  // ---- reload keeps both widths
  await page.reload();
  await page.waitForFunction(() => (window as any).__lens?.state().status === "ready", null, { timeout: 90_000 });
  expect(Math.abs((await width(page, "tl-labels")) - w1)).toBeLessThanOrEqual(1);
  expect(Math.abs((await width(page, "inspector")) - i1)).toBeLessThanOrEqual(1);

  // ---- double-click resets both defaults (the Inspector stays open)
  await page.getByTestId("tl-labels-resizer").dblclick();
  expect(Math.abs((await width(page, "tl-labels")) - w0)).toBeLessThanOrEqual(1);
  await page.getByTestId("splitter-right").dblclick();
  await expect(page.getByTestId("inspector")).toBeVisible();
  expect(Math.abs((await width(page, "inspector")) - i0)).toBeLessThanOrEqual(1);
});
