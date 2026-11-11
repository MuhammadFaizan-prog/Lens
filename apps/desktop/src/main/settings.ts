/**
 * App settings (Windows #19), persisted as JSON in userData/settings.json. Pure data + validation
 * here; main.ts applies them (save folder, hotkeys, login item, hardware acceleration, export folder).
 */
import fs from "node:fs";
import path from "node:path";

export interface Settings {
  general: { saveDir: string; exportDir: string; autoStart: boolean; autoPlay: boolean; hardwareAcceleration: boolean };
  record: { fps: 30 | 60; quality: "standard" | "high" | "max"; countdown: 0 | 3 | 5; hideWhileRecording: boolean; showSystemCursor: boolean };
  /** zoomMarker (demand #19): bound only while a recording runs; drops a "zoom here" marker. */
  shortcuts: { startStop: string; region: string; pause: string; zoomMarker: string };
  export: { format: "mp4"; resolution: 720 | 1080 | 1440 | 2160; fps: 30 | 60; bitrateMbps: number };
}

/** Default zoom-marker hotkey (demand #19). */
export const ZOOM_MARKER_KEY = "CommandOrControl+Alt+Z";

export function defaultSettings(videosDir: string, hotkey: string): Settings {
  return {
    general: { saveDir: path.join(videosDir, "Lens"), exportDir: path.join(videosDir, "Lens", "Exports"), autoStart: false, autoPlay: false, hardwareAcceleration: true },
    record: { fps: 30, quality: "high", countdown: 0, hideWhileRecording: false, showSystemCursor: false },
    shortcuts: { startStop: hotkey, region: "CommandOrControl+Shift+A", pause: "", zoomMarker: ZOOM_MARKER_KEY },
    export: { format: "mp4", resolution: 1080, fps: 30, bitrateMbps: 0 },
  };
}

/** Quality -> bits per pixel per frame for the screen recorder. */
export const QUALITY_BPP: Record<Settings["record"]["quality"], number> = { standard: 0.08, high: 0.12, max: 0.2 };

function pick<T>(v: unknown, ok: readonly T[], d: T): T {
  return ok.includes(v as T) ? (v as T) : d;
}

/** Merge a stored / submitted object onto the defaults, dropping anything invalid. */
export function normalize(raw: unknown, d: Settings): Settings {
  const r = (raw ?? {}) as Partial<Record<keyof Settings, Record<string, unknown>>>;
  const g = r.general ?? {};
  const rc = r.record ?? {};
  const sc = r.shortcuts ?? {};
  const ex = r.export ?? {};
  const str = (v: unknown, dv: string) => (typeof v === "string" && v.trim() ? v.trim() : dv);
  const bool = (v: unknown, dv: boolean) => (typeof v === "boolean" ? v : dv);
  const accel = (v: unknown, dv: string) => (typeof v === "string" ? v.trim() : dv);
  return {
    general: { saveDir: str(g.saveDir, d.general.saveDir), exportDir: str(g.exportDir, d.general.exportDir), autoStart: bool(g.autoStart, d.general.autoStart), autoPlay: bool(g.autoPlay, d.general.autoPlay), hardwareAcceleration: bool(g.hardwareAcceleration, d.general.hardwareAcceleration) },
    record: { fps: pick(Number(rc.fps), [30, 60] as const, d.record.fps), quality: pick(rc.quality, ["standard", "high", "max"] as const, d.record.quality), countdown: pick(Number(rc.countdown), [0, 3, 5] as const, d.record.countdown), hideWhileRecording: bool(rc.hideWhileRecording, d.record.hideWhileRecording), showSystemCursor: bool(rc.showSystemCursor, d.record.showSystemCursor) },
    shortcuts: { startStop: accel(sc.startStop, d.shortcuts.startStop) || d.shortcuts.startStop, region: accel(sc.region, d.shortcuts.region), pause: accel(sc.pause, d.shortcuts.pause), zoomMarker: accel(sc.zoomMarker, d.shortcuts.zoomMarker) },
    export: { format: "mp4", resolution: pick(Number(ex.resolution), [720, 1080, 1440, 2160] as const, d.export.resolution), fps: pick(Number(ex.fps), [30, 60] as const, d.export.fps), bitrateMbps: Math.max(0, Math.min(200, Number(ex.bitrateMbps) || 0)) },
  };
}

/** Two actions bound to the same keys (case / modifier order insensitive). Returns the clashing pair. */
export function shortcutConflict(s: Partial<Settings["shortcuts"]>): [string, string] | null {
  const canon = (a: string) => a.toLowerCase().replace(/commandorcontrol|cmdorctrl|control/g, "ctrl").split("+").map((x) => x.trim()).sort().join("+");
  const entries = Object.entries(s).filter((e): e is [string, string] => !!e[1]);
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) if (canon(entries[i]![1]) === canon(entries[j]![1])) return [entries[i]![0], entries[j]![0]];
  return null;
}

export function loadSettings(file: string, d: Settings): Settings {
  try {
    return normalize(JSON.parse(fs.readFileSync(file, "utf8")), d);
  } catch {
    return d;
  }
}

export function saveSettings(file: string, s: Settings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, file);
}
