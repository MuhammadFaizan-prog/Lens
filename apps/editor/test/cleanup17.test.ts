/**
 * Windows bug #17: Cleanup ("Remove fillers" / "Shorten pauses" / "Longest pause") did nothing.
 * Fixture: speech with "um" / "uh" and two 4 s pauses over a -54 dBFS noise floor, as a desktop
 * recording (mic.wav 48 kHz stereo, 300 ms track offset). Through the editor API and the in-app export:
 * 1. no transcript: GET /api/silences returns the mic's measured silences (in the background, not in /api/bundle); with "Shorten pauses" on, the
 *    plan has cleanup cuts (the Cuts lane), and in the exported MP4 every pause is <= Longest pause
 *    + 50 ms, |audio - video| <= 50 ms, and the last phrase starts where the cut map puts it (+-50 ms);
 * 2. with the in-app transcript (whisper.cpp): "Remove fillers" cuts every filler word, and
 *    transcribing the export finds no filler left and >= 80 % of the content words.
 * Needs ffmpeg, ffprobe, espeak-ng; part 2 also the whisper model (skipped otherwise).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRenderPlan, parseEventLog, resolveProject, type ProjectConfig, type RenderPlan } from "@lens/engine";
import { finishBrowserExport, startBrowserExport, writeFrame } from "../server/browserExport";
import { whisperCli, whisperModel } from "../server/models";
import { detectSilences, type Range } from "../server/silence";
import { transcribe } from "../server/stt";

const has = (c: string, a: string[]) => spawnSync(c, a).status === 0;
const ready = has("ffmpeg", ["-version"]) && has("ffprobe", ["-version"]) && has("espeak-ng", ["--version"]);
const sttReady = ready && !!whisperCli() && !!whisperModel();
const ROOT = path.resolve(__dirname, "..", "..", "..");
const OFFSET = 300;
const MAX_PAUSE = 900;

function ff(...a: string[]): void {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...a]);
  if (r.status !== 0) throw new Error(r.stderr.toString());
}

function probe(file: string): { v: number; a: number } {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", file], { encoding: "utf8" });
  const st = JSON.parse(r.stdout).streams as Array<{ codec_type: string; duration: string }>;
  return { v: Number(st.find((s) => s.codec_type === "video")?.duration), a: Number(st.find((s) => s.codec_type === "audio")?.duration) };
}

/** Output time of a source time through the plan's timeline (cuts removed). */
function toOut(plan: RenderPlan, srcMs: number): number {
  const pieces = (plan.audio?.pieces ?? []) as Array<{ srcStart: number; srcEnd: number; outStart: number; outEnd: number }>;
  for (const p of pieces) if (srcMs >= p.srcStart && srcMs <= p.srcEnd) return p.outStart + (srcMs - p.srcStart) * ((p.outEnd - p.outStart) / Math.max(1, p.srcEnd - p.srcStart));
  return NaN;
}

async function exportPlan(plan: RenderPlan, dir: string): Promise<string> {
  const jpg = path.join(dir, "f.jpg");
  ff("-f", "lavfi", "-i", "color=c=0x334455:s=320x180", "-frames:v", "1", jpg);
  const frame = fs.readFileSync(jpg);
  const small = { ...plan, output: { ...plan.output, width: 320, height: 180 } } as RenderPlan;
  const job = startBrowserExport("ffmpeg", small, path.join(dir, "x" + Date.now()), "t", ROOT);
  for (let i = 0; i < plan.frames.length; i++) await writeFrame(job, i, frame);
  finishBrowserExport(job);
  while (job.state === "running") await new Promise((r) => setTimeout(r, 50));
  if (job.error) throw new Error(job.error);
  return job.out;
}

