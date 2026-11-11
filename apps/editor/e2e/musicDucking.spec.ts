/**
 * Music bed with automatic ducking (demand #23), end to end through the UI on a synthetic bundle
 * (scripts/make_music_sample.mjs: "speech" = 1 kHz AM tone in [1.0, 3.5) and [6.0, 8.5) s; the
 * imported music = steady 220 + 330 Hz, 4 s, looped). Speech is found from the mic's measured
 * silences, the music is imported with the file picker, its level and duck are set with the Audio
 * tab's controls, then BOTH the preview's audio graph (AudioEngine.renderOffline, the same nodes
 * playback uses) and the exported MP4 (LENS_EXPORT=browser: the desktop app's path) are measured.
 * Loudness is read by ffmpeg's own ebur128 filter (not Lens's meter) on band-split audio:
 * speech band = 700-1400 Hz, music band = 150-450 Hz (6th-order filters).
 *
 * Bounds, set before the first run (never loosened):
 *   B1 speech band - music band, every speech window, export and preview   >= 10 LU
 *   B2 music recovers: music band in the gap - in speech (depth set to 15)  >= 12 LU (export, preview)
 *   B3 music level: music band in the gap - speech band in speech (volume set to -8 dB)  within [-11, -5] LU
 *   B4 fade in: music band in [0, 0.5) s <= gap level - 6 LU
 *   B5 preview vs export: duck depth (B2 value) and level (B3 value) each differ by <= 2 LU
 *   B6 exported frames = plan frames; audio and video durations within 0.1 s
 *   B7 built-in bed: "Use" Calm pad -> music/lens-calm-pad.wav in the project, preview gap RMS > -50 dBFS
 *   B8 Remove music -> no music in the project or the plan; Undo brings it back
 */
import { test } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EDITOR, expect, shot } from "./helpers";
import { closeAll, openLens } from "./lensApp";
import { exportMp4 } from "./uxHelpers";

test.afterAll(() => closeAll());
test.setTimeout(600_000);

const SR = 48000;

