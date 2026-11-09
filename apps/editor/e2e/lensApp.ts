/**
 * Open the editor on a bundle either in the web editor (vite preview, default) or in the PACKAGED
 * desktop app (LENS_PACKAGED_APP=<unpacked app exe>, see scripts/package-linux.mjs and
 * playwright.app.config.ts): electron-builder layout, app.isPackaged, editor served from
 * resources/editor by the in-app server, in-browser export with the bundled ffmpeg. Same specs, same bounds.
 */
import { _electron as electron, chromium, type Browser, type ElectronApplication, type Page } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { TEST_MAX_BITMAPS, waitDrawn } from "./helpers";
import { urlFor } from "./uxHelpers";

export const PACKAGED = process.env.LENS_PACKAGED_APP ?? "";
const DISPLAY = Number(process.env.LENS_E2E_DISPLAY ?? 93);
let xvfb: ChildProcess | null = null;

async function ensureXvfb(): Promise<void> {
  if (xvfb) return;
  try {
    fs.rmSync(`/tmp/.X${DISPLAY}-lock`, { force: true });
  } catch {
    // not ours
  }
  xvfb = spawn("Xvfb", [`:${DISPLAY}`, "-screen", "0", "2200x1400x24", "-nolisten", "tcp"], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    if (spawnSync("xdpyinfo", ["-display", `:${DISPLAY}`], { stdio: "ignore" }).status === 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Xvfb did not start");
}

export function stopXvfb(): void {
  xvfb?.kill();
  xvfb = null;
}

export interface Lens {
  page: Page;
  app: ElectronApplication | null;
  close(): Promise<void>;
}

/** Editor on `dir` at a w x h CSS viewport and device pixel ratio dpr. */
let webBrowser: Browser | null = null;
/** Web mode: one low-memory Chromium for the spec file (system Chromium when Playwright's is missing). */
async function web(): Promise<Browser> {
  if (webBrowser) return webBrowser;
  const sys = [process.env.LENS_CHROMIUM, "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => p && fs.existsSync(p));
  const args = ["--disable-gpu-sandbox", "--disable-dev-shm-usage", "--in-process-gpu", "--no-zygote", "--renderer-process-limit=1", "--disable-extensions",
    "--disable-background-networking", "--disable-component-update", "--disable-features=Translate,MediaRouter,OptimizationHints,site-per-process"];
  try {
    webBrowser = await chromium.launch({ args });
  } catch {
    webBrowser = await chromium.launch({ args, executablePath: sys });
  }
  return webBrowser;
}

export async function closeAll(): Promise<void> {
  await webBrowser?.close().catch(() => undefined);
  webBrowser = null;
  stopXvfb();
}

export async function openLens(dir: string, opts: { w?: number; h?: number; dpr?: number } = {}): Promise<Lens> {
  const w = opts.w ?? 1600;
  const h = opts.h ?? 1000;
  const dpr = opts.dpr ?? 1;
  let page: Page;
  let app: ElectronApplication | null = null;
  if (PACKAGED) {
    await ensureXvfb();
    const ud = path.join(path.dirname(dir), `ud-${path.basename(dir)}`);
    app = await electron.launch({
      executablePath: PACKAGED,
      args: ["--no-sandbox", `--force-device-scale-factor=${dpr}`],
      env: { ...process.env, DISPLAY: `:${DISPLAY}`, LENS_LOWMEM: "1", LENS_NO_UPDATE: "1", LENS_OPEN_BUNDLE: dir, LENS_USER_DATA: ud },
      timeout: 120_000,
    });
    let ed: Page | null = null;
    for (let i = 0; i < 240 && !ed; i++) {
      ed = app.windows().find((p) => p.url().includes("dir=")) ?? null;
      if (!ed) await new Promise((r) => setTimeout(r, 500));
    }
    if (!ed) throw new Error("packaged app: no editor window");
    page = ed;
    await page.waitForFunction(() => (window as any).__lens?.state().status === "ready", null, { timeout: 180_000 });
    await app.evaluate(({ BrowserWindow }, [cw, ch]) => {
      const win = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().includes("dir="))!;
      win.unmaximize();
      win.setFullScreen(false);
      win.setContentSize(cw, ch);
      win.setPosition(0, 0);
      win.focus();
    }, [w, h] as [number, number]);
    await page.waitForFunction(([cw, ch]: [number, number]) => Math.abs(innerWidth - cw) <= 1 && Math.abs(innerHeight - ch) <= 1 && Math.abs(document.documentElement.clientWidth - cw) <= 1, [w, h] as [number, number], { timeout: 15_000 });
    // let layout and the ResizeObservers settle at the new size
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 300)))));
    const sw = await page.evaluate(() => [document.documentElement.scrollWidth, document.body.scrollWidth, innerWidth]);
    console.log("packaged window", w, h, "scrollWidth", sw);
  } else {
    const base = process.env.LENS_E2E_BASE ?? `http://127.0.0.1:${process.env.LENS_E2E_PORT ?? 5188}`;
    const ctx = await (await web()).newContext({ baseURL: base, viewport: { width: w, height: h }, deviceScaleFactor: dpr });
    page = await ctx.newPage();
    await page.addInitScript((n) => ((window as any).__lensMaxBitmaps = n), TEST_MAX_BITMAPS);
    await page.goto(urlFor(dir));
    await page.waitForFunction(() => (window as any).__lens?.state().status === "ready", null, { timeout: 90_000 });
  }
  await waitDrawn(page);
  return {
    page,
    app,
    close: async () => {
      if (app) await app.close().catch(() => undefined);
      else await page.context().close().catch(() => undefined);
    },
  };
}
