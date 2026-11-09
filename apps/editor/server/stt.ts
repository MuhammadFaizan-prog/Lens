/**
 * In-app speech-to-text (Windows #5), no Python: whisper.cpp's CLI (MIT, shipped per platform under
 * assets/models/whisper/<platform>-<arch>/) with Whisper base.en (q5_1, MIT) on the bundle's mic track.
 * Writes the engine's transcript JSON (packages/engine/src/transcript.ts): one entry per word with
 * startMs / endMs on the recording clock (the track's offset added), confidence (mean token
 * probability), filler flags, measured pauses, and the engine used. Audio never leaves the machine.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WHISPER_MODEL, whisperCli, whisperModel } from "./models";
import { detectSilences, pausesFromSilences, trimWordsToSilences } from "./silence";

/** Same list as packages/engine/src/transcript.ts DEFAULT_FILLERS and transcribe/lens_transcribe/fillers.py. */
export const FILLERS = ["um", "uh", "erm", "er", "ah", "hmm", "mm", "uhm", "umm"];
// Prompting the decoder with a disfluent sentence makes Whisper write hesitations out instead of
// cleaning them away (the same sentence as transcribe/lens_transcribe/fillers.py).
const FILLER_PROMPT = "Um, so, uh, I was like, hmm, thinking. Er, okay, umm, let's uh start.";

export const VC_REDIST_URL = "https://aka.ms/vs/17/release/vc_redist.x64.exe";

const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
export const isFiller = (t: string) => FILLERS.includes(norm(t));

export interface SttWord { text: string; startMs: number; endMs: number; confidence?: number; filler?: boolean }
export interface SttResult {
  version: 1; language: string; durationMs: number; offsetMs: number; words: SttWord[]; pauses: Array<{ startMs: number; endMs: number }>;
  engine: { name: string; model: string; licence: string; seconds: number }; source: { file: string };
}

type Token = { text: string; p?: number; offsets?: { from: number; to: number }; timestamps?: { from: string; to: string } };
type Segment = { text: string; offsets: { from: number; to: number }; tokens?: Token[] };

/** Words from whisper.cpp `-ojf` output: tokens joined into words (a token starting with a space starts a word). */
export function wordsFromWhisperJson(j: { transcription?: Segment[] }, offsetMs = 0): SttWord[] {
  const out: SttWord[] = [];
  for (const seg of j.transcription ?? []) {
    const toks = (seg.tokens ?? []).filter((t) => !/^\[_?[A-Z_]+[_\d]*\]$/.test(t.text.trim()) && !/^\[.*\]$|^<\|.*\|>$/.test(t.text.trim()));
    let cur: { text: string; a: number; b: number; ps: number[] } | null = null;
    const flush = () => {
      if (!cur) return;
      const text = cur.text.trim();
      if (text && /[\p{L}\p{N}]/u.test(text)) {
        const w: SttWord = { text, startMs: Math.round(cur.a + offsetMs), endMs: Math.round(Math.max(cur.a, cur.b) + offsetMs) };
        if (cur.ps.length) w.confidence = Math.round((cur.ps.reduce((x, y) => x + y, 0) / cur.ps.length) * 1000) / 1000;
        if (isFiller(text)) w.filler = true;
        out.push(w);
      }
      cur = null;
    };
    for (const t of toks) {
      const a = t.offsets?.from ?? seg.offsets.from;
      const b = t.offsets?.to ?? seg.offsets.to;
      const startsWord = /^\s/.test(t.text) || !cur;
      const punct = /^[^\p{L}\p{N}\s']+$/u.test(t.text);
      if (startsWord && !punct) {
        flush();
        cur = { text: t.text, a, b, ps: t.p !== undefined ? [t.p] : [] };
      } else if (cur) {
        cur.text += t.text;
        cur.b = b;
        if (t.p !== undefined && !punct) cur.ps.push(t.p);
      }
    }
    flush();
  }
  // whisper.cpp token times can overlap by a few ms; keep them monotonic
  for (let i = 1; i < out.length; i++) if (out[i]!.startMs < out[i - 1]!.endMs) out[i]!.startMs = Math.min(out[i]!.endMs, out[i - 1]!.endMs);
  return out;
}

/** Gaps of at least minMs between spoken (non-filler) words, and before the first / after the last. */
export function pausesBetween(words: SttWord[], durationMs: number, offsetMs: number, minMs = 500): Array<{ startMs: number; endMs: number }> {
  const spoken = words.filter((w) => !w.filler);
  const out: Array<{ startMs: number; endMs: number }> = [];
  let prev = offsetMs;
  for (const w of spoken) {
    if (w.startMs - prev >= minMs) out.push({ startMs: prev, endMs: w.startMs });
    prev = Math.max(prev, w.endMs);
  }
  if (offsetMs + durationMs - prev >= minMs && spoken.length) out.push({ startMs: prev, endMs: offsetMs + durationMs });
  return out;
}

function run(cmd: string, args: string[], onLine?: (l: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let err = "";
    p.stdout.on("data", () => undefined);
    p.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      err = (err + s).slice(-4000);
      for (const l of s.split(/\r?\n/)) if (l) onLine?.(l);
    });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) return resolve(err);
      // Windows STATUS_DLL_NOT_FOUND: the official whisper.cpp build links the MSVC runtime (MSVCP140 / VCRUNTIME140 / VCOMP140)
      if (code === 3221225781 || code === -1073741515)
        return reject(new Error(`${path.basename(cmd)} could not start: the Microsoft Visual C++ 2015-2022 runtime (x64) is missing. Install it from ${VC_REDIST_URL} and try again`));
      reject(new Error(`${path.basename(cmd)} exited ${code}: ${err.trim().split("\n").slice(-3).join(" ")}`));
    });
  });
}

