#!/usr/bin/env node
/**
 * Synthetic bundle for the music-ducking e2e (demand #23): apps/editor/sample-music (or argv[2]).
 * Lens's own test media, generated with ffmpeg and plain arithmetic (no Python):
 *   screen.mp4   640x360 30 fps, 10 s, ffmpeg testsrc2 (moving pattern)
 *   mic.wav      "speech": a 1 kHz tone amplitude-modulated at 4 Hz (syllable-like, never silent
 *                inside a phrase) in [1.0, 3.5) s and [6.0, 8.5) s, digital silence elsewhere
 *   music-test.wav  the file the spec imports as music: steady 220 Hz + 330 Hz, 4 s (loops)
 * The speech and the music sit in separate frequency bands so the spec can measure each in the mix.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] ?? path.join(here, "..", "sample-music"));
const SR = 48000, SECS = 10;
export const SPEECH = [[1000, 3500], [6000, 8500]];

function wav(file, ch) {
  const n = ch[0].length, c = ch.length;
  const b = Buffer.alloc(44 + n * c * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * c * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(c, 22); b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * c * 2, 28); b.writeUInt16LE(c * 2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * c * 2, 40);
  for (let i = 0; i < n; i++) for (let k = 0; k < c; k++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, ch[k][i])) * 32767), 44 + (i * c + k) * 2);
  fs.writeFileSync(file, b);
}

fs.mkdirSync(out, { recursive: true });
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=30:duration=${SECS}`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", path.join(out, "screen.mp4")]);
const mic = new Float32Array(SR * SECS);
for (let i = 0; i < mic.length; i++) {
  const t = i / SR, ms = t * 1000;
  const on = SPEECH.some(([a, b]) => ms >= a && ms < b);
  if (!on) continue;
  const edge = Math.min(1, Math.min(...SPEECH.filter(([a, b]) => ms >= a && ms < b).map(([a, b]) => Math.min(ms - a, b - ms))) / 10); // 10 ms ramps
  mic[i] = 0.3 * edge * (0.8 + 0.2 * Math.sin(2 * Math.PI * 4 * t)) * Math.sin(2 * Math.PI * 1000 * t);
}
wav(path.join(out, "mic.wav"), [mic]);
const mus = Array.from({ length: 2 }, () => new Float32Array(SR * 4));
for (let i = 0; i < SR * 4; i++) {
  const t = i / SR;
  mus[0][i] = mus[1][i] = 0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 330 * t);
}
wav(path.join(out, "music-test.wav"), mus);
fs.writeFileSync(path.join(out, "meta.json"), JSON.stringify({ width: 640, height: 360, fps: 30, durationMs: SECS * 1000, pixelRatio: 1 }));
const ev = ['# lens-events v1 {"capture":{"width":640,"height":360},"source":"screen","platform":"linux"}'];
for (let i = 0; i < SECS * 10; i++) ev.push(JSON.stringify({ t: i * 100, type: "move", x: 100 + i * 4, y: 120 + (i % 10) * 8 }));
fs.writeFileSync(path.join(out, "events.jsonl"), ev.join("\n") + "\n");
fs.writeFileSync(path.join(out, "project.json"), JSON.stringify({
  version: 1,
  output: { aspect: "16:9", resolution: 360, fps: 30 },
  zoom: { auto: false },
  cursor: { visible: false, clickEffect: "none", clickSound: false },
  motionBlur: { enabled: false },
  audio: { tracks: [{ id: "mic", kind: "mic", path: "mic.wav", offsetMs: 0, volume: 1, muted: false }], noiseReduction: { enabled: false } },
}, null, 1));
console.log(out);
