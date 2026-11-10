/**
 * Editor smoothness bench (v0.1.4 speed pass): not a pass/fail test, a measurement harness that writes
 * one JSON per run (LENS_PERF_OUT, default test-results/perf-smooth.json). Same spec on any tree that has
 * the __lens hook, so v0.1.3 and v0.1.4 are measured the same way.
 *
 * On a fresh copy of the bundle LENS_PERF_BUNDLE (default apps/editor/sample: 720p30 10 s with webcam,
 * masks, captions and a manual zoom) with LENS_PERF_PATCH (JSON merged into project.json) applied:
 *  - launch:  page's own clock from navigation: store ready, first frame painted
 *  - play:    2 passes of 3 s playback from 0; distinct frames drawn on the preview per second
 *             and rAF intervals (p50 / p95 / max, frames > 50 ms)
 *  - scrub:   30 seeks to fixed pseudo-random frames, seek -> preview shows it (median / p95 / max)
 *  - drag:    the first zoom block dragged 200 px along its lane in 20 mouse steps; rAF intervals
 *  - memory:  JS heap (CDP Performance.getMetrics) and the RSS of this run's Chromium processes
 *  - export:  Export MP4 wall time (LENS_PERF_EXPORT=0 skips)
 */
import { test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { EDITOR } from "./helpers";

const OUT = process.env.LENS_PERF_OUT ?? path.join(EDITOR, "test-results", "perf-smooth.json");
const SRC = process.env.LENS_PERF_BUNDLE ?? path.join(EDITOR, "sample");

function bundle(): string {
  if (!fs.existsSync(path.join(SRC, "screen.mp4"))) execFileSync("python3", [path.join(EDITOR, "scripts", "make_sample.py"), "--out", SRC]);
  const root = process.env.LENS_E2E_TMP ?? path.join(EDITOR, "test-results", "perf-runs");
  const dir = path.join(root, `perf-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(SRC)) {
    const p = path.join(SRC, f);
    if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(dir, f));
  }
  const patch = process.env.LENS_PERF_PATCH;
  if (patch) {
    const pj = path.join(dir, "project.json");
    const merge = (a: any, b: any): any => {
      if (typeof a !== "object" || typeof b !== "object" || !a || !b || Array.isArray(b)) return b;
      const o = { ...a };
      for (const [k, v] of Object.entries(b)) o[k] = k in o ? merge(o[k], v) : v;
      return o;
    };
    fs.writeFileSync(pj, JSON.stringify(merge(JSON.parse(fs.readFileSync(pj, "utf8")), JSON.parse(patch)), null, 1));
  }
  return dir;
}

const q = (a: number[], p: number) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return +s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]!.toFixed(2);
};

function rss(): number {
  // this run's Chromium: its profile dir lives under our TMPDIR
  const tmp = process.env.TMPDIR ?? "/tmp";
  let kb = 0;
  for (const pid of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (!/chrom/i.test(cmd)) continue;
      if (!cmd.includes(tmp) && !(fs.readFileSync(`/proc/${pid}/environ`, "utf8").includes(`TMPDIR=${tmp}`))) continue;
      const m = /VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
      if (m) kb += Number(m[1]);
    } catch {
      // gone
    }
  }
  return Math.round(kb / 1024);
}

async function rafWindow(page: Page, ms: number, during: () => Promise<void>): Promise<{ p50: number; p95: number; max: number; long: number; n: number; frames: number }> {
  await page.evaluate(() => {
    const w = window as any;
    w.__perf = { iv: [] as number[], frames: new Set<string>(), on: true };
    let last = performance.now();
    const c = document.querySelector('[data-testid="preview"]') as HTMLCanvasElement;
    const tick = (t: number) => {
      if (!w.__perf.on) return;
      w.__perf.iv.push(t - last);
      last = t;
      w.__perf.frames.add(c.dataset.frame ?? "");
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const t0 = Date.now();
  await during();
  const left = ms - (Date.now() - t0);
  if (left > 0) await page.waitForTimeout(left);
  const r = await page.evaluate(() => {
    const w = window as any;
    w.__perf.on = false;
    return { iv: (w.__perf.iv as number[]).slice(1), frames: (w.__perf.frames as Set<string>).size };
  });
  return { p50: q(r.iv, 0.5), p95: q(r.iv, 0.95), max: q(r.iv, 1), long: r.iv.filter((x) => x > 50).length, n: r.iv.length, frames: r.frames };
}

const drawnIs = (page: Page) =>
  page.waitForFunction(() => {
    const s = (window as any).__lens.state();
    const c = document.querySelector('[data-testid="preview"]') as HTMLCanvasElement | null;
    return !!c && c.dataset.frame === String(s.frame) && c.dataset.revision === String(s.revision);
  }, null, { timeout: 60_000, polling: "raf" });

test("editor smoothness bench", async ({ page }) => {
  test.setTimeout(600_000);
  const dir = bundle();
  const res: Record<string, unknown> = { tree: process.env.LENS_PERF_LABEL ?? "", bundle: SRC, patch: process.env.LENS_PERF_PATCH ?? null, at: new Date().toISOString() };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const save = () => {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
  };
  // decoded-bitmap LRU: the test default (8) on this low-memory box, same for every tree
  await page.addInitScript((n) => ((window as any).__lensMaxBitmaps = n), Number(process.env.LENS_PERF_BITMAPS ?? 8));
  const heap = async () => {
    const m = (await cdp.send("Performance.getMetrics")).metrics;
    return Math.round((m.find((x) => x.name === "JSHeapUsedSize")?.value ?? 0) / 1048576);
  };

  // ---- launch
  const g0 = Date.now();
  await page.goto(`/?dir=${encodeURIComponent(dir)}`);
  await page.waitForFunction(() => (window as any).__lens?.state().status === "ready", null, { timeout: 120_000 });
  await drawnIs(page);
  const wall = Date.now() - g0;
  const st = await page.evaluate(() => {
    const s = (window as any).__lens.state();
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return { readyMs: s.readyMs, firstPaintMs: s.firstPaintMs, domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null, frames: s.frames, fps: s.fps };
  });
  // the first drawn frame can come after the store's first paint mark (backdrops / fonts pending)
  res.launch = { ...st, wallToDrawnMs: wall, heapMB: await heap(), rssMB: rss() };

  const INTERACTIVE = process.env.LENS_PERF_INTERACTIVE !== "0";
  // ---- playback (pass 1 cold decode, pass 2 warm)
  const play: unknown[] = [];
  if (INTERACTIVE) {
  for (let pass = 0; pass < 2; pass++) {
    await page.evaluate(() => (window as any).__lens.store.seek(0));
    await drawnIs(page);
    const r = await rafWindow(page, 3000, async () => {
      await page.evaluate(() => (window as any).__lens.store.togglePlay?.() ?? (window as any).__lens.store.play());
    });
    await page.keyboard.press("k");
    await page.evaluate(() => (window as any).__lens.store.get().playing && (window as any).__lens.store.togglePlay?.());
    play.push({ pass, drawnFps: +(r.frames / 3).toFixed(1), rafP50: r.p50, rafP95: r.p95, rafMax: r.max, longFrames: r.long });
  }
  res.play = play;
  save();

  // ---- scrub
  const n = st.frames as number;
  const targets = Array.from({ length: 30 }, (_, i) => Math.floor(((i * 7919) % 997) / 997 * (n - 1)));
  const seekMs = await page.evaluate(async (ts) => {
    const out: number[] = [];
    const c = document.querySelector('[data-testid="preview"]') as HTMLCanvasElement;
    const store = (window as any).__lens.store;
    for (const f of ts) {
      const t0 = performance.now();
      store.seek(f);
      await new Promise<void>((done) => {
        const chk = () => {
          const s = (window as any).__lens.state();
          if (c.dataset.frame === String(s.frame) && c.dataset.revision === String(s.revision)) done();
          else requestAnimationFrame(chk);
        };
        requestAnimationFrame(chk);
      });
      out.push(performance.now() - t0);
    }
    return out;
  }, targets);
  res.scrub = { n: seekMs.length, median: q(seekMs, 0.5), p95: q(seekMs, 0.95), max: q(seekMs, 1) };

  // ---- timeline drag of the first zoom block
  const zb = page.locator('[data-testid="lane-zoom"] .block').first();
  const block = (await zb.count()) ? zb : page.locator('[data-testid^="lane-"] .block').first();
  if (await block.count()) {
    res.dragBlock = await block.getAttribute("class");
    await page.evaluate(() => (window as any).__lens.store.seek(0));
    await drawnIs(page);
    const b = (await block.boundingBox())!;
    const y = b.y + b.height / 2;
    const x0 = b.x + Math.min(20, b.width / 2);
    const r = await rafWindow(page, 0, async () => {
      await page.mouse.move(x0, y);
      await page.mouse.down();
      for (let i = 1; i <= 20; i++) {
        await page.mouse.move(x0 + i * 10, y);
        await page.waitForTimeout(16);
      }
      await page.mouse.up();
      await page.waitForTimeout(300);
    });
    res.drag = { rafP50: r.p50, rafP95: r.p95, rafMax: r.max, longFrames: r.long, n: r.n };
    await page.keyboard.press("Control+z");
  } else res.drag = null;

  res.memory = { heapMB: await heap(), rssMB: rss() };
  save();
  }

  // ---- export
  if (process.env.LENS_PERF_EXPORT !== "0") {
    await page.evaluate(() => (window as any).__lens.store.seek(0));
    const e0 = Date.now();
    await page.getByTestId("export").click();
    const warn = page.getByTestId("export-warning-anyway");
    if (await warn.isVisible().catch(() => false)) await warn.click();
    await page.waitForFunction(() => {
      const e = (window as any).__lens.store.get().exporting;
      return e && (e.state === "done" || e.state === "error");
    }, null, { timeout: 480_000, polling: 250 });
    const ex = await page.evaluate(() => (window as any).__lens.store.get().exporting);
    res.export = { state: ex.state, error: ex.error ?? null, path: ex.path ?? "compositor", seconds: ex.seconds ?? null, wallS: +((Date.now() - e0) / 1000).toFixed(2), frames: ex.total, rssAfterMB: rss() };
  }
  save();
  console.log("PERF", JSON.stringify(res));
  fs.rmSync(dir, { recursive: true, force: true });
});
