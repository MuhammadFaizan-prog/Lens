/**
 * Auto-update flow on Linux (docs/Releasing.md): the staged v<OLD> app (the same JS that is inside the
 * Windows installer) runs under Xvfb with the Windows (NSIS) updater forced on, against a feed with a
 * newer build. Checks: the update is detected and shown ("Update available vX" + Update button), the
 * Update button downloads it, electron-updater verifies the sha512 (the downloaded file's sha512 equals
 * latest.yml's and the served installer's), "Restart to update" is shown; and a feed whose sha512 does
 * not match the installer is refused. Running the installer (quitAndInstall) is Windows-only and not
 * exercised here.
 *
 * Env: LENS_UPDATE_OLD_APP = staged old app dir (out/desktop/releases/<old>/app),
 *      LENS_UPDATE_FEED = dir with latest.yml + installer + blockmap (local generic feed), or
 *      LENS_UPDATE_GITHUB=1 to use the real GitHub release feed instead.
 */
import { _electron as electron, expect, test } from "@playwright/test";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { ChildProcess } from "node:child_process";
import { RUNS, sleep, startXvfb } from "./helpers";

const DISPLAY = Number(process.env.LENS_E2E_DISPLAY ?? 95);
const OLD_APP = process.env.LENS_UPDATE_OLD_APP ?? "";
const FEED = process.env.LENS_UPDATE_FEED ?? "";
const GITHUB = process.env.LENS_UPDATE_GITHUB === "1";

function serve(dir: string, rewriteYml?: (s: string) => string): Promise<http.Server> {
  const srv = http.createServer((req, res) => {
    // The NSIS updater forced on Linux (LENS_UPDATE_NSIS=1) still names its channel file by the host
    // platform (latest-linux-arm64.yml); Windows reads latest.yml. Serve latest.yml for both.
    const rel = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname).replace(/^\/+/, "").replace(/^latest-(linux|mac)[^/]*\.yml$/, "latest.yml");
    const f = path.join(dir, rel);
    if (!f.startsWith(dir) || !fs.existsSync(f) || !fs.statSync(f).isFile()) {
      res.statusCode = 404;
      return res.end();
    }
    if (f.endsWith(".yml") && rewriteYml) return res.end(rewriteYml(fs.readFileSync(f, "utf8")));
    res.setHeader("content-length", fs.statSync(f).size);
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)));
}

// streamed: reading a 113 MB installer whole (three times per run) got the worker OOM-killed on a 1.3 GB box
const sha512 = (f: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const h = crypto.createHash("sha512");
    fs.createReadStream(f, { highWaterMark: 1 << 20 }).on("data", (c) => h.update(c)).on("error", reject).on("end", () => resolve(h.digest("base64")));
  });

let xvfb: ChildProcess | null = null;
test.beforeAll(async () => {
  xvfb = await startXvfb(DISPLAY, 1024, 768);
});
test.afterAll(() => xvfb?.kill());