const LONG_SIL_MS = 600;
const KEEP_SIL_MS = 300;

/** Spans of the audio kept for decoding: everything except the middle of silences >= LONG_SIL_MS (KEEP_SIL_MS of each is kept). */
export function keptSpans(silences: Array<{ startMs: number; endMs: number }>, durationMs: number): Array<{ startMs: number; endMs: number }> {
  const out: Array<{ startMs: number; endMs: number }> = [];
  let pos = 0;
  for (const s of silences) {
    if (s.endMs - s.startMs < LONG_SIL_MS) continue;
    const a = s.startMs + KEEP_SIL_MS / 2;
    const b = s.endMs - KEEP_SIL_MS / 2;
    if (a > pos) out.push({ startMs: pos, endMs: a });
    pos = Math.max(pos, b);
  }
  if (durationMs > pos) out.push({ startMs: pos, endMs: durationMs });
  return out.length ? out : [{ startMs: 0, endMs: durationMs }];
}

/** Decoded (shortened) time -> original time. `end`: a time exactly on a join maps to the end of the earlier span. */
export function mapBack(keep: Array<{ startMs: number; endMs: number }>): (t: number, end?: boolean) => number {
  return (t, end = false) => {
    let acc = 0;
    for (const k of keep) {
      const len = k.endMs - k.startMs;
      if (t < acc + len || (end && t <= acc + len)) return k.startMs + Math.max(0, t - acc);
      acc += len;
    }
    const last = keep[keep.length - 1]!;
    return last.endMs + (t - acc);
  };
}

/** Transcribe an audio file (anything ffmpeg decodes) to the engine's transcript JSON. */
export async function transcribe(ffmpeg: string, input: string, offsetMs = 0, progress?: (pct: number) => void): Promise<SttResult> {
  const cli = whisperCli();
  const model = whisperModel();
  if (!cli || !model) throw new Error("speech-to-text model or whisper.cpp not found: run `node apps/editor/scripts/fetch-models.mjs` (or set LENS_WHISPER_CLI / LENS_WHISPER_MODEL)");
  const t0 = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lens-stt-"));
  try {
    const wav = path.join(dir, "in.wav");
    await run(ffmpeg, ["-v", "error", "-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
    const durationMs = Math.round(((fs.statSync(wav).size - 44) / 32000) * 1000);
    // Whisper's timestamps drift inside long silences (a 1.9 s pause came back as 0.2 s, the next words
    // ~1.7 s early). Long silences are shortened to KEEP_SIL_MS before decoding and the word times are
    // mapped back through the cut map, so the error is bounded by KEEP_SIL_MS.
    const { silences } = await detectSilences(ffmpeg, wav, { minMs: 250 });
    const keep = keptSpans(silences, durationMs);
    const decodeWav = path.join(dir, "dec.wav");
    const script = path.join(dir, "select.txt");
    fs.writeFileSync(script, `aselect='${keep.map((k) => `between(t,${(k.startMs / 1000).toFixed(3)},${(k.endMs / 1000).toFixed(3)})`).join("+")}',asetpts=N/SR/TB`);
    await run(ffmpeg, ["-v", "error", "-y", "-i", wav, "-filter_script:a", script, "-c:a", "pcm_s16le", decodeWav]);
    const base = path.join(dir, "out");
    const threads = String(Math.max(1, Math.min(4, os.cpus().length)));
    await run(cli, ["-m", model, "-f", decodeWav, "-l", "en", "-t", threads, "-ojf", "-of", base, "-np", "-pp", "--prompt", FILLER_PROMPT, "-mc", "0"], (l) => {
      const m = /progress\s*=\s*(\d+)%/.exec(l);
      if (m) progress?.(Number(m[1]));
    });
    const j = JSON.parse(fs.readFileSync(base + ".json", "utf8"));
    const toOrig = mapBack(keep);
    const decoded = wordsFromWhisperJson(j, 0).map((w) => ({ ...w, startMs: Math.round(toOrig(w.startMs) + offsetMs), endMs: Math.round(toOrig(w.endMs, true) + offsetMs) }));
    // measured silences (energy gate): word ends trimmed back to where the sound stops, and pauses are
    // only ever silences (transcript.ts: pause shortening cuts inside these and nowhere else)
    const shifted = silences.map((r) => ({ startMs: r.startMs + offsetMs, endMs: r.endMs + offsetMs }));
    const words = trimWordsToSilences(decoded, shifted);
    return {
      version: 1, language: "en", durationMs, offsetMs, words, pauses: pausesFromSilences(shifted, words, 500),
      engine: { name: "whisper.cpp", model: WHISPER_MODEL.replace(/^ggml-|\.bin$/g, ""), licence: "MIT", seconds: Math.round((Date.now() - t0) / 100) / 10 },
      source: { file: path.basename(input) },
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
