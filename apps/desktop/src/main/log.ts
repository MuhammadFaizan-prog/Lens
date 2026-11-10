/**
 * Lens log file: <userData>/logs/lens.log (main process and the editor server, which runs in it, plus
 * editor-window console warnings / errors and crashes). Rotates at 5 MB to lens.log.1. Opened from
 * About / the tray ("Open log folder") so Windows failures can be sent in.
 */
import fs from "node:fs";
import path from "node:path";
import util from "node:util";

let file: string | null = null;
const MAX = 5 * 1024 * 1024;

export function logDir(userData: string): string {
  return path.join(userData, "logs");
}

export function logLine(level: string, ...args: unknown[]): void {
  if (!file) return;
  try {
    const st = fs.existsSync(file) ? fs.statSync(file) : null;
    if (st && st.size > MAX) fs.renameSync(file, file + ".1");
    const text = args.map((a) => (typeof a === "string" ? a : util.inspect(a, { depth: 4, breakLength: 160 }))).join(" ");
    fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${text}\n`);
  } catch {
    // logging must never break the app
  }
}

export function initLog(userData: string, version: string): string {
  const dir = logDir(userData);
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, "lens.log");
  for (const level of ["log", "info", "warn", "error"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...a: unknown[]) => {
      orig(...a);
      logLine(level.toUpperCase(), ...a);
    };
  }
  process.on("uncaughtException", (e) => logLine("FATAL", "uncaughtException", e));
  process.on("unhandledRejection", (e) => logLine("ERROR", "unhandledRejection", e));
  logLine("INFO", `Lens v${version} start, ${process.platform} ${process.arch}, electron ${process.versions.electron}`);
  return file;
}
