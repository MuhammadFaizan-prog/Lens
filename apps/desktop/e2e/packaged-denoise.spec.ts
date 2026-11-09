/**
 * Windows bug #16 on the packaged app: the Noise reduction toggle now does something, in the export
 * (ffmpeg arnndn + the bundled RNNoise model) and in preview playback (RNNoise wasm worklet), and the
 * export has the click sound and the 3 ms fades at cuts again.
 * Bounds (set before measuring), noisy espeak fixture (hiss + rumble + hum ~ -44 dBFS, 2 s pauses):
 * - export with noise reduction vs the source mic (loudness off, so only the denoise differs; the
 *   export without denoise is the mic itself, checked by exportAudio.test.ts): noise floor in the
 *   pauses drops >= 10 dB, speech level within 1 dB;
 * - preview: the editor's RNNoise worklet (bundled assets) on the same samples: same two bounds;
 * - export with click sound on and one click at 1.0 s: >= -30 dBFS RMS in the 15 ms after 1.0 s in
 *   the denoised export's otherwise quiet lead-in.
 */
import { _electron as electron, expect, test } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RUNS, appLaunchOptions, decodeMono, levelDb, makeBundle, noisySpeechWav, sleep, startXvfb } from "./helpers";

const DISPLAY = Number(process.env.LENS_E2E_DISPLAY ?? 97);
let xvfb: ChildProcess | null = null;
test.beforeAll(async () => (xvfb = await startXvfb(DISPLAY, 1600, 1000)));
test.afterAll(() => xvfb?.kill());

test("noise reduction in export and preview, clicks (packaged app)", async () => {
  test.setTimeout(500_000);
  const work = path.join(RUNS, "pkg-denoise");
  const { wav, spans, samples } = noisySpeechWav(path.join(work, "fixture"));
  const secs = samples.length / 48000;
  const bundle = makeBundle(path.join(work, "bundle"), { seconds: Math.ceil(secs), mic: wav });
  fs.appendFileSync(path.join(bundle, "events.jsonl"), '{"t":1000,"type":"down","x":320,"y":180,"button":"left"}\n{"t":1060,"type":"up","x":320,"y":180,"button":"left"}\n');
  const app = await electron.launch({
    ...appLaunchOptions(),
    env: { ...process.env, DISPLAY: `:${DISPLAY}`, LENS_LOWMEM: "1", LENS_NO_UPDATE: "1", LENS_OPEN_BUNDLE: bundle, LENS_USER_DATA: path.join(os.tmpdir(), `lens-ud-${Date.now()}`) },
  });
  try {
    let ed = null;
    for (let i = 0; i < 120 && !ed; i++) {
      ed = app.windows().find((p) => p.url().includes("dir=")) ?? null;
      if (!ed) await sleep(500);
    }
    expect(ed, "editor window").toBeTruthy();
    await ed!.waitForFunction(() => (window as any).__lens?.state().status === "ready", null, { timeout: 120_000 });
    const exportWith = async (nr: boolean, clicks: boolean) => {
      await ed!.evaluate(([nr, clicks]) => (window as any).__lens.store.edit("test audio", (p: any) => ({
        ...p, output: { ...p.output, resolution: 360, fps: 30 }, zoom: { ...p.zoom, enabled: false },
        cursor: { ...p.cursor, clickSound: clicks, clickSoundVolume: 0.5 },
        audio: { ...p.audio, loudness: { ...p.audio.loudness, enabled: false }, noiseReduction: { enabled: nr, amountDb: 12 } },
      })), [nr, clicks]);
      await sleep(500);
      await ed!.evaluate(() => (window as any).__lens.store.exportVideo(true));
      await ed!.waitForFunction(() => { const e = (window as any).__lens.store.get().exporting; return e && (e.state === "done" || e.state === "error"); }, null, { timeout: 300_000, polling: 1000 });
      const ex = await ed!.evaluate(() => (window as any).__lens.store.get().exporting);
      expect(ex.state, ex.error).toBe("done");
      return decodeMono(ex.out ?? path.join(bundle, ".lens-export", ex.id, "export.mp4"));
    };
    const off = samples;
    const on = await exportWith(true, true);
    const quiet: Array<[number, number]> = [[1.3, spans[0]![0] - 0.3], ...spans.slice(0, -1).map((s, i) => [s[1] + 0.3, spans[i + 1]![0] - 0.3] as [number, number])];
    const exDrop = levelDb(off, quiet) - levelDb(on, quiet);
    const exSpeech = levelDb(on, spans) - levelDb(off, spans);
    const click = levelDb(on, [[1.0, 1.015]]);
    // preview: the editor's own RNNoise worklet, bundled with the packaged editor
    const pv = Float32Array.from(await ed!.evaluate(async (x: number[]) => Array.from(await (window as any).__lens.store.audio.denoiseOffline(Float32Array.from(x))), Array.from(samples)));
    let lag = 0;
    let best = -Infinity;
    for (let d = 0; d <= 1500; d += 4) {
      let c = 0;
      for (let i = Math.round(spans[0]![0] * 48000); i < Math.round(spans[0]![0] * 48000) + 48000; i += 4) c += samples[i]! * (pv[i + d] ?? 0);
      if (c > best) [best, lag] = [c, d];
    }
    const pvs = pv.subarray(lag);
    const pvDrop = levelDb(samples, quiet) - levelDb(pvs, quiet);
    const pvSpeech = levelDb(pvs, spans) - levelDb(samples, spans);
    const report = { packaged: !!process.env.LENS_PACKAGED_APP, export: { floorOff: levelDb(off, quiet), floorOn: levelDb(on, quiet), drop: exDrop, speechDb: exSpeech, clickDb: click },
      preview: { lag, drop: pvDrop, speechDb: pvSpeech } };
    fs.writeFileSync(path.join(work, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    expect(exDrop).toBeGreaterThanOrEqual(10);
    expect(Math.abs(exSpeech)).toBeLessThanOrEqual(1);
    expect(click).toBeGreaterThanOrEqual(-30);
    expect(pvDrop).toBeGreaterThanOrEqual(10);
    expect(Math.abs(pvSpeech)).toBeLessThanOrEqual(1);
  } finally {
    await app.close().catch(() => undefined);
  }
});