function bundle(): string {
  const root = process.env.LENS_E2E_TMP ?? os.tmpdir();
  const src = process.env.LENS_MUSIC_SAMPLE ?? path.join(EDITOR, "sample-music");
  if (!fs.existsSync(path.join(src, "screen.mp4"))) execFileSync("node", [path.join(EDITOR, "scripts", "make_music_sample.mjs"), src]);
  const dir = path.join(root, `music-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ["screen.mp4", "meta.json", "events.jsonl", "project.json", "mic.wav", "music-test.wav"]) fs.copyFileSync(path.join(src, f), path.join(dir, f));
  return dir;
}

/** Integrated loudness (ffmpeg ebur128) of [a, b) s of a file, after a band filter. */
function lufs(file: string, inFmt: string[], band: "speech" | "music" | "all", a: number, b: number): number {
  const f = band === "speech" ? "highpass=f=700:p=2,highpass=f=700:p=2,highpass=f=700:p=2,lowpass=f=1400:p=2,lowpass=f=1400:p=2,lowpass=f=1400:p=2,"
    : band === "music" ? "lowpass=f=450:p=2,lowpass=f=450:p=2,lowpass=f=450:p=2,highpass=f=150:p=2,highpass=f=150:p=2,highpass=f=150:p=2," : "";
  const r = spawnSync("ffmpeg", ["-nostats", "-hide_banner", ...inFmt, "-i", file, "-af", `aresample=48000,${f}atrim=start=${a}:end=${b},ebur128=framelog=quiet`, "-f", "null", "-"], { encoding: "utf8" });
  const m = /Integrated loudness:\s*\n\s*I:\s*(-?[\d.]+|-inf)\s*LUFS/.exec(r.stderr);
  if (!m) throw new Error(`no ebur128 reading for ${band} ${a}-${b}: ${r.stderr.slice(-400)}`);
  return m[1] === "-inf" ? -120 : Number(m[1]);
}

interface Reading { speech: number[]; musicSpeech: number[]; musicGap: number; fadeIn: number; depth: number; level: number; gap: number[] }

function measure(file: string, inFmt: string[] = []): Reading {
  // speech windows start after the attack and end before the speech does; the gap window starts after hold + release
  const W = [[1.4, 3.3], [6.4, 8.3]] as const;
  const speech = W.map(([a, b]) => lufs(file, inFmt, "speech", a, b));
  const musicSpeech = W.map(([a, b]) => lufs(file, inFmt, "music", a, b));
  const musicGap = lufs(file, inFmt, "music", 4.6, 5.8);
  const fadeIn = lufs(file, inFmt, "music", 0, 0.5);
  const meanMs = 10 * Math.log10((Math.pow(10, musicSpeech[0]! / 10) + Math.pow(10, musicSpeech[1]! / 10)) / 2);
  const meanSp = 10 * Math.log10((Math.pow(10, speech[0]! / 10) + Math.pow(10, speech[1]! / 10)) / 2);
  return { speech, musicSpeech, musicGap, fadeIn, depth: musicGap - meanMs, level: musicGap - meanSp, gap: speech.map((s, i) => s - musicSpeech[i]!) };
}

const r1 = (x: number) => Math.round(x * 10) / 10;

test("music bed: import, duck controls, preview and export measured", async () => {
  const dir = bundle();
  const lens = await openLens(dir, { w: 1600, h: 1000 });
  const page = lens.page;
  // the mic's measured silences (they define the speech) arrive after the bundle
  await page.waitForFunction(() => { const b = (window as any).__lens.store.get().bundle; return b && !b.silencesPending; }, null, { timeout: 60_000 });

  await page.getByTestId("tab-audio").click();
  await expect(page.getByTestId("music-import")).toBeVisible();
  await page.getByTestId("music-import-input").setInputFiles(path.join(dir, "music-test.wav"));
  await expect(page.getByTestId("music-name")).toHaveText("music-test.wav", { timeout: 30_000 });
  const setNum = async (id: string, v: number) => {
    const inp = page.getByTestId(`${id}-value`);
    await inp.click();
    await inp.press("Control+a");
    await inp.pressSequentially(String(v));
    await inp.press("Enter");
    await page.waitForTimeout(200);
    console.log(id, "->", await inp.inputValue(), JSON.stringify(await page.evaluate(() => { const m = (window as any).__lens.store.get().project.audio.music; return { v: m.volumeDb, d: m.duck.depthDb }; })));
  };
  await setNum("music-volume", -8);
  await setNum("music-depth", 15);
  await page.waitForTimeout(400);
  const music = await page.evaluate(() => (window as any).__lens.store.get().project.audio.music);
  console.log("project music", JSON.stringify(music));
  expect(music).toMatchObject({ path: "music/music-test.wav", volumeDb: -8, duck: { enabled: true, depthDb: 15 } });
  expect(fs.existsSync(path.join(dir, "music", "music-test.wav"))).toBe(true);
  const mp = await page.evaluate(() => (window as any).__lens.store.get().plan.audio.music);
  console.log("plan music speech", JSON.stringify(mp.speech), "duck keys", mp.duck.length);
  await expect(page.getByTestId("music-status")).toHaveText(/Ducks under 2 stretches of speech/);
  await expect(page.getByTestId("music-graph-speech")).toHaveCount(2);
  await shot(page, "music-panel");

  // preview: the playback graph rendered offline
  const b64 = await page.evaluate(async () => {
    const s = (window as any).__lens.store;
    const x: Float32Array = await s.audio.renderOffline(s.get().plan, 0, 10);
    const u = new Uint8Array(x.buffer);
    let bin = "";
    for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return btoa(bin);
  });
  const prevFile = path.join(dir, "preview.f32");
  fs.writeFileSync(prevFile, Buffer.from(b64, "base64"));
  const raw = ["-f", "f32le", "-ar", String(SR), "-ac", "2"];
  const pv = measure(prevFile, raw);
  console.log("preview LU: speech", pv.speech.map(r1), "music in speech", pv.musicSpeech.map(r1), "music gap", r1(pv.musicGap), "fade-in", r1(pv.fadeIn),
    "| speech-music", pv.gap.map(r1), "depth", r1(pv.depth), "level", r1(pv.level), "| musicState", JSON.stringify(await page.evaluate(() => (window as any).__lens.store.audio.musicState())));

  // export (browser path = desktop app)
  const mp4 = await exportMp4(page, dir, 480_000);
  const ex = await page.evaluate(() => (window as any).__lens.store.get().exporting);
  const mix = JSON.parse(fs.readFileSync(path.join(dir, ".lens-export", ex.id, "music-mix.json"), "utf8"));
  const ev = measure(mp4);
  console.log("export LU: speech", ev.speech.map(r1), "music in speech", ev.musicSpeech.map(r1), "music gap", r1(ev.musicGap), "fade-in", r1(ev.fadeIn),
    "| speech-music", ev.gap.map(r1), "depth", r1(ev.depth), "level", r1(ev.level), "| mix", JSON.stringify(mix));
  const probe = (sel: string, entries: string) => spawnSync("ffprobe", ["-v", "error", "-select_streams", sel, "-count_frames", "-show_entries", entries, "-of", "csv=p=0", mp4], { encoding: "utf8" }).stdout.trim();
  const frames = parseFloat(probe("v:0", "stream=nb_read_frames")); // csv rows can end in "," (side data)
  const vDur = parseFloat(probe("v:0", "stream=duration"));
  const aDur = parseFloat(probe("a:0", "stream=duration"));
  const planFrames = await page.evaluate(() => (window as any).__lens.state().frames);
  console.log("frames", frames, "plan", planFrames, "video", vDur, "s audio", aDur, "s");

  for (const r of [ev, pv]) {
    for (const g of r.gap) expect(g).toBeGreaterThanOrEqual(10); // B1
    expect(r.depth).toBeGreaterThanOrEqual(12); // B2
    expect(r.level).toBeGreaterThanOrEqual(-11); // B3
    expect(r.level).toBeLessThanOrEqual(-5);
    expect(r.fadeIn).toBeLessThanOrEqual(r.musicGap - 6); // B4
  }
  console.log("preview vs export: depth", r1(pv.depth - ev.depth), "level", r1(pv.level - ev.level));
  expect(Math.abs(pv.depth - ev.depth)).toBeLessThanOrEqual(2); // B5
  expect(Math.abs(pv.level - ev.level)).toBeLessThanOrEqual(2);
  expect(frames).toBe(planFrames); // B6
  expect(Math.abs(aDur - vDur)).toBeLessThanOrEqual(0.1);

  // B7: a built-in bed
  await page.evaluate(() => (window as any).__lens.store.closeExport?.());
  await page.getByTestId("music-builtin").selectOption("calm-pad");
  await page.getByTestId("music-add-builtin").click();
  await expect(page.getByTestId("music-name")).toHaveText("Calm pad", { timeout: 30_000 });
  const bm = await page.evaluate(() => (window as any).__lens.store.get().project.audio.music);
  expect(bm).toMatchObject({ path: "music/lens-calm-pad.wav", source: "builtin:calm-pad", volumeDb: -8, duck: { depthDb: 15 } });
  const rms = await page.evaluate(async () => {
    const s = (window as any).__lens.store;
    const x: Float32Array = await s.audio.renderOffline(s.get().plan, 0, 6);
    let acc = 0, n = 0;
    for (let i = Math.round(4.6 * 48000); i < Math.round(5.8 * 48000); i++) { acc += x[2 * i]! * x[2 * i]!; n++; }
    return 10 * Math.log10(acc / n + 1e-20);
  });
  console.log("built-in bed preview RMS in the gap", r1(rms), "dBFS");
  expect(rms).toBeGreaterThan(-50);

  // B8: remove + undo
  await page.getByTestId("music-remove").click();
  expect(await page.evaluate(() => { const s = (window as any).__lens.store.get(); return [s.project.audio.music ?? null, s.plan.audio?.music ?? null]; })).toEqual([null, null]);
  await expect(page.getByTestId("music-add-builtin")).toHaveText("Add built-in music");
  await page.evaluate(() => (window as any).__lens.store.undo());
  expect(await page.evaluate(() => (window as any).__lens.store.get().project.audio.music?.path)).toBe("music/lens-calm-pad.wav");
  await lens.close();
});
