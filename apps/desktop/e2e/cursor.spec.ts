/**
 * Windows #9 (double cursor): the captured screen.mp4 must not contain the OS cursor, because Lens
 * draws its own cursor on top in the editor and export. "Show system cursor" keeps it (positive
 * control: proves this detector sees a baked-in cursor at all).
 *
 * Method (Xvfb + the synthetic scene, whose grid is static except a bar at the bottom): the pointer is
 * parked at P1 for 1.5 s, then at P2 for 1.5 s. For each point, the 32x32 crop down-right of the
 * hotspot (where the arrow sprite is drawn) in a frame from the middle of its own hold is compared with
 * the same crop from the middle of the other hold, when the pointer was far away. With no cursor in
 * the video the two crops are the same static background (mean |diff| ~ codec noise); with the cursor
 * baked in they differ by the sprite.
 * Bounds: a crop pair with <= 5 changed pixels (|diff| > 48) = no cursor in the video, >= 40 = cursor
 * baked in (the first run used mean |diff|, which a small low-contrast sprite dilutes to ~4.8 at P2:
 * replaced by the changed-pixel count before the second run; the second run measured 67/17 and 71/17
 * changed px, so 'baked' = >= 40 at one point and > 5 at the other) (anything between fails). "Show system cursor" on -> baked at both points.
 * Chromium (Electron 38) does not implement cursor: "never" yet (crbug 394133543), so on Xvfb (and
 * Windows) the OS cursor is baked in either way; what must hold is that Lens never shows two cursors:
 * recording.json cursor.baked matches what the pixels show, and project.json turns Lens's own cursor
 * off exactly when the OS cursor is in the video. If a future Chromium honours "never", the same test
 * passes with baked=false and Lens's cursor on.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { RUNS, appLaunchOptions, decodeFrames, epoch, sleep, startScene, startXvfb, xdo } from "./helpers";

const DISPLAY = Number(process.env.LENS_E2E_DISPLAY ?? 71);
const W = 1280;
const H = 720;
const P1 = { x: 220, y: 160 };
const P2 = { x: 1010, y: 210 };
const CROP = 32;
const B = { neverMaxDiff: 5, alwaysMinDiff: 40 };

let xvfb: ChildProcess | null = null;
let scene: ChildProcess | null = null;
let app: ElectronApplication | null = null;

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  scene?.kill();
  xvfb?.kill();
});

/** Pixels of the crop pair that differ by > 48 in any channel (a cursor sprite is ~100+ px; codec noise ~0). */
function meanDiff(a: Buffer, b: Buffer): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 3) if (Math.abs(a[i]! - b[i]!) > 48 || Math.abs(a[i + 1]! - b[i + 1]!) > 48 || Math.abs(a[i + 2]! - b[i + 2]!) > 48) n++;
  return n;
}