describe.skipIf(!ready)("cleanup on a desktop recording (#17)", () => {
  let dir = "";
  let server: http.Server;
  let base = "";
  let q = "";
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lens-cleanup-"));
    const say = (t: string, f: string) => {
      const r = spawnSync("espeak-ng", ["-v", "en-us", "-s", "150", "-w", path.join(dir, f), t]);
      if (r.status !== 0) throw new Error(r.stderr.toString());
    };
    say("Hello, this is the first part of the demo.", "s1.wav");
    say("Um, the second part starts right here.", "s2.wav");
    say("Uh, and this is the very end.", "s3.wav");
    // s1 | 4 s | s2 | 4 s | s3, mixed over a -54 dBFS noise floor, then mono Opus webm -> mic.wav as Stop writes it
    ff("-i", path.join(dir, "s1.wav"), "-f", "lavfi", "-t", "4", "-i", "anullsrc=r=22050:cl=mono", "-i", path.join(dir, "s2.wav"),
      "-f", "lavfi", "-t", "4", "-i", "anullsrc=r=22050:cl=mono", "-i", path.join(dir, "s3.wav"),
      "-filter_complex", "[0:a][1:a][2:a][3:a][4:a]concat=n=5:v=0:a=1,aresample=48000[s];anoisesrc=r=48000:a=0.002:c=pink:d=30[n];[s][n]amix=inputs=2:duration=first:normalize=0",
      "-ac", "1", "-c:a", "libopus", "-b:a", "64k", path.join(dir, "mic.webm"));
    ff("-i", path.join(dir, "mic.webm"), "-vn", "-af", "aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo:sample_rates=48000", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", path.join(dir, "mic.wav"));
    const durS = Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path.join(dir, "mic.wav")], { encoding: "utf8" }).stdout) + OFFSET / 1000;
    ff("-f", "lavfi", "-i", `color=c=gray:s=320x180:r=30:d=${durS.toFixed(3)}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(dir, "screen.mp4"));
    fs.writeFileSync(path.join(dir, "events.jsonl"), "");
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ width: 320, height: 180, fps: 30, durationMs: Math.round(durS * 1000) }));
    fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ version: 1, audio: { tracks: [{ id: "mic", kind: "mic", path: "mic.wav", offsetMs: OFFSET, volume: 1, muted: false }] } }));
    const { apiMiddleware } = await import("../server/api");
    const mw = apiMiddleware();
    server = http.createServer((req, res) => void mw(req, res, () => res.writeHead(404).end()));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    q = `?dir=${encodeURIComponent(dir)}`;
  }, 60_000);
  afterAll(() => {
    server?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const project = (sel: { removeFillers: boolean; shortenPauses: boolean }): ProjectConfig => {
    const p = resolveProject(JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8")));
    // what the Inspector switches do: either one turns cleanup on
    // track paths resolved against the bundle, as the export endpoint does (exportProject)
    return { ...p, audio: { ...p.audio, tracks: p.audio.tracks.map((t) => ({ ...t, path: path.join(dir, t.path) })), loudness: { ...p.audio.loudness, enabled: false } },
      edits: { ...p.edits, cleanup: { ...p.edits.cleanup, ...sel, enabled: sel.removeFillers || sel.shortenPauses, maxPauseMs: MAX_PAUSE } } };
  };

  it("shortens pauses with no transcript; export keeps A/V sync", async () => {
    const b = await (await fetch(`${base}/api/bundle${q}`)).json();
    expect(b.transcript).toBeNull();
    // v0.1.3: measured in the background, not in /api/bundle's answer
    expect(b.silencesPending).toBe(true);
    const silences = (await (await fetch(`${base}/api/silences${q}`)).json()).silences as Range[];
    expect((await (await fetch(`${base}/api/bundle${q}`)).json()).silences).toEqual(silences);
    const long = silences.filter((s) => s.endMs - s.startMs > 3500);
    expect(long.length).toBe(2);
    expect(long[0]!.startMs).toBeGreaterThanOrEqual(OFFSET);
    const meta = b.meta;
    const events = parseEventLog(b.events);
    const off = buildRenderPlan({ meta, events, project: project({ removeFillers: true, shortenPauses: false }), words: [], pauses: silences });
    expect(off.cleanupCuts).toEqual([]); // fillers alone need words: nothing to cut yet
    const plan = buildRenderPlan({ meta, events, project: project({ removeFillers: true, shortenPauses: true }), words: [], pauses: silences });
    expect(plan.cleanupCuts.length).toBeGreaterThanOrEqual(2);
    const removed = plan.cleanupCuts.reduce((a, c) => a + c.endMs - c.startMs, 0);
    const out = await exportPlan(plan, dir);
    const pr = probe(out);
    const outSil = (await detectSilences("ffmpeg", out, { minMs: 300 })).silences;
    const inner = outSil.filter((s) => s.startMs > 200 && s.endMs < pr.a * 1000 - 200);
    const longest = Math.max(0, ...inner.map((s) => s.endMs - s.startMs));
    // sync: the last phrase starts where the cut map puts it
    const s3Src = long[1]!.endMs;
    const s3Want = toOut(plan, s3Src);
    const s3Got = outSil.find((s) => Math.abs(s.endMs - s3Want) < 600)?.endMs ?? NaN;
    console.log(JSON.stringify({ silences: silences.length, cuts: plan.cleanupCuts.length, removedMs: removed, outV: pr.v, outA: pr.a, planMs: plan.output.durationMs, longestPauseMs: longest, s3Want, s3Got }));
    expect(longest).toBeLessThanOrEqual(MAX_PAUSE + 50);
    expect(Math.abs(pr.a - pr.v)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(pr.v * 1000 - plan.output.durationMs)).toBeLessThanOrEqual(50);
    expect(Math.abs(s3Got - s3Want)).toBeLessThanOrEqual(50);
  }, 180_000);

  it.skipIf(!sttReady)("removes fillers using the in-app transcript", async () => {
    const start = await (await fetch(`${base}/api/transcribe${q}`, { method: "POST" })).json();
    let st: { state: string; error?: string };
    for (;;) {
      st = await (await fetch(`${base}/api/transcribe/${start.id}${q}`)).json();
      if (st.state !== "running") break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(st.state, st.error).toBe("done");
    const b = await (await fetch(`${base}/api/bundle${q}`)).json();
    const words = b.transcript.words as Array<{ text: string; startMs: number; endMs: number; filler?: boolean }>;
    const fillers = words.filter((w) => w.filler);
    expect(fillers.length).toBeGreaterThanOrEqual(1);
    const plan = buildRenderPlan({ meta: b.meta, events: parseEventLog(b.events), project: project({ removeFillers: true, shortenPauses: true }), words, pauses: b.transcript.pauses ?? (await (await fetch(`${base}/api/silences${q}`)).json()).silences });
    for (const f of fillers) expect(plan.cuts.some((c) => c.startMs <= (f.startMs + f.endMs) / 2 && c.endMs >= (f.startMs + f.endMs) / 2), `filler ${f.text} cut`).toBe(true);
    const out = await exportPlan(plan, dir);
    const pr = probe(out);
    const after = await transcribe("ffmpeg", out);
    const left = after.words.filter((w) => w.filler).map((w) => w.text);
    const got = new Set(after.words.map((w) => w.text.toLowerCase().replace(/[^a-z']/g, "")));
    const want = ["hello", "this", "first", "part", "demo", "second", "starts", "right", "here", "and", "very", "end"];
    const recall = want.filter((w) => got.has(w)).length / want.length;
    console.log(JSON.stringify({ fillersBefore: fillers.map((f) => f.text), fillersLeft: left, recall, outV: pr.v, outA: pr.a, text: after.words.map((w) => w.text).join(" ") }));
    expect(left).toEqual([]);
    expect(recall).toBeGreaterThanOrEqual(0.8);
    expect(Math.abs(pr.a - pr.v)).toBeLessThanOrEqual(0.05);
  }, 240_000);
});
