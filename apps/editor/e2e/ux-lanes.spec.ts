/**
 * Every lane "+" and every annotation tool creates an item (Windows bug #13), in the packaged app when
 * LENS_PACKAGED_APP is set (playwright.app.config.ts).
 * Bounds (set before the first run): each lane "+" (Zoom, Cuts, Speed, Masks, Annotations, Captions,
 * Audio) adds exactly one item to its list, also when the playhead already sits inside an item of that
 * lane; Z adds a zoom; each toolbar tool (arrow, box, ellipse, text, callout, step badge) adds exactly
 * one annotation of its kind by a drag on the preview; "+ Text slide" adds a slide.
 */
import { test } from "@playwright/test";
import { expect, shot } from "./helpers";
import { closeAll, openLens, PACKAGED } from "./lensApp";
import { drag, outToPage, proj, seekSrc, uxBundle } from "./uxHelpers";

test.afterAll(() => closeAll());

const COUNT: Record<string, (p: any) => number> = {
  zoom: (p) => p.zoom.segments.length,
  cut: (p) => p.edits.cuts.length,
  speed: (p) => p.edits.speed.length,
  mask: (p) => p.masks.length,
  annotation: (p) => p.annotations.length,
  caption: (p) => (p.captions.cues ?? []).length,
  audio: (p) => p.overrides.filter((o: any) => o.volume !== undefined).length,
};

test("every lane + creates an item", async () => {
  const lens = await openLens(uxBundle("lanes"), { w: 1280, h: 720 });
  const page = lens.page;
  console.log(PACKAGED ? "packaged app" : "web editor");
  for (const t of [1000, 1500]) {
    // the second round starts inside the blocks the first one made
    await seekSrc(page, t);
    for (const k of Object.keys(COUNT)) {
      const before = COUNT[k]!(await proj(page));
      await page.getByTestId(`add-${k}`).scrollIntoViewIfNeeded();
      await page.getByTestId(`add-${k}`).click();
      if (k === "zoom") await page.keyboard.press("Escape"); // leave the aim-on-click mode
      await page.waitForTimeout(150);
      const after = COUNT[k]!(await proj(page));
      console.log(`+ ${k} @${t}: ${before} -> ${after}`);
      expect(after, `+ ${k} at ${t} ms`).toBe(before + 1);
    }
  }
  const z0 = COUNT.zoom!(await proj(page));
  await seekSrc(page, 4500);
  await page.locator("body").press("z");
  await page.keyboard.press("Escape");
  expect(COUNT.zoom!(await proj(page))).toBe(z0 + 1);
  await shot(page, `lanes${PACKAGED ? "-app" : ""}`);
  await lens.close();
});

test("every annotation tool creates its item", async () => {
  const lens = await openLens(uxBundle("tools"), { w: 1280, h: 720 });
  const page = lens.page;
  await seekSrc(page, 2000);
  const W = await page.evaluate(() => (window as any).__lens.store.get().plan.output.width);
  const H = await page.evaluate(() => (window as any).__lens.store.get().plan.output.height);
  const kinds: Array<[string, string]> = [["arrow", "arrow"], ["rect", "rect"], ["ellipse", "ellipse"], ["text", "text"], ["callout", "callout"], ["badge", "badge"]];
  let i = 0;
  for (const [tool, kind] of kinds) {
    const before = (await proj(page)).annotations.length;
    await page.getByTestId(`tool-${tool}`).click();
    const a = await outToPage(page, W * (0.15 + 0.12 * i), H * 0.3);
    const b = await outToPage(page, W * (0.15 + 0.12 * i) + 60, H * 0.3 + 50);
    await drag(page, a, b);
    await page.keyboard.press("Escape"); // leave inline text editing
    const p = await proj(page);
    console.log(`tool ${tool}: ${before} -> ${p.annotations.length} (${p.annotations[p.annotations.length - 1]?.kind})`);
    expect(p.annotations.length, tool).toBe(before + 1);
    expect(p.annotations[p.annotations.length - 1].kind).toBe(kind);
    i++;
  }
  const s0 = (await proj(page)).slides.length;
  await page.getByTestId("add-slide").click();
  expect((await proj(page)).slides.length).toBe(s0 + 1);
  await shot(page, `tools${PACKAGED ? "-app" : ""}`);
  await lens.close();
});
