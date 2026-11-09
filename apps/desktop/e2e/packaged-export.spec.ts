/**
 * Windows bug #10 on the packaged app: a project whose mic is what v0.1.0 wrote from a MediaRecorder
 * mono Opus mic (mono s16 WAV, no channel layout in the header), and the raw mono Opus webm itself,
 * export from the bundled editor with loudness on (the default), on the ffmpeg the app ships.
 * Bounds (set before measuring): export state "done"; MP4 has an audio and a video stream and
 * |audio - video| duration <= 0.1 s; the mic is audible in the export (RMS > -40 dBFS).
 */
import { _electron as electron, expect, test } from "@playwright/test";
import { execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO, RUNS, appLaunchOptions, ffprobeJson, makeBundle, sleep, startXvfb } from "./helpers";

const DISPLAY = Number(process.env.LENS_E2E_DISPLAY ?? 97);
let xvfb: ChildProcess | null = null;
test.beforeAll(async () => (xvfb = await startXvfb(DISPLAY, 1600, 1000)));
test.afterAll(() => xvfb?.kill());

const FIX = path.join(REPO, "apps", "editor", "test", "fixtures", "audio", "mono-opus.webm");

for (const kind of ["mono-wav", "mono-opus-webm"] as const) {
  test(`export with a ${kind} mic (packaged app)`, async () => {
    test.setTimeout(400_000);
    const work = path.join(RUNS, `pkg-export-${kind}`);
    fs.mkdirSync(work, { recursive: true });
    let mic = FIX;
    if (kind === "mono-wav") {
      mic = path.join(work, "mic.wav");
      execFileSync("ffmpeg", ["-v", "error", "-y", "-i", FIX, "-vn", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", mic]); // v0.1.0's Stop step
    }
    const bundle = makeBundle(path.join(work, "bundle"), { seconds: 5, mic });
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
      await ed!.evaluate(() => (window as any).__lens.store.edit("720p30", (p: any) => ({ ...p, output: { ...p.output, resolution: 360, fps: 30 } })));
      await ed!.waitForFunction(() => (window as any).__lens.state().fps === 30, null, { timeout: 30_000 });
      await ed!.evaluate(() => (window as any).__lens.store.exportVideo(true));
      await ed!.waitForFunction(() => { const e = (window as any).__lens.store.get().exporting; return e && (e.state === "done" || e.state === "error"); }, null, { timeout: 300_000, polling: 1000 });
      const ex = await ed!.evaluate(() => (window as any).__lens.store.get().exporting);
      expect(ex.state, ex.error).toBe("done");
      const id = fs.readdirSync(path.join(bundle, ".lens-export"))[0]!;
      const out = path.join(bundle, ".lens-export", id, "export.mp4");
      const p = ffprobeJson(["-show_entries", "stream=codec_type,duration", out]);
      const v = Number(p.streams.find((s: any) => s.codec_type === "video").duration);
      const a = Number(p.streams.find((s: any) => s.codec_type === "audio").duration);
      const err = execFileSync("sh", ["-c", `ffmpeg -hide_banner -i "${out}" -vn -af volumedetect -f null - 2>&1`], { encoding: "utf8" });
      const mean = Number(/mean_volume: (-?[\d.]+) dB/.exec(err)?.[1] ?? -99);
      const report = { kind, packaged: !!process.env.LENS_PACKAGED_APP, video: v, audio: a, diff: Math.abs(a - v), meanDb: mean, seconds: ex.seconds };
      fs.writeFileSync(path.join(work, "report.json"), JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report));
      expect(Math.abs(a - v)).toBeLessThanOrEqual(0.1);
      expect(mean).toBeGreaterThan(-40);
    } finally {
      await app.close().catch(() => undefined);
    }
  });
}
