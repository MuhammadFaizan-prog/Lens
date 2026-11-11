/**
 * Platform export presets (demand #24, docs/ExportPresets.md), through the UI on the export path the
 * run selects (LENS_EXPORT=browser = the shipped desktop app's path, no Python), measured on the file.
 *
 * Bounds (set before the first run, not to be loosened):
 *   1. YouTube Shorts picked in Export > Video: project output 1080x1920 @ 30; exported stream exactly
 *      1080x1920, r_frame_rate 30/1, frame count = plan frames, average video bitrate <= 15 Mbps (the
 *      preset's 10 Mbps x 1.5 peak).
 *   2. App Store iPhone 886x1920: exported 886x1920, frame rate <= 30 fps, average video bitrate <= 12
 *      Mbps (Apple's ceiling); the 6 s sample shows the "shorter than 15 s" warning in the dialog.
 *   3. Custom, 20 Mbps, 0.4 MB size cap typed in the dialog: first encode over the cap (job cap.before
 *      > cap), final file <= 400,000 bytes, >= 1 re-encode pass, duration within 1 frame of the plan,
 *      audio stream kept when the sample has one.
 *   4. GIF preset, 10 fps / 480 px typed in the dialog: header button reads "Export GIF", file starts
 *      GIF89a, 480 px wide, height = round(480 x canvas h / w) +- 2, frames = round(duration x 10) +- 2,
 *      NETSCAPE loop block present, the sheet offers "Download GIF".
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { test, type Page } from "@playwright/test";
import { expect, shot } from "./helpers";
import { closeAll, openLens, PACKAGED } from "./lensApp";
import { EXPORT_PATH, uxBundle } from "./uxHelpers";

test.afterAll(() => closeAll());

interface Probe {
  width: number;
  height: number;
  rate: string;
  frames: number;
  bitrate: number;
  duration: number;
  audio: boolean;
}

function probe(file: string): Probe {
  const r = spawnSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=codec_type,width,height,r_frame_rate,nb_read_frames,bit_rate:format=duration", "-of", "json", file], { encoding: "utf8" });
  const j = JSON.parse(r.stdout);
  const v = j.streams.find((s: any) => s.codec_type === "video");
  return { width: v.width, height: v.height, rate: v.r_frame_rate, frames: Number(v.nb_read_frames), bitrate: Number(v.bit_rate), duration: Number(j.format.duration), audio: j.streams.some((s: any) => s.codec_type === "audio") };
}

async function openVideoTab(page: Page) {
  await page.getByTestId("export-preset-open").click();
  await expect(page.getByTestId("export-dialog")).toBeVisible();
  await expect(page.getByTestId("export-preset")).toBeVisible();
}

/** Export from the dialog (or the header button) and return the server job once done. */
async function runExport(page: Page, dir: string, from: "dialog" | "header" = "dialog"): Promise<any> {
  await page.getByTestId(from === "dialog" ? "export-video-go" : "export").click();
  const warn = page.getByTestId("export-warning-anyway");
  if (await warn.isVisible().catch(() => false)) await warn.click();
  await page.waitForFunction(() => { const e = (window as any).__lens.store.get().exporting; return e && (e.state === "done" || e.state === "error"); }, null, { timeout: 300_000, polling: 500 });
  const ex = await page.evaluate(() => (window as any).__lens.store.get().exporting);
  if (ex.state !== "done") throw new Error(`export failed: ${ex.error}`);
  expect(ex.path === "browser" ? "browser" : "compositor").toBe(EXPORT_PATH);
  const job = await page.evaluate(async ([id, d]) => (await fetch(`/api/export/${id}?dir=${encodeURIComponent(d)}`)).json(), [ex.id, dir]);
  expect(job.state).toBe("done");
  return job;
}

async function closeSheet(page: Page) {
  await page.evaluate(() => (window as any).__lens.store.closeExport());
}

