/**
 * Share link with bring-your-own storage (demand #13), through the editor UI against a local mock
 * S3 server (e2e/mockS3.ts: verifies every SigV4 signature and body hash itself).
 *
 * Sample: the UX sample (6 s checkerboard) at 360p30 with two chapters in project.chapters.
 *
 * Bounds (set before the first run; the first two items were added after run 5, see docs/Tracker.md):
 *  - the Share tab is fully visible in the inspector tab strip at 1600 x 1000 without scrolling;
 *  - a wrong secret: Test connection shows the storage's 403 and the message names no key; the
 *    editor server log has that error;
 *  - Share tab: storage form; Save shows the key as its last 4 characters only; Test connection
 *    passes and the mock saw a signed PUT + DELETE of a .lens-check object;
 *  - Upload & copy link (no export yet: it exports first): link shown within 10 min, starts with the
 *    public URL; store.share.copied true (and the clipboard holds the link when it can be read);
 *  - the mock received exactly 3 PUTs for the share (video, poster, page), 0 rejected requests;
 *    sha256(uploaded video) == sha256(export file on disk) == the job's sha256;
 *    poster is a JPEG of the export's size; page stored as text/html;
 *  - the link opened in a fresh page: <h1> is the typed title, the chapter list shows both chapters
 *    in order, the <video> reaches readyState >= 2 within 30 s, its duration is within 0.2 s of the
 *    export's, no request leaves the mock origin, no console error;
 *  - private bucket (no public URL): the link is presigned (X-Amz-Signature), anonymous GETs of the
 *    objects are refused (403) and the page still plays (readyState >= 2);
 *  - the secret key appears nowhere: editor server log, browser console, every file in the bundle
 *    (project.json, exports, caches), the store's project, /api/share/config, the share job JSON, the
 *    uploaded page; the access key ID appears in none of these either, except inside the presigned
 *    link / page of the private-bucket case (a presigned URL carries the key ID by design).
 * The editor server log is read from LENS_E2E_SERVER_LOG (the run starts the server with its output
 * in that file); without it the log check fails rather than being skipped.
 */
import { test, type Page } from "@playwright/test";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { EDITOR, expect } from "./helpers";
import { closeAll, openLens } from "./lensApp";
import { startMockS3, type MockS3 } from "./mockS3";
import { uxBundle } from "./uxHelpers";

test.afterAll(() => closeAll());

const AKID = "LENSE2EAKID7Q4ZK";
const SECRET = "lensE2E/secret+Zx81Kq0pWm3Vb7Nt5Rr2";
const BUCKET = "lens-e2e";
const TITLE = "Share e2e: checkerboard demo";

const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

function containsIn(file: string, needles: string[]): string[] {
  const b = fs.readFileSync(file);
  return needles.filter((n) => b.includes(Buffer.from(n)));
}

async function openShared(page: Page, url: string, mockOrigin: string) {
  const ctx = await page.context().browser()!.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  const foreign: string[] = [];
  const errors: string[] = [];
  p.on("request", (r) => {
    if (!r.url().startsWith(mockOrigin) && !r.url().startsWith("data:")) foreign.push(r.url());
  });
  p.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(url);
  const h1 = await p.locator("h1").textContent();
  const chapters = await p.locator(".chapters li .n").allTextContents();
  await p.waitForFunction(() => (document.getElementById("v") as HTMLVideoElement).readyState >= 2, null, { timeout: 30_000 });
  const v = await p.evaluate(() => {
    const e = document.getElementById("v") as HTMLVideoElement;
    return { readyState: e.readyState, duration: e.duration, w: e.videoWidth, h: e.videoHeight };
  });
  await ctx.close();
  return { h1, chapters, v, foreign, errors };
}

