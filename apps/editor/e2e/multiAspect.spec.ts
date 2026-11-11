/**
 * One recording -> 16:9 + 9:16 + 1:1 + 4:5 in one batch (demand #15, docs/MultiAspect.md), through the
 * UI, on the 1280x720 UX sample (checkerboard, red markers at (900, 250) and (320, 520), cursor drawn,
 * moving right at 120 px/s), 360p30, the first 2 s, a fixed-focus 1.6x zoom on (900, 250) 0.6-1.5 s.
 *
 * Bounds (set before the first run, not to be loosened):
 *  1. Turning on several sizes leaves the shown plan identical (JSON equal) to the plan before.
 *  2. Batch export writes one MP4 per size; ffprobe width x height exactly 640x360 (16:9 Fit),
 *     360x640 (9:16 Follow), 360x360 (1:1 Custom, two crop keys), 360x450 (4:5 Follow); each has the
 *     plan's frame count (60).
 *  3. Framed subject (export pixels): in every export at 1.2 s and 1.4 s (inside the zoom) the zoom
 *     target's red dot is found, its centroid at least 3 % of the frame size inside every edge and within
 *     4 % of the frame size of where the plan maps (900, 250). (1:1 is keyed on marker windows, see 5.)
 *  4. Framed subject (plan geometry): in the two Follow sizes the cursor's output position is inside
 *     the frame on every frame (the cursor is not red, so this is the plan's mapping, not pixels).
 *  5. Crop keys (1:1 Custom): key at 0.1 s on a 300x300 window centred on (320, 520), key at 1.9 s on
 *     one centred on (900, 250); the export at 0.1 s and 1.9 s shows a red dot within 4 % of the frame
 *     size of the canvas centre; the key list shows 2 keys; the window at 1.0 s lies between the keys.
 *  6. Preview vs export: per size, the preview of the frame at 1.2 s vs the export frame at 1.2 s, mean
 *     absolute difference <= 12 per channel over every pixel.
 *  7. Saved project.json carries exportTargets with 4 items; the 1:1 item has framing custom and 2
 *     framingKeys after switching back to 16:9.
 *  8. (added with the Follow fix) Batch Cancel while the first size is running: the export ends as
 *     "Export cancelled" within 30 s, stays so 4 s later, no other size's export folder appears after
 *     Cancel, and the cancelled size's server job is neither running nor done.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import { expect, shot } from "./helpers";
import { closeAll, openLens } from "./lensApp";
import { editProject, EXPORT_PATH, frameAt, proj, redCentroid, smallExport, uxBundle } from "./uxHelpers";

test.afterAll(() => closeAll());

const SIZES = [
  { aspect: "16:9", tid: "16x9", w: 640, h: 360, framing: "fit" },
  { aspect: "9:16", tid: "9x16", w: 360, h: 640, framing: "follow" },
  { aspect: "1:1", tid: "1x1", w: 360, h: 360, framing: "custom" },
  { aspect: "4:5", tid: "4x5", w: 360, h: 450, framing: "follow" },
];

test("several sizes: one batch, exact sizes, subject in frame, crop keys, preview = export", async () => {
  test.setTimeout(900_000);
  const dir = uxBundle("multiaspect", { cursor: { visible: true, clickEffect: "none" } });
  const lens = await openLens(dir, { w: 1600, h: 1000 });
  const page = lens.page;
  const settle = () => page.waitForFunction(() => {
    const s = (window as any).__lens.state();
    const c = document.querySelector('[data-testid="preview"]') as HTMLCanvasElement | null;
    return !!c && c.dataset.frame === String(s.frame) && c.dataset.revision === String(s.revision);
  }, null, { timeout: 30_000 });
  const seekSrc = async (ms: number) => {
    await page.evaluate((t) => (window as any).__lens.store.seekSource(t), ms);
    await settle();
  };
  const previewRgb = () => page.evaluate(() => {
    const c = document.querySelector('[data-testid="preview"]') as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    const rgb: number[] = new Array((d.length / 4) * 3);
    for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { rgb[j] = d[i]!; rgb[j + 1] = d[i + 1]!; rgb[j + 2] = d[i + 2]!; }
    return { w: c.width, h: c.height, rgb };
  });
  /** Output px of source point (x, y) at the plan frame nearest output time t (the shown size's plan). */
  const mapAt = (t: number, x: number, y: number) => page.evaluate(([t, x, y]) => {
    const plan = (window as any).__lens.store.get().plan;
    const f = plan.frames[Math.round((t * plan.output.fps) / 1000)];
    const [cropX, cropY, srcW, srcH] = plan.source.crop;
    const [cx, cy, sc] = f.cam;
    const [lx, ly, lw, lh] = f.layout.screen;
    const vw = srcW / sc, vh = srcH / sc;
    return { x: lx + (x - cropX - (cx - vw / 2)) * (lw / vw), y: ly + (y - cropY - (cy - vh / 2)) * (lh / vh) };
  }, [t, x, y] as [number, number, number]);

  await smallExport(page, 2000);
  await editProject(page, "Zoom on marker", `(p) => ({ ...p, zoom: { ...p.zoom, auto: false, segments: [{ id: "zm", startMs: 600, endMs: 1500, scale: 1.6, focus: { x: 900, y: 250 }, style: "classic", auto: false }] } })`);
  await settle();
  const planBefore = await page.evaluate(() => JSON.stringify((window as any).__lens.store.get().plan));

  // ---- the Export dialog: Several sizes
  await page.getByTestId("export-dialog-open").click();
  await page.getByTestId("export-tab-video").click();
  await page.getByTestId("sizes-enable").click();
  await expect(page.getByTestId("size-16x9")).toBeVisible();
  for (const s of SIZES) await expect(page.getByTestId(`size-${s.tid}`)).toContainText(`${s.w}×${s.h}`);
  await settle();
  const planAfter = await page.evaluate(() => JSON.stringify((window as any).__lens.store.get().plan));
  expect(planAfter === planBefore).toBe(true); // bound 1
  await expect(page.getByTestId("size-framing-9x16")).toHaveValue("follow");
  await expect(page.getByTestId("size-framing-4x5")).toHaveValue("follow");
  await expect(page.getByTestId("size-framing-16x9")).toHaveValue("fit");
  await page.getByTestId("size-framing-1x1").selectOption("custom");
  await shot(page, "multiaspect-sizes");

  // ---- 1:1 Custom with two crop keys (Look > Screen framing panel)
  await page.getByTestId("size-show-1x1").click();
  await expect(page.getByTestId("tb-target")).toHaveValue("t1x1");
  expect((await proj(page)).output.aspect).toBe("1:1");
  await page.getByTestId("tab-look").click();
  await expect(page.getByTestId("framing-custom-panel")).toBeVisible();
  const field = async (id: string, v: number) => {
    const el = page.getByTestId(id);
    await el.fill(String(v));
    await el.press("Enter");
    await settle();
  };
  await seekSrc(100);
  await page.getByTestId("framing-key-add").click();
  await settle();
  await field("framing-w", 300);
  await field("framing-x", 170);
  await field("framing-y", 370);
  await seekSrc(1900);
  await page.getByTestId("framing-key-add").click();
  await settle();
  await field("framing-x", 750);
  await field("framing-y", 100);
  await expect(page.getByTestId("framing-key")).toHaveCount(2);
  const keys = (await proj(page)).output.framingKeys;
  console.log("keys", JSON.stringify(keys));
  expect(keys.map((k: any) => k.srcMs)).toEqual([100, 1900]);
  expect(keys[0].rect).toEqual({ x: 170, y: 370, w: 300, h: 300 });
  expect(keys[1].rect).toEqual({ x: 750, y: 100, w: 300, h: 300 });
  // the window at 1.0 s lies between the keys (centre x between 320 and 900)
  await seekSrc(1000);
  const midX = Number(await page.getByTestId("framing-x").inputValue()) + 150;
  console.log("window centre x at 1.0 s", midX);
  expect(midX).toBeGreaterThan(320);
  expect(midX).toBeLessThan(900);
  await shot(page, "multiaspect-keys");

  // ---- preview of each size at 1.2 s (and its plan mappings), before the batch
  const pv: Record<string, { w: number; h: number; rgb: number[] }> = {};
  const want: Record<string, Record<string, { x: number; y: number }>> = {};
  const cursorOut: Record<string, number> = {};
  for (const s of SIZES) {
    await page.getByTestId("tb-target").selectOption(`t${s.tid}`);
    await expect.poll(async () => (await proj(page)).output.aspect).toBe(s.aspect);
    await seekSrc(1200);
    pv[s.tid] = await previewRgb();
    expect([pv[s.tid]!.w, pv[s.tid]!.h]).toEqual([s.w, s.h]);
    want[s.tid] = { "1200": await mapAt(1200, 900, 250), "1400": await mapAt(1400, 900, 250) };
    if (s.framing === "follow") {
      // bound 4: the cursor's output position on every frame
      cursorOut[s.tid] = await page.evaluate(() => {
        const plan = (window as any).__lens.store.get().plan;
        const [cropX, cropY, srcW, srcH] = plan.source.crop;
        let outside = 0;
        for (const f of plan.frames) {
          if (!f.cur) continue;
          const [cx, cy, sc] = f.cam;
          const [lx, ly, lw, lh] = f.layout.screen;
          const vw = srcW / sc, vh = srcH / sc;
          const x = lx + (f.cur[0] - (cx - vw / 2)) * (lw / vw);
          const y = ly + (f.cur[1] - (cy - vh / 2)) * (lh / vh);
          const zx = lx + (900 - (cx - vw / 2)) * (lw / vw), zy = ly + (250 - (cy - vh / 2)) * (lh / vh);
          const zin = zx >= 0 && zy >= 0 && zx <= plan.output.width && zy <= plan.output.height;
          if (x < 0 || y < 0 || x > plan.output.width || y > plan.output.height) { outside++; (window as any).__outLog = ((window as any).__outLog ?? "") + ` ${Math.round(f.src)}${zin ? "Z" : "-"}`; }
        }
        return outside + (plan.frames.every((f: any) => f.cur) ? 0 : 1000);
      });
    }
  }
  console.log("plan map of (900,250)", JSON.stringify(want), "cursor frames outside", JSON.stringify(cursorOut), "frames (src ms, Z = zoom target inside):", await page.evaluate(() => (window as any).__outLog));
  // hard again (the product was fixed: Follow keeps the cursor and the zoom target in frame, widening
  // when both do not fit; engine followFrame). The first run failed here (9:16 31 / 60, 4:5 29 / 60).
  for (const v of Object.values(cursorOut)) expect(v).toBe(0);

  // ---- batch export from the toolbar (shown: 4:5)
  await expect(page.getByTestId("export")).toContainText("4 sizes");
  await page.getByTestId("export").click();
  const warn = page.getByTestId("export-warning-anyway");
  if (await warn.isVisible().catch(() => false)) await warn.click();
  await page.waitForFunction(() => {
    const e = (window as any).__lens.store.get().exporting;
    return e && e.batch && (e.state === "done" || e.state === "error");
  }, null, { timeout: 780_000, polling: 1000 });
  const ex = await page.evaluate(() => (window as any).__lens.store.get().exporting);
  console.log("batch", JSON.stringify(ex.batch), ex.state, ex.error ?? "");
  expect(ex.state).toBe("done");
  expect(ex.path).toBe(EXPORT_PATH);
  for (const s of SIZES) await expect(page.getByTestId(`export-batch-download-${s.tid}`)).toBeVisible();
  await shot(page, "multiaspect-batch-done");

  const results: Record<string, unknown> = {};
  for (const s of SIZES) {
    const it = ex.batch.items.find((x: any) => x.aspect === s.aspect);
    const file = path.join(dir, ".lens-export", it.id, "export.mp4");
    expect(fs.existsSync(file)).toBe(true);
    const pr = spawnSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_read_frames", "-of", "csv=p=0", file], { encoding: "utf8" });
    const [w, h, n] = pr.stdout.trim().split(",").map(Number);
    // bound 2
    expect([w, h]).toEqual([s.w, s.h]);
    expect(n).toBe(60);
    // bound 6: preview vs export at 1.2 s
    const fe = frameAt(file, 1.2);
    let sum = 0;
    for (let i = 0; i < fe.rgb.length; i++) sum += Math.abs(fe.rgb[i]! - pv[s.tid]!.rgb[i]!);
    const mad = sum / fe.rgb.length;
    const r: Record<string, unknown> = { size: `${w}x${h}`, frames: n, mad: +mad.toFixed(2) };
    expect(mad).toBeLessThanOrEqual(12);
    // bound 3: the zoom target in frame (not for the keyed 1:1)
    if (s.framing !== "custom") {
      for (const t of ["1200", "1400"]) {
        const f = frameAt(file, Number(t) / 1000);
        const c = redCentroid(f);
        expect(c).not.toBeNull();
        const m = want[s.tid]![t]!;
        const err = Math.max(Math.abs(c!.x - m.x) / s.w, Math.abs(c!.y - m.y) / s.h);
        const margin = Math.min(c!.x / s.w, (s.w - c!.x) / s.w, c!.y / s.h, (s.h - c!.y) / s.h);
        r[`red${t}`] = { x: +c!.x.toFixed(1), y: +c!.y.toFixed(1), planX: +m.x.toFixed(1), planY: +m.y.toFixed(1), err: +err.toFixed(4), margin: +margin.toFixed(3) };
        expect(margin).toBeGreaterThanOrEqual(0.03);
        expect(err).toBeLessThanOrEqual(0.04);
      }
    } else {
      // bound 5: keyed windows centred on the markers at 0.1 s and 1.9 s
      for (const t of [0.1, 1.9]) {
        const c = redCentroid(frameAt(file, t));
        expect(c).not.toBeNull();
        const err = Math.max(Math.abs(c!.x - s.w / 2) / s.w, Math.abs(c!.y - s.h / 2) / s.h);
        r[`key${t}`] = { x: +c!.x.toFixed(1), y: +c!.y.toFixed(1), err: +err.toFixed(4) };
        expect(err).toBeLessThanOrEqual(0.04);
      }
    }
    results[s.aspect] = r;
  }
  console.log("results", JSON.stringify(results));

  // ---- bound 7: saved with every size's framing
  await page.evaluate(() => (window as any).__lens.store.closeExport());
  await page.getByTestId("tb-target").selectOption("t16x9");
  await expect.poll(async () => (await proj(page)).output.aspect).toBe("16:9");
  await page.getByTestId("save").click();
  await expect.poll(() => (fs.existsSync(path.join(dir, "project.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8")).exportTargets?.items?.length : 0)).toBe(4);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
  const sq = saved.exportTargets.items.find((t: any) => t.aspect === "1:1");
  expect(sq.framing).toBe("custom");
  expect(sq.framingKeys).toHaveLength(2);
  expect(saved.output.aspect).toBe("16:9");

  // ---- bound 8: batch Cancel stops the running size and starts no other
  await page.getByTestId("export").click();
  const warn2 = page.getByTestId("export-warning-anyway");
  if (await warn2.isVisible().catch(() => false)) await warn2.click();
  await page.waitForFunction(() => {
    const e = (window as any).__lens.store.get().exporting;
    return e && e.batch && e.state === "running" && e.done >= 5;
  }, null, { timeout: 120_000, polling: 100 });
  const exportDirs = () => (fs.existsSync(path.join(dir, ".lens-export")) ? fs.readdirSync(path.join(dir, ".lens-export")).length : 0);
  const beforeCancel = await page.evaluate(() => (window as any).__lens.store.get().exporting);
  await page.getByTestId("export-cancel").click();
  await page.waitForFunction(() => {
    const e = (window as any).__lens.store.get().exporting;
    return e && e.state === "error";
  }, null, { timeout: 30_000 });
  const n0 = exportDirs();
  await page.waitForTimeout(4000);
  const afterCancel = await page.evaluate(() => (window as any).__lens.store.get().exporting);
  const n1 = exportDirs();
  const jobState = await page.evaluate(async (u) => (await fetch(u)).json(), `/api/export/${beforeCancel.id}?dir=${encodeURIComponent(dir)}`);
  console.log("cancel", JSON.stringify({ at: { index: beforeCancel.batch.index, done: beforeCancel.done }, after: { state: afterCancel.state, error: afterCancel.error, items: afterCancel.batch?.items?.map((x: any) => x.state + (x.error ? ":" + x.error : "")) }, dirs: [n0, n1], job: jobState.state }));
  expect(afterCancel.state).toBe("error");
  expect(afterCancel.error).toBe("Export cancelled");
  expect(n1).toBe(n0); // no other size started after Cancel
  expect(jobState.state).not.toBe("running");
  expect(jobState.state).not.toBe("done");
  await lens.close();
});
