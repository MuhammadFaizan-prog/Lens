/** Shared test helpers: run the built CLI, scratch folders on the workspace disk, fixtures. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LENS = path.resolve(PKG, "..", "..");
export const CLI = path.join(PKG, "dist", "cli.js");
export const MCP = path.join(PKG, "dist", "mcp.js");
/** Scratch lives next to the package (workspace disk), not /tmp (RAM-backed here). */
export const WORK = path.join(PKG, ".test-work");

export function scratch(name: string): string {
  const d = path.join(WORK, `${name}-${process.pid}`);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** make_sample.py output, generated once per variant and reused (deterministic, synthetic media). */
export function sample(variant: "" | "privacy" | "translate" = ""): string {
  const d = path.join(WORK, `fixture-sample${variant ? "-" + variant : ""}`);
  if (!fs.existsSync(path.join(d, "meta.json"))) {
    const args = [path.join(LENS, "apps/editor/scripts/make_sample.py"), "--out", d, "--force", ...(variant ? [`--${variant}`] : [])];
    const r = spawnSync("python3", args, { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`make_sample failed: ${r.stderr}`);
  }
  return d;
}

export interface Run {
  code: number;
  json: { ok: boolean; command: string; result?: any; error?: { code: string; message: string; exit: number } };
  stdout: string;
  stderr: string;
}

export function lens(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Run {
  const r = spawnSync("node", [CLI, ...args, "--json"], { cwd: opts.cwd, env: { ...process.env, ...opts.env }, encoding: "utf8", maxBuffer: 64 << 20 });
  let json: Run["json"];
  try {
    json = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    throw new Error(`no JSON from lens ${args.join(" ")}: ${r.stdout} ${r.stderr}`);
  }
  return { code: r.status ?? -1, json, stdout: r.stdout, stderr: r.stderr };
}

/** A small, fast project: the sample at 360p (export ~7 s). */
export function smallProject(dir: string, variant: "" | "privacy" | "translate" = ""): string {
  const p = path.join(dir, "proj");
  const r = lens(["project", "new", p, "--from", sample(variant)]);
  if (r.code !== 0) throw new Error(JSON.stringify(r.json));
  const s = lens(["set", "/output/resolution", "360", "-C", p]);
  if (s.code !== 0) throw new Error(JSON.stringify(s.json));
  return p;
}

/** Keys and value types, recursively (arrays: shape of the first item): what a JSON snapshot pins. */
export function shape(v: unknown): unknown {
  if (Array.isArray(v)) return v.length ? [shape(v[0])] : [];
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape((v as Record<string, unknown>)[k])]));
  return v === null ? "null" : typeof v;
}

export function py(script: string, args: string[]): string {
  const r = spawnSync("python3", ["-c", script, ...args], { encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

/** ffprobe: video frames, duration, codec. */
export function probe(file: string): { codec: string; frames: number; durationS: number; width: number; height: number } {
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=codec_name,nb_read_frames,width,height:format=duration", "-of", "json", file], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffprobe failed on ${file}: ${r.stderr}`);
  const j = JSON.parse(r.stdout);
  const s = j.streams[0];
  return { codec: s.codec_name, frames: Number(s.nb_read_frames), durationS: Number(j.format.duration), width: s.width, height: s.height };
}

/** Mean absolute difference of two images (0..255), via OpenCV. */
export function imageDiff(a: string, b: string): number {
  return Number(py("import cv2,sys,numpy as np; a=cv2.imread(sys.argv[1]).astype(float); b=cv2.imread(sys.argv[2]).astype(float); print(np.abs(a-b).mean())", [a, b]));
}