test("share link: BYO S3 storage, signed uploads, viewer page plays, credentials never leak", async () => {
  test.setTimeout(900_000);
  const serverLog = process.env.LENS_E2E_SERVER_LOG;
  const mock: MockS3 = await startMockS3(BUCKET, { accessKeyId: AKID, secretAccessKey: SECRET });
  const dir = uxBundle("share", {
    output: { resolution: 360, fps: 30 },
    chapters: { title: "", description: "", embed: false, items: [{ id: "c1", srcMs: 0, title: "Intro" }, { id: "c2", srcMs: 3000, title: "Second part" }] },
  });
  const lens = await openLens(dir, { w: 1600, h: 1000 });
  const page = lens.page;
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);
  const consoleText: string[] = [];
  page.on("console", (m) => consoleText.push(m.text()));
  try {
    // start from no saved storage
    await page.evaluate(() => fetch("/api/share/config", { method: "DELETE" }));
    await page.evaluate(() => (window as any).__lens.store.loadShareConfig());

    // ---- the Share tab is visible in the inspector's tab strip without scrolling (1600 x 1000)
    const vis = await page.evaluate(() => {
      const t = document.querySelector('[data-testid="tab-share"]')!.getBoundingClientRect();
      const n = document.querySelector(".inspector .tabs")!.getBoundingClientRect();
      return { t: [t.left, t.right], n: [n.left, n.right] };
    });
    console.log("share tab", JSON.stringify(vis));
    expect(vis.t[0]!).toBeGreaterThanOrEqual(vis.n[0]! - 0.5);
    expect(vis.t[1]!).toBeLessThanOrEqual(vis.n[1]! + 0.5);

    // ---- a wrong secret: Test connection fails with the storage's 403, the error names no key
    await page.getByTestId("tab-share").click();
    await page.getByTestId("share-provider").selectOption("custom");
    await page.getByTestId("share-endpoint").fill(mock.url);
    await page.getByTestId("share-bucket").fill(BUCKET);
    await page.getByTestId("share-region").fill("us-east-1");
    await page.getByTestId("share-akid").fill(AKID);
    await page.getByTestId("share-secret").fill(SECRET + "WRONG");
    await page.getByTestId("share-save").click();
    await page.getByTestId("share-test").click();
    await expect(page.getByTestId("share-error")).toContainText("403", { timeout: 30_000 });
    const errText = (await page.getByTestId("share-error").textContent()) ?? "";
    console.log("wrong-secret error:", errText);
    expect(errText.includes(AKID) || errText.includes(SECRET)).toBe(false);
    await page.getByTestId("share-edit").click();

    // ---- configure storage through the form
    await expect(page.getByTestId("share-form")).toBeVisible();
    await page.getByTestId("share-provider").selectOption("custom");
    await page.getByTestId("share-endpoint").fill(mock.url);
    await page.getByTestId("share-bucket").fill(BUCKET);
    await page.getByTestId("share-region").fill("us-east-1");
    await page.getByTestId("share-akid").fill(AKID);
    await page.getByTestId("share-secret").fill(SECRET);
    await page.getByTestId("share-public").fill(`${mock.url}/${BUCKET}`);
    await page.getByTestId("share-prefix").fill("e2e shares");
    await page.getByTestId("share-save").click();
    await expect(page.getByTestId("share-summary")).toBeVisible();
    await expect(page.getByTestId("share-summary")).toContainText(`key …${AKID.slice(-4)}`);
    const cfgJson = await page.evaluate(async () => await (await fetch("/api/share/config")).text());
    expect(cfgJson.includes(SECRET)).toBe(false);
    expect(cfgJson.includes(AKID)).toBe(false);

    await page.getByTestId("share-test").click();
    await expect(page.getByTestId("share-test-ok")).toBeVisible({ timeout: 30_000 });
    const check = mock.log.filter((r) => r.path.includes(".lens-check"));
    expect(check.map((r) => `${r.method} ${r.status}`)).toEqual(["PUT 403", "PUT 200", "DELETE 204"]);
    fs.mkdirSync(path.join(EDITOR, "test-results", "screens"), { recursive: true });
    await page.screenshot({ path: path.join(EDITOR, "test-results", "screens", "share-tab.png") });

    // ---- share (exports first)
    expect(await page.evaluate(() => (window as any).__lens.store.get().exporting)).toBeNull();
    expect(fs.readFileSync(serverLog ?? "/dev/null", "utf8")).toContain("storage answered 403");
    await page.getByTestId("share-title").fill(TITLE);
    await expect(page.getByTestId("share-chapters")).toContainText("2 chapters");
    const before = mock.log.length;
    await page.getByTestId("share-go").click();
    await expect(page.getByTestId("share-url")).toBeVisible({ timeout: 600_000 });
    const st = await page.evaluate(() => {
      const s = (window as any).__lens.store.get();
      return { share: s.share, exporting: s.exporting };
    });
    const url: string = st.share.job.url;
    console.log("share link", url, "copied", st.share.copied);
    expect(url.startsWith(`${mock.url}/${BUCKET}/e2e%20shares/`)).toBe(true);
    expect(url.endsWith("/index.html")).toBe(true);
    expect(st.share.copied).toBe(true);
    const clip = await page.evaluate(async () => {
      try {
        return await navigator.clipboard.readText();
      } catch {
        return null;
      }
    });
    console.log("clipboard readable", clip !== null);
    if (clip !== null) expect(clip).toBe(url);
    await page.screenshot({ path: path.join(EDITOR, "test-results", "screens", "share-done.png") });

    const puts = mock.log.slice(before).filter((r) => r.method === "PUT");
    const rejected = mock.log.filter((r) => r.status >= 400 && r.status !== 404 && !r.path.includes(".lens-check"));
    console.log("share PUTs", puts.map((r) => `${r.path} ${r.status}`).join(" | "));
    expect(puts.length).toBe(3);
    expect(puts.every((r) => r.status === 200 && r.signed === "header")).toBe(true);
    expect(rejected).toEqual([]);

    // the export Share made (its sheet stays closed, so store.exporting is cleared): named by the job
    expect(st.exporting).toBeNull();
    const exportFile = path.join(dir, ".lens-export", st.share.job.exportId, "export.mp4");
    const exportSha = sha(fs.readFileSync(exportFile));
    const keys = st.share.job.keys as { video: string; poster: string; page: string };
    const vid = mock.objects.get(keys.video)!;
    const poster = mock.objects.get(keys.poster)!;
    const pg = mock.objects.get(keys.page)!;
    console.log(`export sha256 ${exportSha} uploaded ${sha(vid.body)} job ${st.share.job.sha256} (${vid.body.length} bytes)`);
    expect(sha(vid.body)).toBe(exportSha);
    expect(st.share.job.sha256).toBe(exportSha);
    expect(vid.contentType).toBe("video/mp4");
    expect(poster.body.subarray(0, 2).toString("hex")).toBe("ffd8");
    const probe = (f: string) => spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", f], { encoding: "utf8" }).stdout;
    const posterFile = path.join(dir, "..", `share-poster-${Date.now()}.jpg`);
    fs.writeFileSync(posterFile, poster.body);
    const pj = JSON.parse(probe(posterFile)).streams[0];
    const ej = JSON.parse(probe(exportFile));
    expect([pj.width, pj.height]).toEqual([ej.streams[0].width, ej.streams[0].height]);
    expect(pg.contentType).toBe("text/html; charset=utf-8");

    // ---- open the link
    const o = await openShared(page, url, mock.url);
    console.log(`viewer: h1 ${JSON.stringify(o.h1)} chapters ${JSON.stringify(o.chapters)} video ${JSON.stringify(o.v)} export duration ${ej.format.duration} foreign ${o.foreign.length} errors ${o.errors.length}`);
    expect(o.h1).toBe(TITLE);
    expect(o.chapters).toEqual(["Intro", "Second part"]);
    expect(o.v.readyState).toBeGreaterThanOrEqual(2);
    expect(Math.abs(o.v.duration - Number(ej.format.duration))).toBeLessThanOrEqual(0.2);
    expect(o.foreign).toEqual([]);
    expect(o.errors).toEqual([]);

    // ---- private bucket: presigned link
    console.log("private bucket case");
    await page.screenshot({ path: path.join(EDITOR, "test-results", "screens", "share-before-edit.png") });
    await page.getByTestId("share-edit").click({ timeout: 15_000 });
    await page.getByTestId("share-public").fill("", { timeout: 15_000 });
    await page.getByTestId("share-save").click({ timeout: 15_000 });
    await expect(page.getByTestId("share-summary")).toContainText("presigned links");
    mock.setPublic(false);
    const prevUrl = url;
    await page.getByTestId("share-go").click();
    await page.waitForFunction((u) => {
      const j = (window as any).__lens.store.get().share.job;
      return j && j.state !== "running" && j.url !== u;
    }, prevUrl, { timeout: 300_000 });
    const job2 = await page.evaluate(() => (window as any).__lens.store.get().share.job);
    expect(job2.state).toBe("done");
    const url2: string = job2.url;
    expect(url2).toContain("X-Amz-Signature=");
    const anon = await fetch(`${mock.url}/${BUCKET}/${job2.keys.video.split("/").map(encodeURIComponent).join("/")}`);
    expect(anon.status).toBe(403);
    const o2 = await openShared(page, url2, mock.url);
    console.log(`private viewer: video ${JSON.stringify(o2.v)} foreign ${o2.foreign.length} errors ${o2.errors.length}`);
    expect(o2.v.readyState).toBeGreaterThanOrEqual(2);
    expect(o2.chapters).toEqual(["Intro", "Second part"]);
    expect(o2.foreign).toEqual([]);
    mock.setPublic(true);

    // ---- credentials nowhere
    const leaks: string[] = [];
    if (!serverLog) leaks.push("LENS_E2E_SERVER_LOG not set: editor server log not checked");
    else for (const n of containsIn(serverLog, [SECRET, AKID])) leaks.push(`server log has ${n === SECRET ? "secret" : "key ID"}`);
    for (const t of consoleText) {
      if (t.includes(SECRET)) leaks.push("browser console has secret");
      if (t.includes(AKID)) leaks.push("browser console has key ID");
    }
    await page.evaluate(() => (window as any).__lens.store.save?.());
    for (const f of filesUnder(dir)) for (const n of containsIn(f, [SECRET, AKID])) leaks.push(`${path.relative(dir, f)} has ${n === SECRET ? "secret" : "key ID"}`);
    const projJson = await page.evaluate(() => JSON.stringify((window as any).__lens.store.get().project));
    if (projJson.includes(SECRET) || projJson.includes(AKID)) leaks.push("store project has a key");
    const jobJson = await page.evaluate(async (id) => await (await fetch(`/api/share/upload/${id}`)).text(), st.share.job.id);
    if (jobJson.includes(SECRET) || jobJson.includes(AKID)) leaks.push("public share job JSON has a key");
    const job2Json = JSON.stringify(job2);
    if (job2Json.includes(SECRET)) leaks.push("private share job has the secret");
    if (pg.body.includes(Buffer.from(SECRET)) || pg.body.includes(Buffer.from(AKID))) leaks.push("public viewer page has a key");
    const pg2 = mock.objects.get(job2.keys.page)!;
    if (pg2.body.includes(Buffer.from(SECRET))) leaks.push("private viewer page has the secret");
    for (const [k, ob] of mock.objects) if (ob.body.includes(Buffer.from(SECRET))) leaks.push(`uploaded object ${k} has the secret`);
    console.log(`credential scan: ${filesUnder(dir).length} bundle files, server log ${serverLog ? fs.statSync(serverLog).size : 0} bytes, ${consoleText.length} console lines; leaks ${JSON.stringify(leaks)}`);
    expect(leaks).toEqual([]);
  } finally {
    await page.evaluate(() => fetch("/api/share/config", { method: "DELETE" })).catch(() => undefined);
    await lens.close();
    await mock.close();
  }
});
