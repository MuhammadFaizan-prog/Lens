/**
 * Windows #18: recorder home File menu. "Import Video to Create Project" turns an mp4 into a Lens
 * bundle that opens in the editor and exports; History lists the recordings newest first with a
 * thumbnail, and Delete (after the confirm) removes one.
 * Bounds: menu shows both entries; import -> editor ready, screen.mp4 frames = duration x fps +- 1,
 * mic.wav from the file's audio, zoom.auto false, events header-only; export state "done" with a video
 * and an audio stream, |A - V| <= 0.1 s; the h264 fixture is remuxed (video "copy"); a 60 s 1080p VP9 webm shows
 * "Importing… N%" and Cancel leaves no folder; a non-video file shows "Import failed: ...no video stream"; History lists 3 (2 earlier + the import) newest first, all
 * with thumbnails; Delete -> 2 listed and the folder is gone. (The native file dialog is skipped:
 * the test passes the path to the same import call.)
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { RUNS, appLaunchOptions, ffprobeJson, makeBundle, sleep, startXvfb } from "./helpers";

const DISPLAY = Number(process.env.LENS_E2E_DISPLAY ?? 71);
let xvfb: ChildProcess | null = null;
let app: ElectronApplication | null = null;

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  xvfb?.kill();
});

test("File menu: import a video, export it, history lists and deletes", async () => {
  test.setTimeout(420_000);
  const run = path.join(RUNS, `file-menu-${Date.now()}`);
  const recDir = path.join(run, "rec");
  fs.mkdirSync(recDir, { recursive: true });
  makeBundle(path.join(recDir, "Lens-2026-01-01_10-00-00"), { seconds: 2 });
  await sleep(1100);
  makeBundle(path.join(recDir, "Lens-2026-01-02_10-00-00"), { seconds: 2 });
  const fixture = path.join(run, "talk.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=25:d=4", "-f", "lavfi", "-i", "sine=f=440:d=4:sample_rate=44100",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "1", "-shortest", fixture]);
  // a long 1080p VP9 webm: the re-encode path, long enough to cancel from the UI
  const longWebm = path.join(run, "long.webm");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30:d=60", "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "2M", longWebm]);
  const notVideo = path.join(run, "notes.mp4");
  fs.writeFileSync(notVideo, "not a video");
  await sleep(1100);

  xvfb = await startXvfb(DISPLAY, 1280, 720);
  app = await electron.launch({
    ...appLaunchOptions(),
    env: { ...process.env, DISPLAY: `:${DISPLAY}`, LENS_E2E: "1", LENS_LOWMEM: "1", LENS_RECORDINGS_DIR: recDir, LENS_USER_DATA: path.join(run, "ud"), LENS_NO_UPDATE: "1" },
    timeout: 60_000,
  });
  const pages: Page[] = [];
  app.on("window", (p) => pages.push(p));
  const rec = await app.firstWindow();
  await rec.waitForFunction(() => !!(window as any).lensRecorder, null, { timeout: 30_000 });
  const report: Record<string, any> = { packaged: !!process.env.LENS_PACKAGED_APP };

  await rec.click('[data-testid="file-menu"]');
  report.menu = [await rec.locator('[data-testid="menu-history"]').isVisible(), await rec.locator('[data-testid="menu-import"]').isVisible()];
  await rec.click('[data-testid="file-menu"]');

  // a file that is not a video: "Import failed: <reason>", and the menu works again
  await rec.evaluate((f) => (window as any).lensRecorder.importVideo(f), notVideo);
  report.badStatus = await rec.locator('[data-testid="status"]').textContent();
  report.cancelHiddenAfterFail = await rec.locator('[data-testid="import-cancel"]').isHidden();

  // VP9: progress in the status line, Cancel kills ffmpeg and removes the half-made folder
  const before = new Set(fs.readdirSync(recDir));
  await rec.evaluate((f) => { (window as any).__cancelRun = (window as any).lensRecorder.importVideo(f); }, longWebm);
  await rec.waitForFunction(() => /Importing… \d+%/.test(document.getElementById("status")?.textContent ?? "") && !/ 0%/.test(document.getElementById("status")!.textContent!), null, { timeout: 60_000 });
  report.progressStatus = await rec.locator('[data-testid="status"]').textContent();
  report.cancelVisible = await rec.locator('[data-testid="import-cancel"]').isVisible();
  await rec.click('[data-testid="import-cancel"]');
  report.cancelResult = await rec.evaluate(() => (window as any).__cancelRun);
  report.cancelStatus = await rec.locator('[data-testid="status"]').textContent();
  report.cancelLeftovers = fs.readdirSync(recDir).filter((d) => !before.has(d));
  report.cancelProgress = (await rec.evaluate(() => (window as any).lensRecorder.importLog())).length;

  // import (h264 yuv420p constant rate: remuxed, not re-encoded)
  const t0 = Date.now();
  const imp = await rec.evaluate((f) => (window as any).lensRecorder.importVideo(f), fixture);
  report.importMs = Date.now() - t0;
  expect(imp?.dir, "imported").toBeTruthy();
  report.importVideo = imp.video;
  const dir: string = imp.dir;
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  const proj = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
  const probe = ffprobeJson(["-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", path.join(dir, "screen.mp4")]);
  report.import = { meta, zoomAuto: proj.zoom?.auto, tracks: proj.audio.tracks.map((t: any) => t.id), frames: Number(probe.streams[0].nb_read_frames),
    expectFrames: Math.round((meta.durationMs / 1000) * meta.fps), eventLines: fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n").length };

  let ed: Page | undefined;
  for (let i = 0; i < 300 && !ed; i++) {
    ed = app.windows().find((p) => p.url().includes("dir="));
    if (!ed) await sleep(200);
  }
  expect(ed, "editor window").toBeTruthy();
  await ed!.waitForFunction(() => (window as any).__lens?.state().status === "ready", null, { timeout: 120_000 });
  await ed!.evaluate(() => (window as any).__lens.store.edit("360p", (p: any) => ({ ...p, output: { ...p.output, resolution: 360, fps: 30 } })));
  await ed!.waitForFunction(() => (window as any).__lens.state().fps === 30, null, { timeout: 30_000 });
  await ed!.evaluate(() => (window as any).__lens.store.exportVideo(true));
  await ed!.waitForFunction(() => { const e = (window as any).__lens.store.get().exporting; return e && (e.state === "done" || e.state === "error"); }, null, { timeout: 300_000, polling: 1000 });
  const ex = await ed!.evaluate(() => (window as any).__lens.store.get().exporting);
  report.export = { state: ex.state, error: ex.error ?? null };
  if (ex.state === "done") {
    const id = fs.readdirSync(path.join(dir, ".lens-export"))[0]!;
    const out = path.join(dir, ".lens-export", id, "export.mp4");
    const p = ffprobeJson(["-show_entries", "stream=codec_type,duration", path.join(out)]);
    const v = p.streams.find((s: any) => s.codec_type === "video");
    const a = p.streams.find((s: any) => s.codec_type === "audio");
    report.export.video = Number(v?.duration);
    report.export.audio = a ? Number(a.duration) : null;
    // Settings > Export location (#19): default <save folder>/Exports gets a copy
    const exDir = path.join(recDir, "Exports");
    report.export.copies = fs.existsSync(exDir) ? fs.readdirSync(exDir).filter((f) => f.endsWith(".mp4")).map((f) => ({ f, size: fs.statSync(path.join(exDir, f)).size })) : [];
    report.export.size = fs.statSync(out).size;
  }

  // history
  report.historyCount = await rec.evaluate(() => (window as any).lensRecorder.showHistory());
  const rows = rec.locator('[data-testid="history-item"]');
  report.historyRows = await rows.count();
  report.historyFirst = await rows.first().getAttribute("data-dir");
  report.thumbs = await rec.locator('[data-testid="history-item"] img').count();
  await rec.screenshot({ path: path.join(run, "history.png") });
  rec.once("dialog", (d) => void d.accept());
  const victim = await rows.last().getAttribute("data-dir");
  await rows.last().locator('[data-testid="history-delete"]').click();
  await rec.waitForFunction(() => document.querySelectorAll('[data-testid="history-item"]').length === 2, null, { timeout: 15_000 });
  report.afterDelete = { rows: await rows.count(), victimGone: !fs.existsSync(victim!) };
  fs.writeFileSync(path.join(run, "report.json"), JSON.stringify(report, null, 2));
  console.log("file-menu report", JSON.stringify(report));

  expect(report.menu).toEqual([true, true]);
  expect(report.badStatus).toMatch(/^Import failed: .*no video stream/);
  expect(report.cancelHiddenAfterFail).toBe(true);
  expect(report.progressStatus).toMatch(/^Importing… \d+%$/);
  expect(report.cancelVisible).toBe(true);
  expect(report.cancelResult).toEqual({ cancelled: true });
  expect(report.cancelStatus).toBe("Import cancelled");
  expect(report.cancelLeftovers).toEqual([]);
  expect(report.cancelProgress).toBeGreaterThanOrEqual(2);
  expect(report.importVideo).toBe("copy");
  expect(Math.abs(report.import.frames - report.import.expectFrames)).toBeLessThanOrEqual(1);
  expect(report.import.tracks).toEqual(["mic"]);
  expect(report.import.zoomAuto).toBe(false);
  expect(report.import.eventLines).toBe(1);
  expect(report.export.state).toBe("done");
  expect(report.export.audio).not.toBeNull();
  expect(Math.abs(report.export.audio - report.export.video)).toBeLessThanOrEqual(0.1);
  expect(report.export.copies.length).toBe(1);
  expect(report.export.copies[0].size).toBe(report.export.size);
  expect(report.historyCount).toBe(3);
  expect(report.historyRows).toBe(3);
  expect(report.historyFirst).toBe(dir);
  expect(report.thumbs).toBe(3);
  expect(report.afterDelete).toEqual({ rows: 2, victimGone: true });
});
