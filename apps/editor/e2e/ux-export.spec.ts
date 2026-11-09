/**
 * Long jobs off the UI thread (Windows bug #11b): the export renders in a Web Worker with progress and
 * Cancel, and the editor stays responsive meanwhile.
 * Bounds (set before the first run): during a 6 s / 720p export the progress value is reported at
 * least 5 distinct times; the main thread has no long task over 200 ms after the export starts
 * rendering (PerformanceObserver longtask); 10 seeks issued during the export each repaint the
 * preview within 1000 ms (median <= 400 ms); a second export cancelled at >= 10 % stops: state
 * "Export cancelled", no frame is posted afterwards, and the server job reports cancelled.
 */
import { test } from "@playwright/test";
import { expect, shot } from "./helpers";
import { closeAll, openLens, PACKAGED } from "./lensApp";
import { editProject, exportMp4, uxBundle } from "./uxHelpers";

test.afterAll(() => closeAll());

test("export runs off the UI thread with progress and cancel", async () => {
  const dir = uxBundle("export");
  const lens = await openLens(dir, { w: 1280, h: 720 });
  const page = lens.page;
  await editProject(page, "720p30", "(p) => ({ ...p, output: { ...p.output, resolution: 720, fps: 30 } })");
  await page.evaluate(() => {
    const w = window as any;
    w.__long = [];
    w.__prog = new Set();
    new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__long.push({ t: e.startTime, d: e.duration }); }).observe({ type: "longtask", buffered: false });
    w.__lens.store.subscribe(() => { const e = w.__lens.store.get().exporting; if (e && e.state === "running") w.__prog.add(e.done); });
  });
  const t0 = await page.evaluate(() => performance.now());
  const exp = exportMp4(page, dir, 600_000);
  // wait until frames are flowing, then seek around while it renders
  await page.waitForFunction(() => ((window as any).__lens.store.get().exporting?.done ?? 0) > 10, null, { timeout: 120_000 });
  const tRender = await page.evaluate(() => performance.now());
  const lat: number[] = [];
  for (let i = 0; i < 10; i++) {
    const ms = await page.evaluate(async (k) => {
      const s = (window as any).__lens;
      const t = performance.now();
      s.store.seek((k * 17) % s.state().frames);
      await new Promise<void>((res) => {
        const tick = () => {
          const c = document.querySelector('[data-testid="preview"]') as HTMLCanvasElement;
          if (c.dataset.frame === String(s.state().frame) && c.dataset.revision === String(s.state().revision)) res();
          else requestAnimationFrame(tick);
        };
        tick();
      });
      return performance.now() - t;
    }, i + 1);
    lat.push(ms);
    await page.waitForTimeout(150);
  }
  const mp4 = await exp;
  const r = await page.evaluate((tr) => ({ long: (window as any).__long.filter((e: any) => e.t >= tr), prog: [...(window as any).__prog].length }), tRender);
  const sorted = [...lat].sort((a, b) => a - b);
  const maxLong = Math.max(0, ...r.long.map((e: any) => e.d));
  console.log(PACKAGED ? "packaged" : "web", "export", mp4, "progress values", r.prog, "long tasks", r.long.length, "max", maxLong.toFixed(0), "ms; seek latency median", sorted[5]!.toFixed(0), "max", sorted[9]!.toFixed(0), "ms", "(from start", (tRender - t0).toFixed(0), "ms)");
  expect(r.prog).toBeGreaterThanOrEqual(5);
  expect(maxLong).toBeLessThanOrEqual(200);
  expect(sorted[9]!).toBeLessThanOrEqual(1000);
  expect(sorted[5]!).toBeLessThanOrEqual(400);
  // cancel
  await page.evaluate(() => (window as any).__lens.store.closeExport());
  await page.getByTestId("export").click();
  await page.waitForFunction(() => { const e = (window as any).__lens.store.get().exporting; return e && e.total && e.done >= e.total * 0.1; }, null, { timeout: 180_000 });
  await page.getByTestId("export-cancel").click();
  const ex = await page.evaluate(() => (window as any).__lens.store.get().exporting);
  expect(ex.state).toBe("error");
  expect(ex.error).toBe("Export cancelled");
  await expect(page.getByTestId("export-error")).toHaveText("Export cancelled");
  await page.waitForTimeout(1500);
  const job = await page.evaluate(async ([id, d]) => (await fetch(`/api/export/${id}?dir=${encodeURIComponent(d)}`)).json(), [ex.id, dir]);
  console.log("cancelled at", ex.done, "/", ex.total, "server job", job.state, job.error, "frames received", job.done);
  expect(job.state).toBe("error");
  expect(job.error).toBe("cancelled");
  await page.waitForTimeout(1500);
  const job2 = await page.evaluate(async ([id, d]) => (await fetch(`/api/export/${id}?dir=${encodeURIComponent(d)}`)).json(), [ex.id, dir]);
  expect(job2.done).toBe(job.done); // nothing posted after cancel
  await shot(page, `export-cancelled${PACKAGED ? "-app" : ""}`);
  await lens.close();
});
