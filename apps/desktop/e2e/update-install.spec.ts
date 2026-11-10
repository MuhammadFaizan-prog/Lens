/**
 * Restart to update, end to end in a real Electron (fix/updater-014). The app (apps/desktop/dist,
 * unpackaged) runs under Xvfb with the Windows (NSIS) updater forced on (LENS_UPDATE_NSIS=1) against a
 * local feed whose "installer" is a shell script that records its arguments. Checks:
 *  - Update downloads it (sha512 verified), Restart to update kills Lens's child processes, runs the
 *    installer with `--updated /S --force-run`, and the app process exits; lens.log has the steps;
 *  - an installer that cannot be started (not executable, no elevate.exe) cancels the quit: Lens
 *    stays open with the error.
 * This is the Linux stand-in; the NSIS installer itself only runs on Windows and is not exercised.
 *
 * Env: LENS_E2E_ELECTRON = electron binary (default node_modules/electron's).
 */
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { ChildProcess } from "node:child_process";
import { DESKTOP, RUNS, sleep, startXvfb } from "./helpers";

const DISPLAY = Number(process.env.LENS_E2E_DISPLAY ?? 91);
const VERSION = "9.9.9";

let xvfb: ChildProcess | null = null;
test.beforeAll(async () => {
  xvfb = await startXvfb(DISPLAY, 1024, 768);
});
test.afterAll(() => xvfb?.kill());

function makeFeed(dir: string, record: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, `Lens-Setup-${VERSION}.exe`);
  fs.writeFileSync(exe, `#!/bin/sh\necho "$@" > "${record}"\n`);
  const buf = fs.readFileSync(exe);
  const sha = crypto.createHash("sha512").update(buf).digest("base64");
  fs.writeFileSync(
    path.join(dir, "latest.yml"),
    `version: ${VERSION}\nfiles:\n  - url: Lens-Setup-${VERSION}.exe\n    sha512: ${sha}\n    size: ${buf.length}\npath: Lens-Setup-${VERSION}.exe\nsha512: ${sha}\nreleaseDate: '2026-11-10T00:00:00.000Z'\n`,
  );
}

function serve(dir: string): Promise<http.Server> {
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname).replace(/^\/+/, "").replace(/^latest-(linux|mac)[^/]*\.yml$/, "latest.yml");
    const f = path.join(dir, rel);
    if (!f.startsWith(dir) || !fs.existsSync(f) || !fs.statSync(f).isFile()) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader("content-length", fs.statSync(f).size);
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)));
}

