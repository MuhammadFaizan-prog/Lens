/**
 * Windows bug #5 on the packaged app: speech-to-text runs in-app (whisper.cpp + base.en from
 * resources/lens/assets/models/whisper), with no Python on PATH.
 * - auto-run: a fresh recording with a mic (recording.json autoTranscribe, as Stop writes it) opened
 *   in the editor transcribes by itself, no click;
 * - the Transcribe button on the Transcript tab transcribes a recording that has no transcript.
 * Bounds (set before measuring): both runs finish without error; >= 80 % of the scripted content words
 * recognised; the editor's transcript holds the words afterwards.
 */
import { _electron as electron, expect, test } from "@playwright/test";
import { execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RUNS, appLaunchOptions, sleep, startXvfb } from "./helpers";

const DISPLAY = Number(process.env.LENS_E2E_DISPLAY ?? 97);
let xvfb: ChildProcess | null = null;
test.beforeAll(async () => (xvfb = await startXvfb(DISPLAY, 1600, 1000)));
test.afterAll(() => xvfb?.kill());

const WANT = ["hello", "everyone", "this", "quick", "demo", "editor", "now", "open", "settings", "page", "change", "theme"];

/** A desktop-shaped recording: screen.mp4, mic.wav (48 kHz stereo, from a mono Opus webm), project.json, recording.json. */
function makeBundle(dir: string, auto: boolean): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const ff = (...a: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a]);
  execFileSync("espeak-ng", ["-v", "en-us", "-s", "150", "-w", path.join(dir, "a.wav"), "Um, hello everyone. This is a quick demo of the editor."]);
  execFileSync("espeak-ng", ["-v", "en-us", "-s", "150", "-w", path.join(dir, "b.wav"), "Uh, now we open the settings page and change the theme."]);
  ff("-i", path.join(dir, "a.wav"), "-f", "lavfi", "-t", "1.5", "-i", "anullsrc=r=22050:cl=mono", "-i", path.join(dir, "b.wav"),
    "-filter_complex", "[0:a][1:a][2:a]concat=n=3:v=0:a=1,aresample=48000", "-ac", "1", "-c:a", "libopus", "-b:a", "64k", path.join(dir, "mic.webm"));
  ff("-i", path.join(dir, "mic.webm"), "-vn", "-af", "aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo:sample_rates=48000", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", path.join(dir, "mic.wav"));
  ff("-f", "lavfi", "-i", "color=c=gray:s=640x360:r=30:d=11", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(dir, "screen.mp4"));
  for (const f of ["a.wav", "b.wav", "mic.webm"]) fs.rmSync(path.join(dir, f));
  fs.writeFileSync(path.join(dir, "events.jsonl"), "");
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ width: 640, height: 360, fps: 30, durationMs: 11000 }));
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ version: 1, audio: { tracks: [{ id: "mic", kind: "mic", path: "mic.wav", offsetMs: 0, volume: 1, muted: false }] } }));
  fs.writeFileSync(path.join(dir, "recording.json"), JSON.stringify({ app: "lens-desktop", autoTranscribe: auto }));
}

const recall = (words: string[]) => {
  const got = new Set(words.map((w) => w.toLowerCase().replace(/[^a-z']/g, "")));
  return WANT.filter((w) => got.has(w)).length / WANT.length;
};

// LENS_STT_MODES=button runs one of them (a retry on a box short of memory)
for (const mode of (process.env.LENS_STT_MODES ?? "auto,button").split(",") as Array<"auto" | "button">) {
  test(`speech-to-text without Python (packaged app): ${mode}`, async () => {
    test.setTimeout(600_000);
    const bundle = path.join(RUNS, "pkg-stt", mode);
    makeBundle(bundle, mode === "auto");
    const PATH = (process.env.PATH ?? "").split(path.delimiter).filter((d) => !fs.existsSync(path.join(d, "python3")) && !fs.existsSync(path.join(d, "python"))).join(path.delimiter);
    const app = await electron.launch({
      ...appLaunchOptions(),
      env: { ...process.env, PATH, DISPLAY: `:${DISPLAY}`, LENS_LOWMEM: "1", LENS_NO_UPDATE: "1", LENS_OPEN_BUNDLE: bundle, LENS_USER_DATA: path.join(os.tmpdir(), `lens-ud-${Date.now()}`) },
    });
    try {
      let ed = null;
      for (let i = 0; i < 120 && !ed; i++) {
        ed = app.windows().find((p) => p.url().includes("dir=")) ?? null;
        if (!ed) await sleep(500);
      }
      expect(ed, "editor window").toBeTruthy();
      await ed!.waitForFunction(() => (window as any).__lens?.state().status === "ready", null, { timeout: 120_000 });
      const t0 = Date.now();
      if (mode === "button") {
        await sleep(1500);
        expect(await ed!.evaluate(() => (window as any).__lens.store.get().transcribeRun), "no auto-run without recording.json autoTranscribe").toBeNull();
        await ed!.getByTestId("left-tab-transcript").click();
        await ed!.getByTestId("transcribe").click();
      }
      await ed!.waitForFunction(() => {
        const r = (window as any).__lens.store.get().transcribeRun;
        return r && (r.state === "done" || r.state === "error");
      }, null, { timeout: 300_000 });
      const run = await ed!.evaluate(() => (window as any).__lens.store.get().transcribeRun);
      const words: string[] = await ed!.evaluate(() => ((window as any).__lens.store.get().bundle.transcript?.words ?? []).map((w: { text: string }) => w.text));
      const report = { mode, packaged: !!process.env.LENS_PACKAGED_APP, state: run.state, auto: run.auto, error: run.error, words: words.length, recall: recall(words), seconds: (Date.now() - t0) / 1000, text: words.join(" ") };
      fs.writeFileSync(path.join(RUNS, "pkg-stt", `${mode}.json`), JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report));
      expect(run.state, run.error).toBe("done");
      expect(run.auto).toBe(mode === "auto");
      expect(report.recall).toBeGreaterThanOrEqual(0.8);
      expect(fs.existsSync(path.join(bundle, "transcript.json"))).toBe(true);
    } finally {
      await app.close().catch(() => undefined);
    }
  });
}
