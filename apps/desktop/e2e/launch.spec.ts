/**
 * Windows #6: the recorder (screen / window picker) shows on launch, comes back on a tray click after
 * being closed (Lens keeps running in the tray), and a second launch shows the running recorder
 * instead of starting a second Lens.
 * Bounds: recorder visible within 10 s of launch with >= 1 screen source listed; after close the app
 * is alive and the window hidden; tray click -> visible within 2 s; second launch exits within 15 s
 * and the first instance's recorder is visible within 2 s of that.
 */
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DESKTOP, RUNS, appLaunchOptions, sleep, startXvfb } from "./helpers";

const DISPLAY = Number(process.env.LENS_E2E_DISPLAY ?? 71);
let xvfb: ChildProcess | null = null;
let app: ElectronApplication | null = null;

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  xvfb?.kill();
});

const visible = (a: ElectronApplication) =>
  a.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.getTitle().startsWith("Lens Recorder")).map((w) => w.isVisible()));

async function waitVisible(a: ElectronApplication, want: boolean, ms: number): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await visible(a);
    if (v.length && v[0] === want) return Date.now() - t0;
    await sleep(100);
  }
  return -1;
}

test("recorder shows on launch, on tray click, and on a second launch", async () => {
  test.setTimeout(180_000);
  const run = path.join(RUNS, `launch-${Date.now()}`);
  fs.mkdirSync(run, { recursive: true });
  xvfb = await startXvfb(DISPLAY, 1280, 720);
  const env = { ...process.env, DISPLAY: `:${DISPLAY}`, LENS_E2E: "1", LENS_LOWMEM: "1", LENS_RECORDINGS_DIR: path.join(run, "rec"), LENS_USER_DATA: path.join(run, "ud"), LENS_NO_UPDATE: "1" };
  const opts = appLaunchOptions();
  app = await electron.launch({ ...opts, env, timeout: 60_000 });
  const report: Record<string, unknown> = { packaged: !!process.env.LENS_PACKAGED_APP };
  const rec = await app.firstWindow();
  report.launchVisibleMs = await waitVisible(app, true, 10_000);
  await rec.waitForSelector('[data-testid="sources"] button.src', { timeout: 15_000 });
  report.sources = await rec.locator('[data-testid="sources"] button.src').count();

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle().startsWith("Lens Recorder"))!.close());
  report.closedHiddenMs = await waitVisible(app, false, 5_000);
  report.aliveAfterClose = await app.evaluate(({ app: a }) => a.isReady());

  await app.evaluate(() => (globalThis as any).lensTray.emit("click"));
  report.trayVisibleMs = await waitVisible(app, true, 2_000);

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle().startsWith("Lens Recorder"))!.hide());
  await waitVisible(app, false, 2_000);
  const exe = opts.executablePath ?? (require("electron") as unknown as string);
  const args = opts.executablePath ? ["--no-sandbox"] : [DESKTOP, "--no-sandbox"];
  const t0 = Date.now();
  const second = spawn(exe, args, { env, stdio: "ignore" });
  const code = await new Promise<number | null>((resolve) => {
    const t = setTimeout(() => resolve(-999), 15_000);
    second.on("exit", (c) => {
      clearTimeout(t);
      resolve(c);
    });
  });
  if (code === -999) second.kill();
  report.secondExit = { code, ms: Date.now() - t0 };
  report.secondShowsMs = await waitVisible(app, true, 2_000);
  fs.writeFileSync(path.join(run, "report.json"), JSON.stringify(report, null, 2));
  console.log("launch report", JSON.stringify(report));

  expect(report.launchVisibleMs as number).toBeGreaterThanOrEqual(0);
  expect(report.sources as number).toBeGreaterThanOrEqual(1);
  expect(report.closedHiddenMs as number).toBeGreaterThanOrEqual(0);
  expect(report.aliveAfterClose).toBe(true);
  expect(report.trayVisibleMs as number).toBeGreaterThanOrEqual(0);
  expect(code).not.toBe(-999);
  expect(report.secondShowsMs as number).toBeGreaterThanOrEqual(0);
});