async function launch(tag: string, feedUrl: string) {
  const ud = path.join(RUNS, `update-install-${tag}-${Date.now()}`);
  const app = await electron.launch({
    executablePath: process.env.LENS_E2E_ELECTRON || undefined,
    args: [DESKTOP, "--no-sandbox"],
    env: { ...process.env, DISPLAY: `:${DISPLAY}`, LENS_LOWMEM: "1", LENS_E2E: "1", LENS_USER_DATA: ud, LENS_RECORDINGS_DIR: path.join(ud, "rec"), LENS_UPDATE_NSIS: "1", LENS_UPDATE_URL: feedUrl, LENS_UPDATE_FIRST_CHECK_MS: "1500", LENS_UPDATE_WATCHDOG_MS: "8000", XDG_CACHE_HOME: path.join(ud, "cache") },
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!(window as any).lensRecorder, null, { timeout: 60_000 });
  return { app, page, ud };
}

async function downloadUpdate(page: Awaited<ReturnType<typeof launch>>["page"]) {
  await page.waitForFunction(() => (window as any).lensRecorder.state().update.status === "available", null, { timeout: 120_000 });
  await page.locator("[data-testid=update-btn]").click();
  await page.waitForFunction(() => ["downloaded", "error"].includes((window as any).lensRecorder.state().update.status), null, { timeout: 120_000, polling: 300 });
  const st = await page.evaluate(() => (window as any).lensRecorder.state().update);
  expect(st.status, st.message).toBe("downloaded");
  await expect(page.locator("[data-testid=update-btn]")).toHaveText("Restart to update");
  return st as { file: string; version: string };
}

/** A long-running child of the main process, started the way Lens starts ffmpeg (child_process.spawn). */
async function startChild(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => {
    // the same child_process module object Lens's code spawns ffmpeg through (Node 22 getBuiltinModule)
    const cp = (process as any).getBuiltinModule("child_process");
    return cp.spawn("sleep", ["120"], { stdio: "ignore" }).pid as number;
  });
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("Restart to update: children killed, installer run with --updated /S --force-run, app exits", async () => {
  test.setTimeout(300_000);
  const root = path.join(RUNS, `update-install-feed-ok-${Date.now()}`);
  const record = path.join(root, "installer-args.txt");
  makeFeed(path.join(root, "feed"), record);
  const srv = await serve(path.join(root, "feed"));
  const { app, page, ud } = await launch("ok", `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`);
  let exited = false;
  app.process().once("exit", () => (exited = true));
  try {
    const st = await downloadUpdate(page);
    // the downloaded stand-in must be runnable (a Windows .exe needs no exec bit)
    fs.chmodSync(st.file, 0o755);
    const child = await startChild(app);
    expect(alive(child)).toBe(true);
    await page.locator("[data-testid=update-btn]").click();
    for (let i = 0; i < 100 && !(exited && fs.existsSync(record)); i++) await sleep(100);
    expect(exited, "the app process exits for the installer").toBe(true);
    expect(fs.readFileSync(record, "utf8").trim()).toBe("--updated /S --force-run");
    for (let i = 0; i < 20 && alive(child); i++) await sleep(100);
    expect(alive(child), "child process killed before the installer runs").toBe(false);
    const log = fs.readFileSync(path.join(ud, "logs", "lens.log"), "utf8");
    fs.writeFileSync(path.join(root, "lens.log"), log);
    for (const s of ["[update] install requested v9.9.9", "killing 1 child process(es)", "[update] prepared for install", "quitAndInstall(isSilent=true, isForceRunAfter=true)", "electron-updater: Executing:", "quit for update"]) expect(log).toContain(s);
    expect(log).not.toContain("forcing exit");
  } finally {
    if (!exited) await app.close().catch(() => undefined);
    srv.close();
  }
});

test("an installer that cannot be started: the quit is cancelled and Lens shows the error", async () => {
  test.setTimeout(300_000);
  const root = path.join(RUNS, `update-install-feed-fail-${Date.now()}`);
  const record = path.join(root, "installer-args.txt");
  makeFeed(path.join(root, "feed"), record);
  const srv = await serve(path.join(root, "feed"));
  const { app, page, ud } = await launch("fail", `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`);
  let exited = false;
  app.process().once("exit", () => (exited = true));
  try {
    await downloadUpdate(page);
    // left without the exec bit: spawn fails (EACCES), electron-updater's elevate.exe retry fails (ENOENT)
    await page.locator("[data-testid=update-btn]").click();
    // the banner says so (a later focus re-check may turn it back into "Update available")
    await page.waitForFunction(() => (window as any).lensRecorder.state().update.status === "error" && /Update failed/.test(document.getElementById("update-text")?.textContent ?? ""), null, { timeout: 30_000, polling: 100 });
    const st = await page.evaluate(() => (window as any).lensRecorder.state().update);
    expect(String(st.message)).toMatch(/could not be started/);
    await sleep(10_000); // past the 8 s watchdog: it must not fire after a failed start
    expect(exited, "Lens stays open").toBe(false);
    expect(fs.existsSync(record)).toBe(false);
    const log = fs.readFileSync(path.join(ud, "logs", "lens.log"), "utf8");
    fs.writeFileSync(path.join(root, "lens.log"), log);
    for (const s of ["[update] install failed", "quit cancelled: the update did not start"]) expect(log).toContain(s);
  } finally {
    if (!exited) await app.close().catch(() => undefined);
    srv.close();
  }
});
