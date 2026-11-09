/**
 * Windows #21: an app left open with the editor in front sees a release. The app (Windows NSIS
 * updater forced on, LENS_UPDATE_NSIS=1) checks a local feed at its current version (no update), then
 * the feed moves to 9.9.9; a window focus after the throttle re-checks and the editor header shows
 * "Update available v9.9.9". The throttle is LENS_UPDATE_FOCUS_MS=4000 here (15 min in the app).
 * Bounds: first check -> "none"; a focus inside the throttle makes no feed request; a focus after it
 * makes exactly one, and the editor banner reads "Update available v9.9.9" within 10 s; the tray menu
 * has "About Lens" and "Check for updates", the app menu has "About Lens".
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { ChildProcess } from "node:child_process";
import { RUNS, appLaunchOptions, makeBundle, sleep, startXvfb } from "./helpers";

const DISPLAY = Number(process.env.LENS_E2E_DISPLAY ?? 71);
let xvfb: ChildProcess | null = null;
let app: ElectronApplication | null = null;
let srv: http.Server | null = null;

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  srv?.close();
  xvfb?.kill();
});

test("editor header shows a release found by a focus re-check; tray + About have Check for updates", async () => {
  test.setTimeout(240_000);
  const run = path.join(RUNS, `update-editor-${Date.now()}`);
  fs.mkdirSync(run, { recursive: true });
  const current = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version as string;
  let feedVersion = current;
  let ymlHits = 0;
  srv = http.createServer((req, res) => {
    if (/\.yml$/.test(new URL(req.url ?? "/", "http://x").pathname)) {
      ymlHits++;
      res.setHeader("content-type", "text/yaml");
      return res.end(`version: ${feedVersion}\nfiles:\n  - url: Lens-Setup-${feedVersion}.exe\n    sha512: ${"A".repeat(86)}==\n    size: 1\npath: Lens-Setup-${feedVersion}.exe\nsha512: ${"A".repeat(86)}==\nreleaseDate: '2026-11-09T00:00:00.000Z'\n`);
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => srv!.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`;
  xvfb = await startXvfb(DISPLAY, 1280, 800);
  const bundle = makeBundle(path.join(run, "bundle"), { seconds: 2 });
  app = await electron.launch({
    ...appLaunchOptions(),
    env: { ...process.env, DISPLAY: `:${DISPLAY}`, LENS_E2E: "1", LENS_LOWMEM: "1", LENS_USER_DATA: path.join(run, "ud"), LENS_RECORDINGS_DIR: path.join(run, "rec"), XDG_CACHE_HOME: path.join(run, "cache"),
      LENS_UPDATE_NSIS: "1", LENS_UPDATE_URL: url, LENS_UPDATE_FIRST_CHECK_MS: "500", LENS_UPDATE_NO_INSTALL: "1", LENS_UPDATE_FOCUS_MS: "4000", LENS_OPEN_BUNDLE: bundle } as Record<string, string>,
    timeout: 60_000,
  });
  const report: Record<string, any> = { packaged: !!process.env.LENS_PACKAGED_APP, current };
  let ed: Page | undefined;
  for (let i = 0; i < 240 && !ed; i++) {
    ed = app.windows().find((p) => p.url().includes("dir="));
    if (!ed) await sleep(250);
  }
  expect(ed, "editor window").toBeTruthy();
  await ed!.waitForFunction(() => (window as any).__lens?.state().status === "ready", null, { timeout: 120_000 });
  for (let i = 0; i < 100; i++) {
    const s = await app.evaluate(() => (globalThis as any).lensUpdates.state.status);
    if (s === "none" || s === "error") break;
    await sleep(200);
  }
  report.first = await app.evaluate(() => ({ status: (globalThis as any).lensUpdates.state.status, checks: (globalThis as any).lensUpdates.checks }));
  report.bannerBefore = await ed!.locator('[data-testid="update-banner"]').count();
  report.tray = await app.evaluate(() => (globalThis as any).lensTrayItems);

  feedVersion = "9.9.9";
  const focusEditor = () =>
    app!.evaluate(({ BrowserWindow, app: a }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes("dir="))!;
      w.blur();
      w.focus();
      // Xvfb has no window manager to deliver focus events: emit the app event focus would raise
      (a as any).emit("browser-window-focus", {}, w);
    });
  const hits0 = ymlHits;
  await focusEditor();
  await sleep(1500);
  report.throttled = { hitsAdded: ymlHits - hits0, status: await app.evaluate(() => (globalThis as any).lensUpdates.state.status) };
  await sleep(Math.max(0, 4200 - 1500));
  const hits1 = ymlHits;
  const t0 = Date.now();
  await focusEditor();
  await ed!.waitForSelector('[data-testid="update-banner"]', { timeout: 10_000 });
  report.bannerMs = Date.now() - t0;
  report.bannerText = await ed!.locator('[data-testid="update-banner-text"]').textContent();
  report.bannerBtn = await ed!.locator('[data-testid="update-banner-btn"]').textContent();
  await sleep(500);
  report.recheckHits = ymlHits - hits1;
  await ed!.screenshot({ path: path.join(run, "editor-banner.png") });
  report.trayAfter = await app.evaluate(() => (globalThis as any).lensTrayItems);
  report.appMenu = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items[0]?.submenu?.items.map((i) => i.label) ?? []);
  fs.writeFileSync(path.join(run, "report.json"), JSON.stringify(report, null, 2));
  console.log("update-editor report", JSON.stringify(report));

  expect(report.first.status).toBe("none");
  expect(report.bannerBefore).toBe(0);
  expect(report.throttled.hitsAdded).toBe(0);
  expect(report.recheckHits).toBe(1);
  expect(report.bannerText).toBe("Update available v9.9.9");
  expect(report.bannerBtn).toBe("Update");
  expect(report.tray).toEqual(expect.arrayContaining(["About Lens", "Check for updates"]));
  expect(report.appMenu).toContain("About Lens");
});
