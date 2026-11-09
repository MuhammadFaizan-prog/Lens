/**
 * Manual zoom target (Windows bug #14): Z adds a zoom at the playhead, a click on the preview aims it
 * at a fixed point, the target rectangle drags; the export honours the target.
 * Bounds (set before the first run): after aiming at the sample's red marker (source 900, 250) the
 * stored focus is within 3 source px of it; in the exported frame (zoom settled) the crop centre,
 * measured from the marker's position, is within 2 source px of the stored focus; the scale is the
 * zoom's; dragging the rectangle by +100 output px moves the focus by +100 / k source px (+-2);
 * Follow cursor / Fixed point toggles the focus mode.
 */
import { test } from "@playwright/test";
import { expect, shot } from "./helpers";
import { closeAll, openLens, PACKAGED } from "./lensApp";
import { drag, editProject, exportMp4, frameAt, outToPage, proj, redCentroid, seekSrc, smallExport, srcToOut, uxBundle } from "./uxHelpers";

test.afterAll(() => closeAll());

test("fixed zoom target: aim on the preview, export crop centre within 2 px", async () => {
  const dir = uxBundle("zoom");
  const lens = await openLens(dir, { w: 1280, h: 720 });
  const page = lens.page;
  await smallExport(page, 3000);
  await seekSrc(page, 300);
  await page.locator("body").press("z");
  const p0 = await proj(page);
  expect(p0.zoom.segments).toHaveLength(1);
  // the zoom is selected: the preview shows the unzoomed frame, the next click aims it
  const target = { x: 900, y: 250 };
  const o = await srcToOut(page, target.x, target.y);
  const editFrame = await page.evaluate(() => { const s = (window as any).__lens.store.get(); return s.selection; });
  expect(editFrame.track).toBe("zoom");
  // srcToOut used the zoomed camera; aim through the unzoomed frame instead
  const ou = await page.evaluate(([x, y]: [number, number]) => {
    const s = (window as any).__lens.store.get();
    const f = s.plan.frames[s.frame];
    const [lx, ly, lw, lh] = f.layout.screen;
    return { x: lx + (x / 1280) * lw, y: ly + (y / 720) * lh };
  }, [target.x, target.y] as [number, number]);
  void o;
  const pg = await outToPage(page, ou.x, ou.y);
  await page.mouse.click(pg.x, pg.y);
  // stretch the zoom to 0.3..2.8 s so it settles before the measured frame
  await editProject(page, "Long zoom", "(p) => ({ ...p, zoom: { ...p.zoom, segments: p.zoom.segments.map((z) => ({ ...z, startMs: 300, endMs: 2900, scale: 2 })) } })");
  const z = (await proj(page)).zoom.segments[0];
  console.log("aimed focus", z.focus, "target", target);
  expect(z.focus).not.toBe("follow");
  expect(Math.hypot(z.focus.x - target.x, z.focus.y - target.y)).toBeLessThanOrEqual(3);
  await expect(page.getByTestId("co-sel-zoom")).toBeVisible();
  await shot(page, `zoom-rect${PACKAGED ? "-app" : ""}`);
  // export and measure the crop centre at 2.5 s from the marker
  const mp4 = await exportMp4(page, dir);
  const t = 2.5;
  const fr = await page.evaluate((tt) => { const s = (window as any).__lens.store.get(); const f = s.plan.frames[Math.round(tt * 30)]; return { lay: f.layout.screen, cam: f.cam }; }, t);
  const img = frameAt(mp4, t);
  const [lx, ly, lw, lh] = fr.lay;
  const m = redCentroid(img, lx, ly, lx + lw, ly + lh)!;
  expect(m, "marker visible").not.toBeNull();
  const scale = fr.cam[2];
  const k = (lw / 1280) * scale; // output px per source px
  const crop = { x: target.x + (lx + lw / 2 - m.x) / k, y: target.y + (ly + lh / 2 - m.y) / k };
  console.log("plan cam", fr.cam, "marker out", m, "crop centre (export)", crop, "focus", z.focus, "k", k.toFixed(3));
  expect(Math.abs(scale - 2)).toBeLessThan(0.01);
  expect(Math.abs(crop.x - z.focus.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(crop.y - z.focus.y)).toBeLessThanOrEqual(2);
  await lens.close();
});

test("zoom rectangle drags and the mode toggles", async () => {
  const lens = await openLens(uxBundle("zoomrect"), { w: 1280, h: 720 });
  const page = lens.page;
  await seekSrc(page, 300);
  await page.getByTestId("add-zoom").click();
  await page.keyboard.press("Escape"); // keep following the cursor for now
  await page.evaluate(() => (window as any).__lens.store.select({ track: "zoom", index: 0 }));
  await expect(page.getByTestId("sel-zoom-mode")).toBeVisible();
  expect((await proj(page)).zoom.segments[0].focus).toBe("follow");
  await page.getByTestId("sel-zoom-mode").getByText("Fixed point").click();
  const f0 = (await proj(page)).zoom.segments[0].focus;
  expect(f0).toEqual({ x: 640, y: 360 });
  const body = (await page.getByTestId("co-body").boundingBox())!;
  const W = await page.evaluate(() => (window as any).__lens.store.get().plan.output.width);
  const lw = await page.evaluate(() => { const s = (window as any).__lens.store.get(); return s.plan.frames[s.frame].layout.screen[2]; });
  const cssPerOut = (await page.getByTestId("preview").boundingBox())!.width / W;
  const c = { x: body.x + body.width / 2, y: body.y + body.height / 2 };
  await drag(page, c, { x: c.x + 100 * cssPerOut, y: c.y }, 10);
  const f1 = (await proj(page)).zoom.segments[0].focus;
  const expectDx = 100 / (lw / 1280);
  console.log("rect drag focus", f0, "->", f1, "expected dx", expectDx.toFixed(1));
  expect(Math.abs(f1.x - f0.x - expectDx)).toBeLessThanOrEqual(2);
  expect(Math.abs(f1.y - f0.y)).toBeLessThanOrEqual(2);
  await page.getByTestId("sel-zoom-mode").getByText("Follow cursor").click();
  expect((await proj(page)).zoom.segments[0].focus).toBe("follow");
  await lens.close();
});