async function launch(env: Record<string, string>, tag: string) {
  const ud = path.join(RUNS, `update-${tag}-${Date.now()}`);
  const app = await electron.launch({
    args: [OLD_APP, "--no-sandbox"],
    env: { ...process.env, DISPLAY: `:${DISPLAY}`, LENS_LOWMEM: "1", LENS_USER_DATA: ud, LENS_RECORDINGS_DIR: path.join(ud, "rec"), LENS_UPDATE_NSIS: "1", LENS_UPDATE_FIRST_CHECK_MS: "1500", LENS_UPDATE_NO_INSTALL: "1", XDG_CACHE_HOME: path.join(ud, "cache"), ...env },
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!(window as any).lensRecorder, null, { timeout: 30_000 });
  return { app, page, ud };
}

test("detects, downloads and sha512-verifies an update; shows Update / Restart to update", async () => {
  test.skip(!OLD_APP || (!FEED && !GITHUB), "needs LENS_UPDATE_OLD_APP and LENS_UPDATE_FEED or LENS_UPDATE_GITHUB=1");
  test.setTimeout(600_000);
  const srv = FEED ? await serve(FEED) : null;
  const url = srv ? `http://127.0.0.1:${(srv.address() as AddressInfo).port}/` : "";
  const { app, page, ud } = await launch(url ? { LENS_UPDATE_URL: url } : {}, GITHUB ? "github" : "local");
  const report: Record<string, unknown> = { feed: url || "github:MuhammadFaizan-prog/Lens" };
  try {
    const current = await page.evaluate(() => (document.getElementById("version")?.textContent ?? ""));
    report.current = current;
    await page.waitForFunction(() => (window as any).lensRecorder.state().update.status === "available", null, { timeout: 120_000 });
    const avail = await page.evaluate(() => (window as any).lensRecorder.state().update);
    const banner = await page.locator("[data-testid=update]").innerText();
    report.available = avail;
    report.banner = banner;
    expect(banner).toContain(`Update available v${avail.version}`);
    await expect(page.locator("[data-testid=update-btn]")).toHaveText("Update");
    const t0 = Date.now();
    await page.locator("[data-testid=update-btn]").click();
    await page.waitForFunction(() => ["downloaded", "error"].includes((window as any).lensRecorder.state().update.status), null, { timeout: 500_000, polling: 500 });
    const done = await page.evaluate(() => (window as any).lensRecorder.state().update);
    report.downloaded = { ...done, seconds: (Date.now() - t0) / 1000 };
    expect(done.status, done.message).toBe("downloaded");
    await expect(page.locator("[data-testid=update-btn]")).toHaveText("Restart to update");
    const fileSha = await sha512(done.file);
    report.fileSha512 = fileSha;
    expect(fileSha).toBe(done.sha512);
    if (FEED) {
      const yml = fs.readFileSync(path.join(FEED, "latest.yml"), "utf8");
      const ymlSha = /^sha512: (.+)$/m.exec(yml)![1]!.trim();
      const exe = fs.readdirSync(FEED).find((f) => f.endsWith(".exe"))!;
      report.ymlSha512 = ymlSha;
      expect(fileSha).toBe(ymlSha);
      expect(await sha512(path.join(FEED, exe))).toBe(ymlSha);
    }
    // the update never writes outside its cache: the recordings folder is untouched
    report.recordingsDir = fs.existsSync(path.join(ud, "rec")) ? fs.readdirSync(path.join(ud, "rec")) : [];
    expect(report.recordingsDir).toEqual([]);
  } finally {
    fs.writeFileSync(path.join(ud, "update-report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    await app.close().catch(() => undefined);
    srv?.close();
  }
});

test("a feed whose sha512 does not match the installer is refused", async () => {
  test.skip(!OLD_APP || !FEED, "needs LENS_UPDATE_OLD_APP and LENS_UPDATE_FEED");
  test.setTimeout(600_000);
  // flip the sha512 to the hash of other bytes (both the file entry and the top-level field)
  const bogus = crypto.createHash("sha512").update("not the installer").digest("base64");
  const srv = await serve(FEED, (y) => y.replace(/sha512: .+/g, `sha512: ${bogus}`));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`;
  const { app, page, ud } = await launch({ LENS_UPDATE_URL: url }, "tampered");
  try {
    await page.waitForFunction(() => (window as any).lensRecorder.state().update.status === "available", null, { timeout: 120_000 });
    await page.locator("[data-testid=update-btn]").click();
    await page.waitForFunction(() => ["downloaded", "error"].includes((window as any).lensRecorder.state().update.status), null, { timeout: 500_000, polling: 500 });
    const st = await page.evaluate(() => (window as any).lensRecorder.state().update);
    fs.writeFileSync(path.join(ud, "update-report.json"), JSON.stringify(st, null, 2));
    console.log(JSON.stringify(st));
    expect(st.status).toBe("error");
    expect(String(st.message)).toMatch(/sha512/i);
  } finally {
    await app.close().catch(() => undefined);
    srv.close();
  }
  await sleep(100);
});
