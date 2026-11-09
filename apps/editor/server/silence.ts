/**
 * Measured silences on an audio track (ffmpeg silencedetect: an energy gate on the mixed-down track).
 * Used by speech-to-text (pauses in transcript.json, word ends trimmed back to where the sound stops)
 * and by Cleanup's "Shorten pauses", which must work without any transcript (Windows #5 / #17).
 */
import { spawn } from "node:child_process";

export interface Range { startMs: number; endMs: number }

/** Parse silencedetect's stderr lines into ranges (ms on the input's clock). */
export function parseSilencedetect(stderr: string, durationMs: number): Range[] {
  const out: Range[] = [];
  let start: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) start = Math.max(0, Number(s[1]) * 1000);
    const e = /silence_end:\s*([\d.]+)/.exec(line);
    if (e && start !== null) {
      out.push({ startMs: Math.round(start), endMs: Math.round(Number(e[1]) * 1000) });
      start = null;
    }
  }
  // silence running to the end of the file has a start but no end
  if (start !== null && durationMs > start) out.push({ startMs: Math.round(start), endMs: Math.round(durationMs) });
  return out;
}

/**
 * Silences of at least minMs whose level stays under noiseDb (dBFS). The threshold is relative to
 * the track: noiseDb is clamped to at least 12 dB under the track's speech level (its 95th-percentile
 * RMS), so a quiet mic still separates speech from room tone.
 */
export async function detectSilences(ffmpeg: string, input: string, opts: { minMs?: number; noiseDb?: number } = {}): Promise<{ silences: Range[]; durationMs: number; noiseDb: number }> {
  const minMs = opts.minMs ?? 300;
  const level = await speechLevelDb(ffmpeg, input);
  const noiseDb = Math.min(opts.noiseDb ?? -40, level.speechDb - 12);
  const err = await ffmpegStderr(ffmpeg, ["-hide_banner", "-nostats", "-i", input, "-vn", "-af", `aformat=channel_layouts=mono,silencedetect=noise=${noiseDb.toFixed(1)}dB:d=${(minMs / 1000).toFixed(3)}`, "-f", "null", "-"]);
  return { silences: parseSilencedetect(err, level.durationMs), durationMs: level.durationMs, noiseDb };
}

/** 95th-percentile 50 ms RMS (dBFS) and the duration of an audio file. */
async function speechLevelDb(ffmpeg: string, input: string): Promise<{ speechDb: number; durationMs: number }> {
  const err = await ffmpegStderr(ffmpeg, ["-hide_banner", "-nostats", "-i", input, "-vn", "-af", "aformat=channel_layouts=mono,aresample=8000,asetnsamples=400,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level", "-f", "null", "-"]);
  const vals = [...err.matchAll(/RMS_level=(-?[\d.]+|-inf)/g)].map((m) => (m[1] === "-inf" ? -120 : Number(m[1]))).filter(Number.isFinite);
  const d = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(err);
  const durationMs = d ? (Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])) * 1000 : vals.length * 50;
  if (!vals.length) return { speechDb: -20, durationMs };
  vals.sort((a, b) => a - b);
  return { speechDb: vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.95))]!, durationMs };
}

function ffmpegStderr(ffmpeg: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { windowsHide: true });
    let err = "";
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.stdout.on("data", () => undefined);
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(err) : reject(new Error(`ffmpeg exited ${code}: ${err.trim().split("\n").slice(-2).join(" ")}`))));
  });
}

/** Trim word spans back out of measured silences (Whisper's token times often run on into a pause). */
export function trimWordsToSilences<W extends Range>(words: W[], silences: Range[]): W[] {
  return words.map((w) => {
    let { startMs, endMs } = w;
    for (const s of silences) {
      if (s.endMs <= startMs || s.startMs >= endMs) continue;
      if (s.startMs <= startMs && s.endMs >= endMs) continue; // fully inside a silence: leave it (quiet speech)
      if (s.startMs > startMs && s.endMs >= endMs) endMs = s.startMs; // runs into the silence: end where it starts
      else if (s.startMs <= startMs && s.endMs < endMs) startMs = s.endMs; // starts inside: begin where sound starts
      else if (s.endMs - s.startMs >= 250) {
        // the word spans a whole silence (Whisper stretched it across the gap): keep the longer sounding side
        if (s.startMs - startMs >= endMs - s.endMs) endMs = s.startMs;
        else startMs = s.endMs;
      }
    }
    return endMs > startMs ? { ...w, startMs, endMs } : w;
  });
}

/** Silences that no (trimmed) word overlaps. */
export function pausesFromSilences(silences: Range[], words: Range[], minMs: number): Range[] {
  return silences.filter((s) => s.endMs - s.startMs >= minMs && !words.some((w) => w.startMs < s.endMs && w.endMs > s.startMs));
}
