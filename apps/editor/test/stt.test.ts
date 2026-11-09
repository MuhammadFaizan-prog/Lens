/**
 * In-app speech-to-text (Windows bug #5): whisper.cpp + Whisper base.en (q5_1), no Python.
 * - token -> word joining, filler flags and pauses from whisper.cpp's `-ojf` JSON;
 * - a mic recording shaped like the desktop app's (espeak-ng speech with fillers and a pause, encoded
 *   as a mono 48 kHz Opus webm like Chromium's MediaRecorder, then turned into mic.wav 48 kHz stereo
 *   the way recording.ts does at Stop, with a 500 ms track offset) is transcribed through the editor
 *   API exactly as the editor drives it: GET /api/bundle reports autoTranscribe for a fresh recording
 *   (recording.json autoTranscribe, written at Stop), POST /api/transcribe?auto=1 runs, the poll returns
 *   the transcript, transcript.json is written, and the next open no longer auto-runs.
 * Bounds (set before measuring): >= 80 % of the scripted content words recognised; every word time
 * >= the 500 ms offset; the 1.5 s scripted pause found as a pause >= 1 s; job done in < 120 s.
 * Needs ffmpeg, espeak-ng, and assets/models/whisper (fetch-models.mjs + scripts/build-whisper.sh);
 * skipped otherwise.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { whisperCli, whisperModel } from "../server/models";
import { isFiller, keptSpans, mapBack, pausesBetween, wordsFromWhisperJson } from "../server/stt";
import { parseSilencedetect, trimWordsToSilences } from "../server/silence";

describe("whisper.cpp JSON -> words", () => {
  it("joins tokens into words, flags fillers, keeps times monotonic", () => {
    const j = {
      transcription: [
        {
          text: " Um, hello there.",
          offsets: { from: 0, to: 1500 },
          tokens: [
            { text: "[_BEG_]", p: 0.9, offsets: { from: 0, to: 0 } },
            { text: " Um", p: 0.6, offsets: { from: 100, to: 300 } },
            { text: ",", p: 0.9, offsets: { from: 300, to: 310 } },
            { text: " hel", p: 0.8, offsets: { from: 400, to: 600 } },
            { text: "lo", p: 1.0, offsets: { from: 600, to: 800 } },
            { text: " there", p: 0.9, offsets: { from: 790, to: 1100 } },
            { text: ".", p: 0.9, offsets: { from: 1100, to: 1110 } },
          ],
        },
      ],
    };
    const w = wordsFromWhisperJson(j, 500);
    expect(w.map((x) => x.text)).toEqual(["Um,", "hello", "there."]);
    expect(w[0]!.filler).toBe(true);
    expect(w[1]).toMatchObject({ startMs: 900, endMs: 1300, confidence: 0.9 });
    expect(w[2]!.startMs).toBeGreaterThanOrEqual(w[1]!.endMs);
    expect(isFiller("Uh...")).toBe(true);
    expect(isFiller("under")).toBe(false);
  });
  it("finds pauses between spoken words, ignoring fillers", () => {
    const words = [
      { text: "one", startMs: 0, endMs: 300 },
      { text: "um", startMs: 800, endMs: 1000, filler: true },
      { text: "two", startMs: 2000, endMs: 2300 },
    ];
    expect(pausesBetween(words, 3000, 0)).toEqual([{ startMs: 300, endMs: 2000 }, { startMs: 2300, endMs: 3000 }]);
  });
});

describe("silence-shortened decoding", () => {
  it("keeps 300 ms of each long silence and maps decoded times back", () => {
    const keep = keptSpans([{ startMs: 1000, endMs: 3000 }, { startMs: 4000, endMs: 4400 }], 6000);
    expect(keep).toEqual([{ startMs: 0, endMs: 1150 }, { startMs: 2850, endMs: 6000 }]);
    const back = mapBack(keep);
    expect(back(500)).toBe(500);
    expect(back(1150)).toBe(2850);
    expect(back(1150, true)).toBe(1150);
    expect(back(1300)).toBe(3000);
  });
  it("parses silencedetect output and trims words out of silences", () => {
    const sil = parseSilencedetect("[silencedetect @ 0x1] silence_start: 1.5\n[silencedetect @ 0x1] silence_end: 3.25 | silence_duration: 1.75\n[silencedetect @ 0x1] silence_start: 9.0\n", 10000);
    expect(sil).toEqual([{ startMs: 1500, endMs: 3250 }, { startMs: 9000, endMs: 10000 }]);
    const w = trimWordsToSilences([{ startMs: 1000, endMs: 2000 }, { startMs: 3000, endMs: 3600 }, { startMs: 1200, endMs: 4000 }], sil);
    expect(w).toEqual([{ startMs: 1000, endMs: 1500 }, { startMs: 3250, endMs: 3600 }, { startMs: 3250, endMs: 4000 }]);
  });
});

const has = (c: string, a: string[]) => spawnSync(c, a).status === 0;
const ready = has("ffmpeg", ["-version"]) && has("espeak-ng", ["--version"]) && !!whisperCli() && !!whisperModel();

describe.skipIf(!ready)("transcribe a mic recording through the editor API", () => {
  let dir = "";
  let server: http.Server;
  let base = "";
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lens-stt-"));
    const ff = (...a: string[]) => {
      const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...a]);
      if (r.status !== 0) throw new Error(r.stderr.toString());
    };
    const say = (text: string, out: string) => {
      const r = spawnSync("espeak-ng", ["-v", "en-us", "-s", "150", "-w", out, text]);
      if (r.status !== 0) throw new Error(r.stderr.toString());
    };
    say("Um, hello everyone. This is a quick demo of the editor.", path.join(dir, "a.wav"));
    say("Uh, now we open the settings page and change the theme.", path.join(dir, "b.wav"));
    // speech, 1.5 s silence, speech -> mono 48 kHz Opus webm (Chromium MediaRecorder's mic format)
    ff("-i", path.join(dir, "a.wav"), "-f", "lavfi", "-t", "1.5", "-i", "anullsrc=r=22050:cl=mono", "-i", path.join(dir, "b.wav"),
      "-filter_complex", "[0:a][1:a][2:a]concat=n=3:v=0:a=1,aresample=48000", "-ac", "1", "-c:a", "libopus", "-b:a", "64k", path.join(dir, "mic.webm"));
    // what recording.ts writes at Stop
    ff("-i", path.join(dir, "mic.webm"), "-vn", "-af", "aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo:sample_rates=48000", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", path.join(dir, "mic.wav"));
    ff("-f", "lavfi", "-i", "color=c=gray:s=320x180:r=30:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(dir, "screen.mp4"));
    fs.writeFileSync(path.join(dir, "events.jsonl"), "");
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ width: 320, height: 180, fps: 30, durationMs: 2000 }));
    fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ version: 1, audio: { tracks: [{ id: "mic", kind: "mic", path: "mic.wav", offsetMs: 500, volume: 1, muted: false }] } }));
    fs.writeFileSync(path.join(dir, "recording.json"), JSON.stringify({ app: "lens-desktop", autoTranscribe: true }));
    const { apiMiddleware } = await import("../server/api");
    const mw = apiMiddleware();
    server = http.createServer((req, res) => void mw(req, res, () => res.writeHead(404).end()));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }, 60_000);
  afterAll(() => {
    server?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("auto-runs once on a fresh recording and writes transcript.json", async () => {
    const q = `?dir=${encodeURIComponent(dir)}`;
    const b1 = await (await fetch(`${base}/api/bundle${q}`)).json();
    expect(b1.hasMic).toBe(true);
    expect(b1.autoTranscribe).toBe(true);
    const t0 = Date.now();
    const start = await (await fetch(`${base}/api/transcribe${q}&auto=1`, { method: "POST" })).json();
    expect(start.state).toBe("running");
    let st: { state: string; done: number; result?: { words: Array<{ text: string; startMs: number; endMs: number; filler?: boolean }>; pauses: Array<{ startMs: number; endMs: number }> }; error?: string };
    for (;;) {
      st = await (await fetch(`${base}/api/transcribe/${start.id}${q}`)).json();
      if (st.state !== "running") break;
      await new Promise((r) => setTimeout(r, 300));
    }
    const seconds = (Date.now() - t0) / 1000;
    expect(st.error).toBeUndefined();
    expect(st.state).toBe("done");
    const words = st.result!.words;
    const got = new Set(words.map((w) => w.text.toLowerCase().replace(/[^a-z']/g, "")));
    const want = ["hello", "everyone", "this", "quick", "demo", "editor", "now", "open", "settings", "page", "change", "theme"];
    const recall = want.filter((w) => got.has(w)).length / want.length;
    const fillers = words.filter((w) => w.filler).map((w) => w.text);
    const longPause = st.result!.pauses.find((p) => p.endMs - p.startMs >= 1000);
    if (process.env.STT_DEBUG) console.log(JSON.stringify({ w: words.map((w) => [w.text, w.startMs, w.endMs]), p: st.result!.pauses }));
    console.log(JSON.stringify({ seconds, words: words.length, recall, fillers, firstStart: words[0]?.startMs, longPause, text: words.map((w) => w.text).join(" ") }));
    expect(recall).toBeGreaterThanOrEqual(0.8);
    expect(Math.min(...words.map((w) => w.startMs))).toBeGreaterThanOrEqual(500);
    expect(longPause).toBeTruthy();
    // the scripted pause is 1.5 s of digital silence; words after it start where the sound starts (<= 300 ms)
    expect(longPause!.endMs - longPause!.startMs).toBeGreaterThanOrEqual(1400);
    expect(Math.min(...words.filter((w) => w.startMs >= longPause!.startMs).map((w) => Math.abs(w.startMs - longPause!.endMs)))).toBeLessThanOrEqual(300);
    expect(seconds).toBeLessThan(120);
    expect(fs.existsSync(path.join(dir, "transcript.json"))).toBe(true);
    const b2 = await (await fetch(`${base}/api/bundle${q}`)).json();
    expect(b2.autoTranscribe).toBe(false);
    expect(b2.transcript.words.length).toBe(words.length);
  }, 180_000);
});
