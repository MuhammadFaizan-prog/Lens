/** Shared pieces of the desktop e2e specs: Xvfb, the synthetic scene, xdotool, ffmpeg frame decoding. */
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const HERE = __dirname;
export const DESKTOP = path.resolve(HERE, "..");
export const REPO = path.resolve(DESKTOP, "..", "..");
/** Big files stay on the workspace disk (the root filesystem is RAM-backed). */
export const RUNS = process.env.LENS_E2E_RUNS ?? path.resolve(REPO, "..", "runs", "desktop");

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const epoch = () => performance.timeOrigin + performance.now();

export async function startXvfb(display: number, w: number, h: number): Promise<ChildProcess> {
  try {
    fs.rmSync(`/tmp/.X${display}-lock`, { force: true });
  } catch {
    // not ours
  }
  const p = spawn("Xvfb", [`:${display}`, "-screen", "0", `${w}x${h}x24`, "-nolisten", "tcp"], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    if (spawnSync("xdpyinfo", ["-display", `:${display}`], { stdio: "ignore" }).status === 0) return p;
    await sleep(100);
  }
  throw new Error("Xvfb did not start");
}

export function xdo(display: number, ...args: string[]): void {
  execFileSync("xdotool", args, { env: { ...process.env, DISPLAY: `:${display}` } });
}

/** Move the pointer smoothly to (x, y) in `steps` steps over `ms`. */
export async function glide(display: number, from: { x: number; y: number }, to: { x: number; y: number }, ms: number, steps = 15): Promise<void> {
  for (let i = 1; i <= steps; i++) {
    const u = i / steps;
    xdo(display, "mousemove", String(Math.round(from.x + (to.x - from.x) * u)), String(Math.round(from.y + (to.y - from.y) * u)));
    await sleep(ms / steps);
  }
}

export function startScene(display: number, w: number, h: number, log: string): ChildProcess {
  return spawn("python3", [path.join(HERE, "scene.py"), String(w), String(h), log], { env: { ...process.env, DISPLAY: `:${display}` }, stdio: "ignore" });
}

export interface DecodedFrame {
  pts: number; // seconds
  rgb: Buffer; // width*height*3
}

/** Decode every frame (no rate conversion) downscaled to w x h, with its presentation time. */
export function decodeFrames(file: string, w: number, h: number, crop?: { x: number; y: number }): Promise<DecodedFrame[]> {
  return new Promise((resolve, reject) => {
    const vf = crop ? `crop=${w}:${h}:${crop.x}:${crop.y},showinfo` : `scale=${w}:${h}:flags=area,showinfo`;
    const ff = spawn("ffmpeg", ["-v", "info", "-i", file, "-vf", vf, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
    const size = w * h * 3;
    const frames: Buffer[] = [];
    let buf = Buffer.alloc(0);
    const pts: number[] = [];
    let err = "";
    ff.stdout.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= size) {
        frames.push(Buffer.from(buf.subarray(0, size)));
        buf = buf.subarray(size);
      }
    });
    ff.stderr.on("data", (d: Buffer) => {
      err += d.toString();
      const lines = err.split("\n");
      err = lines.pop() ?? "";
      for (const l of lines) {
        const m = /showinfo.*pts_time:\s*([-\d.]+)/.exec(l);
        if (m) pts.push(Number(m[1]));
      }
    });
    ff.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg decode failed (${code})`));
      resolve(frames.map((rgb, i) => ({ pts: pts[i] ?? NaN, rgb })));
    });
  });
}

/**
 * Frames of a 16x16 crop inside the scene's 48x48 flash for a click at (x, y): the crop sits up-left of
 * the pointer's hotspot, so the captured cursor sprite (it extends right / down) never covers it.
 */
export function flashCrop(file: string, x: number, y: number): Promise<DecodedFrame[]> {
  return decodeFrames(file, 16, 16, { x: Math.max(0, x - 22), y: Math.max(0, y - 22) });
}

export function isFlash(f: DecodedFrame): boolean {
  let hits = 0;
  for (let i = 0; i < f.rgb.length; i += 3) if (f.rgb[i]! > 190 && f.rgb[i + 1]! < 90 && f.rgb[i + 2]! > 190) hits++;
  return hits / (f.rgb.length / 3) >= 0.6;
}

/** Is the scene's magenta flash under (x, y) (full-res px) in this downscaled frame? */
export function flashAt(f: DecodedFrame, w: number, h: number, scale: number, x: number, y: number): boolean {
  const cx = Math.round(x / scale);
  const cy = Math.round(y / scale);
  let hits = 0;
  let total = 0;
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++) {
      const px = cx + dx;
      const py = cy + dy;
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const i = (py * w + px) * 3;
      total++;
      if (f.rgb[i]! > 190 && f.rgb[i + 1]! < 90 && f.rgb[i + 2]! > 190) hits++;
    }
  return total > 0 && hits / total >= 0.6;
}

export function ffprobeJson(args: string[]): any {
  return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-of", "json", ...args], { encoding: "utf8" }));
}
