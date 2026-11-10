/**
 * Music bed files (demand #23): import a user's audio file into the bundle, or write one of Lens's
 * built-in beds (synthesised by engine musicBed.ts, CC0) as a WAV. Both land in <bundle>/music/, so
 * the preview (GET /api/asset?path=music/...) and the export (decoded by ffmpeg) read the same file.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { bedInfo, bedLength, encodeWav16, synthBed } from "../../../packages/engine/src/index";

export const MUSIC_EXTS = [".mp3", ".wav", ".ogg", ".oga", ".opus", ".m4a", ".aac", ".flac", ".webm"];
const MAX_BYTES = 200 * 1024 * 1024;

export interface MusicFile {
  path: string;
  name: string;
  durationMs: number;
  source: string;
}

/** Decode the whole file with ffmpeg (the same decoder the export uses); returns its duration or throws. */
function probeAudio(ffmpeg: string, file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ["-v", "error", "-nostdin", "-hide_banner", "-i", file, "-vn", "-map", "0:a:0", "-f", "null", "-"], { windowsHide: true });
    let err = "";
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`not an audio file ffmpeg can read${err ? `: ${err.trim().split("\n").pop()}` : ""}`));
      // duration from a second, quick pass (ffmpeg prints time= on -stats)
      const q = spawn(ffmpeg, ["-nostdin", "-hide_banner", "-i", file, "-vn", "-map", "0:a:0", "-f", "null", "-"], { windowsHide: true });
      let e2 = "";
      q.stderr.on("data", (d: Buffer) => (e2 += d.toString()));
      q.on("error", reject);
      q.on("close", () => {
        const all = [...e2.matchAll(/time=(\d+):(\d+):([\d.]+)/g)];
        const m = all[all.length - 1];
        const ms = m ? (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 : 0;
        if (!(ms > 0)) return reject(new Error("the audio file has no samples"));
        resolve(Math.round(ms));
      });
    });
  });
}

export function safeMusicName(name: string): string {
  const base = path.basename(name).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return base.slice(-120) || "music";
}

/** Import an uploaded audio file into <bundle>/music/. */
export async function importMusic(ffmpeg: string, bundle: string, name: string, data: Buffer): Promise<MusicFile> {
  const safe = safeMusicName(name);
  const ext = path.extname(safe).toLowerCase();
  if (!MUSIC_EXTS.includes(ext)) throw new Error(`unsupported music file type ${ext || "(none)"}: use ${MUSIC_EXTS.join(", ")}`);
  if (!data.length) throw new Error("the music file is empty");
  if (data.length > MAX_BYTES) throw new Error("the music file is over 200 MB");
  const dir = path.join(bundle, "music");
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.import-${process.pid}-${Date.now()}${ext}`);
  fs.writeFileSync(tmp, data);
  try {
    const durationMs = await probeAudio(ffmpeg, tmp);
    const dest = path.join(dir, safe);
    fs.renameSync(tmp, dest);
    return { path: `music/${safe}`, name: path.basename(name), durationMs, source: "file" };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Write a built-in bed as 48 kHz 16-bit WAV (cached: written once per bundle). */
export function writeBuiltinBed(bundle: string, id: string): MusicFile {
  const info = bedInfo(id);
  if (!info) throw new Error(`unknown built-in music ${id}`);
  const rel = `music/lens-${id}.wav`;
  const file = path.join(bundle, rel);
  const sr = 48000;
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, encodeWav16(synthBed(id, sr), sr));
  }
  return { path: rel, name: info.name, durationMs: Math.round((bedLength(info, sr) * 1000) / sr), source: `builtin:${id}` };
}
