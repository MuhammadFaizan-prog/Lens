/**
 * Voiceover (demand #17, docs/Voiceover.md) through the UI, preview vs the browser export (the shipped
 * desktop path, no Python: run with LENS_EXPORT=browser). The microphone is Chromium's fake capture
 * device fed from a WAV (--use-fake-device-for-media-stream --use-file-for-fake-audio-capture), so the
 * per-line take really goes getUserMedia -> MediaRecorder -> POST /api/voiceover.
 *
 * Bounds (set before the first run, never loosened):
 *  - Import: the lane's "+" opens a file picker; the clip (a WAV: 200 ms silence, then 1 kHz for 1 s)
 *    lands on the Voiceover lane at the playhead (srcMs 200) and opens the Audio tab;
 *  - onset of the imported clip within ±50 ms of output 400 ms, in the preview's audio (AudioEngine
 *    renderOffline, the same schedule live playback uses) AND in the exported MP4;
 *  - Gain set to -6 dB in the Audio tab: the preview level drops 6 dB ±0.5 dB;
 *  - export vs preview level (RMS over the clip's middle) within 2 dB;
 *  - per-line record: transcript line 2's ● records from the fake mic, the take lands anchored at the
 *    line's start (1800 ms) at least 600 ms long; in the export its level is > -45 dBFS, its onset is
 *    within ±50 ms of the preview's, and export vs preview level is within 2 dB;
 *  - outside the clips (0-350 ms) the export is silent (< -60 dBFS): the recording has no mic track.
 */
import { chromium, test, type Browser, type Page } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { EDITOR, expect, openEditor, shot } from "./helpers";
import { EXPORT_PATH, exportMp4, seekSrc, smallExport, urlFor, uxBundle } from "./uxHelpers";

const SR = 48000;
const FIX = path.join(EDITOR, "test-results", "voiceover");
const db = (x: number) => 20 * Math.log10(x + 1e-12);

function fixtures(): { clip: string; mic: string } {
  fs.mkdirSync(FIX, { recursive: true });
  const clip = path.join(FIX, "tone-1k.wav");
  const mic = path.join(FIX, "fake-mic.wav");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=1000:d=1:sample_rate=48000", "-af", "volume=2,adelay=200:all=1", "-ac", "1", "-c:a", "pcm_s16le", clip]);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=10:sample_rate=48000", "-af", "volume=2", "-ac", "1", "-c:a", "pcm_s16le", mic]);
  return { clip, mic };
}

/** Mono (L+R)/2 of a file's audio at 48 kHz (decoded stereo, averaged here as renderOffline does). */
function fileMono(file: string): Float32Array {
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-vn", "-f", "f32le", "-ac", "2", "-ar", String(SR), "pipe:1"], { maxBuffer: 1 << 28 });
  const b = r.stdout as Buffer;
  const x = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  const m = new Float32Array(x.length / 2);
  for (let i = 0; i < m.length; i++) m[i] = (x[2 * i]! + x[2 * i + 1]!) / 2;
  return m;
}
const rms = (s: ArrayLike<number>, a: number, b: number) => {
  let acc = 0, n = 0;
  for (let i = Math.round(a * SR); i < Math.min(s.length, Math.round(b * SR)); i++) {
    acc += s[i]! * s[i]!;
    n++;
  }
  return Math.sqrt(acc / Math.max(1, n));
};
const onsetAfter = (s: ArrayLike<number>, from: number, thr = 0.02) => {
  for (let i = Math.round(from * SR); i < s.length; i++) if (Math.abs(s[i]!) > thr) return i / SR;
  return -1;
};

async function previewAudio(page: Page, ms: number): Promise<number[]> {
  return page.evaluate(async (len) => {
    const st = (window as any).__lens.store;
    const s = st.get();
    const paths = (s.project.voiceover?.clips ?? []).map((c: any) => c.path);
    await st.audio.loadVoice(paths);
    return Array.from(await st.audio.renderOfflineMono(s.plan, 0, len) as Float32Array);
  }, ms);
}

let browser: Browser | null = null;
test.afterAll(async () => {
  await browser?.close().catch(() => undefined);
});