async function recordOnce(run: string, mode: "never" | "always"): Promise<Record<string, unknown>> {
  app = await electron.launch({
    ...appLaunchOptions(),
    env: { ...process.env, DISPLAY: `:${DISPLAY}`, LENS_E2E: "1", LENS_LOWMEM: "1", LENS_RECORDINGS_DIR: path.join(run, `rec-${mode}`), LENS_USER_DATA: path.join(run, `ud-${mode}`), LENS_NO_UPDATE: "1" },
    timeout: 60_000,
  });
  const rec: Page = await app.firstWindow();
  await rec.waitForFunction(() => (window as any).lensRecorder?.state().sources.some((s: any) => s.kind === "screen"), null, { timeout: 30_000 });
  await rec.locator("#syscursor").setChecked(mode === "always");
  xdo(DISPLAY, "mousemove", String(P1.x), String(P1.y));
  await sleep(300);
  xdo(DISPLAY, "key", "ctrl+shift+r");
  await rec.waitForFunction(() => (window as any).lensRecorder.state().state === "recording", null, { timeout: 30_000, polling: 20 });
  await sleep(500);
  xdo(DISPLAY, "mousemove", String(P1.x), String(P1.y));
  const h1 = epoch();
  await sleep(1500);
  xdo(DISPLAY, "mousemove", String(P2.x), String(P2.y));
  const h2 = epoch();
  await sleep(1500);
  xdo(DISPLAY, "key", "ctrl+shift+r");
  let result: any = null;
  for (let i = 0; i < 900 && !result; i++) {
    result = await app.evaluate(() => (globalThis as any).lensLastResult ?? null);
    if (!result) await sleep(200);
  }
  expect(result, "recording saved").toBeTruthy();
  await app.close().catch(() => undefined);
  app = null;
  const info = JSON.parse(fs.readFileSync(path.join(result.dir, "recording.json"), "utf8"));
  const mp4 = path.join(result.dir, "screen.mp4");
  const tMid1 = (h1 + 750 - info.videoStartEpoch) / 1000;
  const tMid2 = (h2 + 750 - info.videoStartEpoch) / 1000;
  const near = (fr: Array<{ pts: number; rgb: Buffer }>, t: number) => fr.reduce((a, b) => (Math.abs(b.pts - t) < Math.abs(a.pts - t) ? b : a));
  const c1 = await decodeFrames(mp4, CROP, CROP, { x: P1.x, y: P1.y });
  const c2 = await decodeFrames(mp4, CROP, CROP, { x: P2.x, y: P2.y });
  const d1 = meanDiff(near(c1, tMid1).rgb, near(c1, tMid2).rgb); // P1 crop: pointer there vs away
  const d2 = meanDiff(near(c2, tMid2).rgb, near(c2, tMid1).rgb); // P2 crop: pointer there vs away
  const proj = JSON.parse(fs.readFileSync(path.join(result.dir, "project.json"), "utf8"));
  return { mode, dir: result.dir, cursor: info.cursor, lensCursorVisible: proj.cursor?.visible ?? true, capture: info.capture, frames: c1.length, tMid1, tMid2, diffP1: +d1.toFixed(2), diffP2: +d2.toFixed(2) };
}

test("never two cursors: OS cursor in screen.mp4 <=> Lens cursor off", async () => {
  test.setTimeout(600_000);
  const run = path.join(RUNS, `cursor-${Date.now()}`);
  fs.mkdirSync(run, { recursive: true });
  xvfb = await startXvfb(DISPLAY, W, H);
  scene = startScene(DISPLAY, W, H, path.join(run, "scene.jsonl"));
  await sleep(2000);
  const report: Record<string, unknown> = { bounds: B, packaged: !!process.env.LENS_PACKAGED_APP };
  report.never = await recordOnce(run, "never");
  report.always = await recordOnce(run, "always");
  fs.writeFileSync(path.join(run, "report.json"), JSON.stringify(report, null, 2));
  console.log("cursor report", JSON.stringify(report));
  const n = report.never as any;
  const a = report.always as any;
  const pix = (r: any) => {
    const both = [r.diffP1, r.diffP2];
    if (both.every((d: number) => d <= B.neverMaxDiff)) return false;
    // baked: a full sprite at one point and more than noise at the other (the X arrow over the
    // P2 background changes ~17 px, at P1 ~70 px)
    if (Math.max(...both) >= B.alwaysMinDiff && Math.min(...both) > B.neverMaxDiff) return true;
    throw new Error(`ambiguous cursor pixels ${both}`);
  };
  expect(n.cursor?.requested).toBe("never");
  expect(n.cursor?.api).toBe("getDisplayMedia");
  expect(a.cursor?.requested).toBe("always");
  expect(pix(a), "positive control: system cursor visible in the video").toBe(true);
  for (const r of [n, a]) {
    const baked = pix(r);
    expect(r.cursor?.baked, `${r.mode}: recording.json says baked=${r.cursor?.baked}, pixels say ${baked}`).toBe(baked);
    expect(r.lensCursorVisible, `${r.mode}: Lens cursor must be off when the OS cursor is in the video`).toBe(!baked);
  }
});
