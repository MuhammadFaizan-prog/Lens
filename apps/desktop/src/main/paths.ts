/** Where the desktop app finds the editor, ffmpeg, fonts and its recordings, packaged or from the repo. */
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

/** apps/desktop (dev) — main.cjs lives in apps/desktop/dist. */
const DESKTOP = path.resolve(__dirname, "..");
const REPO = path.resolve(DESKTOP, "..", "..");

export function resourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : path.join(DESKTOP, "dist");
}

/** The built editor (vite build of apps/editor), served by the in-app editor server. */
export function editorDist(): string {
  const packaged = path.join(process.resourcesPath ?? "", "editor");
  return app.isPackaged ? packaged : path.join(REPO, "apps", "editor", "dist");
}

/** Lens "root" for the editor middleware: holds assets/fonts (builtin theme fonts). */
export function lensRoot(): string {
  return app.isPackaged ? path.join(process.resourcesPath, "lens") : REPO;
}

export function fontDir(): string | null {
  const d = app.isPackaged ? path.join(process.resourcesPath, "fonts") : "";
  return d && fs.existsSync(d) ? d : null;
}

/** ffmpeg: LENS_FFMPEG, the bundled binary (resources/ffmpeg/ffmpeg[.exe]), or ffmpeg on PATH. */
export function ffmpegPath(): string {
  if (process.env.LENS_FFMPEG) return process.env.LENS_FFMPEG;
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const bundled = path.join(process.resourcesPath ?? "", "ffmpeg", exe);
  if (app.isPackaged && fs.existsSync(bundled)) return bundled;
  return "ffmpeg";
}

/** Recordings: LENS_RECORDINGS_DIR or <Videos>/Lens. */
export function recordingsDir(): string {
  const d = process.env.LENS_RECORDINGS_DIR || path.join(app.getPath("videos"), "Lens");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function rendererFile(name: string): string {
  return path.join(DESKTOP, "dist", "renderer", name);
}