test("voiceover: import + per-line record through the UI; onset ±50 ms and level within 2 dB, preview vs browser export", async () => {
  test.setTimeout(420_000);
  expect(EXPORT_PATH, "run with LENS_EXPORT=browser (the desktop path)").toBe("browser");
  const { clip, mic } = fixtures();
  const sys = [process.env.LENS_CHROMIUM, "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => p && fs.existsSync(p));
  const args = ["--disable-gpu-sandbox", "--disable-dev-shm-usage", "--in-process-gpu", "--no-zygote", "--renderer-process-limit=1", "--disable-extensions",
    "--disable-background-networking", "--disable-component-update", "--disable-features=Translate,MediaRouter,OptimizationHints,site-per-process",
    "--autoplay-policy=no-user-gesture-required",
    // the fake-mic flag for tests: a real getUserMedia stream from a WAV
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${mic}`];
  browser = await chromium.launch({ args, ...(sys ? { executablePath: sys } : {}) });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  await ctx.grantPermissions(["microphone"]);
  const page = await ctx.newPage();

  const dir = uxBundle("voiceover");
  fs.writeFileSync(path.join(dir, "transcript.json"), JSON.stringify({
    version: 1, language: "en",
    words: [
      { text: "Open", startMs: 300, endMs: 500 }, { text: "the", startMs: 520, endMs: 600 }, { text: "settings.", startMs: 620, endMs: 1100 },
      { text: "Now", startMs: 1800, endMs: 2000 }, { text: "click", startMs: 2020, endMs: 2300 }, { text: "save.", startMs: 2320, endMs: 2700 },
    ],
  }));
  await openEditor(page, urlFor(dir));
  await smallExport(page, 3000);

  // ---- import through the lane's "+"
  await seekSrc(page, 200);
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("add-voiceover").click();
  await (await chooser).setFiles(clip);
  await expect(page.locator('[data-testid^="block-voiceover-vo"]')).toHaveCount(1, { timeout: 20_000 });
  const c0 = await page.evaluate(() => (window as any).__lens.store.get().project.voiceover.clips[0]);
  expect(c0.srcMs).toBe(200);
  expect(Math.abs(c0.fileMs - 1200)).toBeLessThan(30);
  await expect(page.getByTestId("tab-audio")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("vo-selected")).toBeVisible();

  const p0 = await previewAudio(page, 3000);
  const onPrev0 = onsetAfter(p0, 0);
  const lvl0 = db(rms(p0, 0.6, 1.2));
  console.log(`[voiceover] import: preview onset ${(onPrev0 * 1000).toFixed(1)} ms, level ${lvl0.toFixed(2)} dBFS`);
  expect(Math.abs(onPrev0 - 0.4)).toBeLessThanOrEqual(0.05);

  // ---- gain -6 dB in the Audio tab
  const g = page.getByTestId("vo-gain-value");
  await g.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("-6");
  await expect(g).toHaveValue("-6");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => (window as any).__lens.store.get().project.voiceover.clips[0].gainDb)).toBe(-6);
  const p1 = await previewAudio(page, 3000);
  const lvl1 = db(rms(p1, 0.6, 1.2));
  console.log(`[voiceover] gain -6 dB: preview level ${lvl1.toFixed(2)} dBFS (drop ${(lvl0 - lvl1).toFixed(2)} dB)`);
  expect(Math.abs(lvl0 - lvl1 - 6)).toBeLessThanOrEqual(0.5);

  // ---- per-line record (line 2 starts at 1800 ms) from the fake mic
  await expect(page.getByTestId("vo-line-1")).toBeVisible();
  await page.getByTestId("vo-line-record-1").click();
  await expect(page.getByTestId("voiceover-recording")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1300);
  await shot(page, "voiceover-recording");
  await page.getByTestId("vo-line-stop-1").click();
  await expect(page.locator('[data-testid^="block-voiceover-vo"]')).toHaveCount(2, { timeout: 20_000 });
  const take = await page.evaluate(() => (window as any).__lens.store.get().project.voiceover.clips.find((c: any) => c.line));
  console.log(`[voiceover] take: srcMs ${take.srcMs}, ${take.fileMs} ms, ${take.path}`);
  expect(take.srcMs).toBe(1800);
  expect(take.fileMs).toBeGreaterThanOrEqual(600);
  await expect(page.getByTestId("vo-line-1")).toHaveClass(/done/);
  await shot(page, "voiceover-lane");

  const p2 = await previewAudio(page, 3000);
  const takeEnd = Math.min(2.95, 1.8 + (take.trimEndMs - take.trimStartMs) / 1000);
  const onPrevT = onsetAfter(p2, 1.75, 0.01);
  const lvlPrevT = db(rms(p2, onPrevT + 0.1, takeEnd - 0.05));
  const lvlPrevI = db(rms(p2, 0.6, 1.2));

  // ---- browser export
  const mp4 = await exportMp4(page, dir, 300_000);
  const x = fileMono(mp4);
  const onExp0 = onsetAfter(x, 0);
  const lvlExpI = db(rms(x, 0.6, 1.2));
  const onExpT = onsetAfter(x, 1.75, 0.01);
  const lvlExpT = db(rms(x, onPrevT + 0.1, takeEnd - 0.05));
  const silent = db(rms(x, 0, 0.35));
  console.log(`[voiceover] import: export onset ${(onExp0 * 1000).toFixed(1)} ms (preview ${(onPrev0 * 1000).toFixed(1)}), level export ${lvlExpI.toFixed(2)} vs preview ${lvlPrevI.toFixed(2)} dBFS (Δ ${(lvlExpI - lvlPrevI).toFixed(2)} dB)`);
  console.log(`[voiceover] take: export onset ${(onExpT * 1000).toFixed(1)} ms vs preview ${(onPrevT * 1000).toFixed(1)} ms, level export ${lvlExpT.toFixed(2)} vs preview ${lvlPrevT.toFixed(2)} dBFS (Δ ${(lvlExpT - lvlPrevT).toFixed(2)} dB); silence before ${silent.toFixed(1)} dBFS`);
  expect(Math.abs(onExp0 - 0.4)).toBeLessThanOrEqual(0.05);
  expect(Math.abs(lvlExpI - lvlPrevI)).toBeLessThanOrEqual(2);
  expect(lvlExpT).toBeGreaterThan(-45);
  expect(Math.abs(onExpT - onPrevT)).toBeLessThanOrEqual(0.05);
  expect(Math.abs(lvlExpT - lvlPrevT)).toBeLessThanOrEqual(2);
  expect(silent).toBeLessThan(-60);
  await ctx.close();
});