test("platform presets: Shorts and App Store sizes, frame rate and bitrate on the exported file", async () => {
  const dir = uxBundle("presets-size");
  const lens = await openLens(dir, { w: 1280, h: 720 });
  const page = lens.page;
  await expect(page.getByTestId("export-preset-open")).toHaveText("Preset: none");

  // 1. YouTube Shorts
  await openVideoTab(page);
  await page.getByTestId("export-preset").selectOption("youtube-shorts");
  await expect(page.getByTestId("export-preset-note")).toContainText("1080×1920");
  const out = await page.evaluate(() => (window as any).__lens.store.get().project.output);
  expect(out.size).toEqual({ w: 1080, h: 1920 });
  expect(out.fps).toBe(30);
  const planFrames = await page.evaluate(() => (window as any).__lens.state().frames);
  await shot(page, `presets-dialog-shorts${PACKAGED ? "-app" : ""}`);
  const j1 = await runExport(page, dir);
  const p1 = probe(j1.out);
  console.log("shorts", JSON.stringify(p1), "plan frames", planFrames);
  expect([p1.width, p1.height]).toEqual([1080, 1920]);
  expect(p1.rate).toBe("30/1");
  expect(p1.frames).toBe(planFrames);
  expect(p1.bitrate).toBeLessThanOrEqual(15e6);
  await closeSheet(page);
  await expect(page.getByTestId("export-preset-open")).toHaveText("YouTube Shorts");

  // 2. App Store iPhone portrait
  await openVideoTab(page);
  await page.getByTestId("export-preset").selectOption("appstore-iphone-portrait");
  await expect(page.getByTestId("export-check-duration-min")).toBeVisible();
  const j2 = await runExport(page, dir);
  const p2 = probe(j2.out);
  const [n, d] = p2.rate.split("/").map(Number);
  console.log("appstore", JSON.stringify(p2), "fps", (n! / d!).toFixed(3));
  expect([p2.width, p2.height]).toEqual([886, 1920]);
  expect(n! / d!).toBeLessThanOrEqual(30);
  expect(p2.bitrate).toBeLessThanOrEqual(12e6);
  await closeSheet(page);
  await lens.close();
});

test("platform presets: size cap re-encode and GIF", async () => {
  const dir = uxBundle("presets-cap");
  const lens = await openLens(dir, { w: 1280, h: 720 });
  const page = lens.page;

  // 3. Custom with a bitrate and a size cap typed in the dialog
  await openVideoTab(page);
  await page.getByTestId("export-preset").selectOption("custom");
  await page.getByTestId("export-bitrate").fill("20");
  await page.getByTestId("export-bitrate").press("Enter");
  await page.getByTestId("export-size-cap").fill("0.4");
  await page.getByTestId("export-size-cap").press("Enter");
  const v = await page.evaluate(() => (window as any).__lens.store.get().project.export.video);
  expect(v).toEqual({ preset: "custom", bitrateMbps: 20, maxSizeMB: 0.4 });
  const durationMs = await page.evaluate(() => (window as any).__lens.store.get().plan.output.durationMs);
  const fps = await page.evaluate(() => (window as any).__lens.store.get().plan.output.fps);
  const hasAudio = await page.evaluate(() => !!(window as any).__lens.store.get().plan.audio);
  const j3 = await runExport(page, dir);
  const size = fs.statSync(j3.out).size;
  const p3 = probe(j3.out);
  console.log("cap", JSON.stringify(j3.cap), "file bytes", size, "duration", p3.duration, "plan", durationMs / 1000, "audio", p3.audio, "(plan audio", hasAudio + ")");
  expect(j3.cap.before).toBeGreaterThan(400_000);
  expect(j3.cap.passes).toBeGreaterThanOrEqual(1);
  expect(size).toBeLessThanOrEqual(400_000);
  expect(Math.abs(p3.duration - durationMs / 1000)).toBeLessThanOrEqual(1 / fps + 1e-3);
  if (hasAudio) expect(p3.audio).toBe(true);
  await expect(page.getByTestId("export-result")).toContainText("re-encoded");
  await shot(page, `presets-capped${PACKAGED ? "-app" : ""}`);
  await closeSheet(page);

  // 4. GIF
  await openVideoTab(page);
  await page.getByTestId("export-preset").selectOption("gif");
  await page.getByTestId("export-gif-fps").fill("10");
  await page.getByTestId("export-gif-fps").press("Enter");
  await page.getByTestId("export-gif-width").fill("480");
  await page.getByTestId("export-gif-width").press("Enter");
  await page.getByTestId("export-dialog-close").click();
  await expect(page.getByTestId("export")).toContainText("GIF");
  const canvas = await page.evaluate(() => (window as any).__lens.store.get().plan.output);
  const j4 = await runExport(page, dir, "header");
  expect(j4.format).toBe("gif");
  const buf = fs.readFileSync(j4.out);
  const w = buf.readUInt16LE(6);
  const h = buf.readUInt16LE(8);
  const p4 = probe(j4.out);
  const wantH = Math.round((480 * canvas.height) / canvas.width);
  const wantFrames = Math.round((canvas.durationMs / 1000) * 10);
  console.log("gif", w, "x", h, "(want 480 x", wantH + ")", "frames", p4.frames, "(want", wantFrames + ")", "bytes", buf.length);
  expect(buf.subarray(0, 6).toString("latin1")).toBe("GIF89a");
  expect(w).toBe(480);
  expect(Math.abs(h - wantH)).toBeLessThanOrEqual(2);
  expect(Math.abs(p4.frames - wantFrames)).toBeLessThanOrEqual(2);
  expect(buf.includes(Buffer.from("NETSCAPE2.0", "latin1"))).toBe(true);
  await expect(page.getByTestId("export-download")).toContainText("Download GIF");
  await shot(page, `presets-gif${PACKAGED ? "-app" : ""}`);
  await lens.close();
});
