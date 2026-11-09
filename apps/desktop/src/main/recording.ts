/**
 * One recording: writes the capture to disk chunk by chunk while it records (a crash keeps every
 * chunk written so far), logs the cursor (about 60 Hz, screen.getCursorScreenPoint) and mouse / key
 * events (uiohook-napi) on the video clock, and on Stop turns the bundle into a Lens project the
 * editor opens: screen.mp4 (constant frame rate), mic.wav, events.jsonl, meta.json, project.json.
 *
 * Clock: every time here is epoch ms from performance.timeOrigin + performance.now() (the renderer
 * stamps the video start the same way). t on the video clock = epoch - videoStartEpoch.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { screen } from "electron";
import { dipToCapture, physicalToCapture, resolveClickPoint, type CaptureSize, type DisplayGeom, type Point } from "../shared/coords";
import { EventLogWriter, headerLine, keyEvent, mouseButton } from "../shared/eventlog";
import type { InputEvent } from "../../../../packages/engine/src/types";

export const nowEpoch = (): number => performance.timeOrigin + performance.now();

export interface StartInfo {
  sourceId: string;
  sourceName: string;
  kind: "screen" | "window";
  displayId: string | undefined;
  capture: CaptureSize;
  fps: number;
  videoMime: string;
  /** Epoch ms of video t = 0 (first recorded frame; see recorder.ts). */
  videoStart: number;
  /** The candidates the renderer measured for videoStart (diagnostics, recording.json). */
  clock?: Record<string, unknown>;
  mic: { mime: string; start: number } | null;
  /**
   * The OS cursor in the captured video (Windows #9): "never" = excluded (Lens draws its own),
   * "always" = the user asked for the system cursor; capture = the API that took the frames and the
   * cursor setting Chromium reported for the track.
   */
  /** Webcam / system-audio recorders (Windows #7), started with the screen. */
  webcam?: { mime: string; start: number } | null;
  system?: { mime: string; start: number } | null;
  /** Custom mode: the area to keep, in capture px (written as the project's crop). */
  crop?: { x: number; y: number; w: number; h: number } | null;
  /** Settings > Export defaults, written as the new project's output (Windows #19). */
  output?: { resolution: number; fps: number } | null;
  cursor?: { requested: "never" | "always"; reported: string | null; api: "getDisplayMedia" | "getUserMedia" };
}

/** Is the OS cursor in the captured frames? Only a track that reports cursor "never" is clean. */
export function cursorBaked(c: StartInfo["cursor"] | undefined): boolean {
  if (!c) return true;
  if (c.requested === "always") return true;
  return c.api !== "getDisplayMedia" || c.reported !== "never";
}

export interface Hook {
  on(ev: string, fn: (e: any) => void): unknown;
  removeListener(ev: string, fn: (e: any) => void): unknown;
}

export type LiveSink = (batch: { t: number; cursor: Point | null; events: InputEvent[] }) => void;

export function displayGeoms(): DisplayGeom[] {
  return screen.getAllDisplays().map((d) => ({
    id: d.id,
    bounds: d.bounds,
    scaleFactor: d.scaleFactor,
    physical: process.platform === "win32" ? screen.dipToScreenRect(null, d.bounds) : undefined,
  }));
}

export class Recording {
  readonly dir: string;
  private videoFd: number | null = null;
  private audioFd: number | null = null;
  private camFd: number | null = null;
  private sysFd: number | null = null;
  private eventsFd: number | null = null;
  private log: EventLogWriter | null = null;
  private timer: NodeJS.Timeout | null = null;
  private info: StartInfo | null = null;
  private displays: DisplayGeom[] = [];
  private captured: DisplayGeom | null = null;
  private live: InputEvent[] = [];
  private lastCursor: Point | null = null;
  private listeners: Array<[string, (e: any) => void]> = [];
  private stopEpoch = 0;
  clickSources = { hook: 0, "hook-dip": 0, poll: 0 };
  warnings: string[] = [];

  constructor(root: string, private readonly hook: Hook | null, private readonly onLive: LiveSink | null) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
    this.dir = path.join(root, `Lens-${stamp}`);
    fs.mkdirSync(this.dir, { recursive: true });
    this.videoFd = fs.openSync(path.join(this.dir, "recording.webm"), "w");
  }

  /** The renderer started its recorder(s): begin the input log on the video clock. */
  start(info: StartInfo, captured: DisplayGeom | null): void {
    this.info = info;
    this.displays = displayGeoms();
    this.captured = captured;
    if (info.mic) this.audioFd = fs.openSync(path.join(this.dir, "mic.webm"), "w");
    if (info.webcam) this.camFd = fs.openSync(path.join(this.dir, "cam.webm"), "w");
    if (info.system) this.sysFd = fs.openSync(path.join(this.dir, "system.webm"), "w");
    if (!captured) this.warnings.push("window capture: cursor and clicks are logged in the coordinates of the display under the cursor, not the window (docs/Desktop.md)");
    this.eventsFd = fs.openSync(path.join(this.dir, "events.jsonl"), "w");
    const fd = this.eventsFd;
    fs.writeSync(fd, headerLine({ capture: info.capture, source: info.kind, platform: process.platform, displayId: info.displayId ?? null }) + "\n");
    this.log = new EventLogWriter((line) => fs.writeSync(fd, line));
    const t0 = info.videoStart;
    const cap = info.capture;
    const geom = () => this.captured ?? this.displays.find((d) => d.id === screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id) ?? this.displays[0]!;
    const toCap = (dip: Point) => dipToCapture(dip, this.displays, geom(), cap);
    // Linux / X11: Electron's getCursorScreenPoint goes stale while the pointer is over other X clients'
    // windows (measured under Xvfb: two distinct samples in a 19 s session), so the cursor comes from
    // the hook's motion events there (X11 px = physical). Windows / macOS poll as specified.
    const hookCursor = process.platform === "linux" && !!this.hook;
    let hookAt: Point | null = null;
    const sample = () => {
      const t = nowEpoch() - t0;
      const p = hookCursor && hookAt ? physicalToCapture(hookAt, geom(), cap) : toCap(screen.getCursorScreenPoint());
      this.lastCursor = p;
      this.log?.move(t, p.x, p.y);
      this.onLive?.({ t, cursor: p, events: this.live.splice(0) });
    };
    sample();
    this.timer = setInterval(sample, 1000 / 60);
    if (!this.hook) {
      this.warnings.push("uiohook-napi did not load: no clicks or shortcuts logged");
      return;
    }
    const mods = (e: any) => ({ ctrl: !!e.ctrlKey, alt: !!e.altKey, shift: !!e.shiftKey, meta: !!e.metaKey });
    if (hookCursor) {
      const onMove = (e: any) => (hookAt = { x: e.x, y: e.y });
      this.hook.on("mousemove", onMove);
      this.listeners.push(["mousemove", onMove]);
    }
    const clickAt = (e: any) => {
      // the poll cross-checks the hook's point where the poll is reliable (not X11, see above)
      const r = resolveClickPoint({ x: e.x, y: e.y }, hookCursor ? null : screen.getCursorScreenPoint(), this.displays, geom(), cap);
      if (r) this.clickSources[r.source]++;
      return r?.point ?? this.lastCursor ?? { x: 0, y: 0 };
    };
    const on = (ev: string, fn: (e: any) => void) => {
      this.hook!.on(ev, fn);
      this.listeners.push([ev, fn]);
    };
    on("mousedown", (e) => {
      const t = nowEpoch() - t0;
      const p = clickAt(e);
      const b = mouseButton(e.button);
      this.log?.down(t, p.x, p.y, b);
      this.live.push({ t, type: "down", x: p.x, y: p.y, button: b });
    });
    on("mouseup", (e) => {
      const t = nowEpoch() - t0;
      const p = clickAt(e);
      this.log?.up(t, p.x, p.y, mouseButton(e.button));
    });
    on("wheel", (e) => {
      const t = nowEpoch() - t0;
      const p = this.lastCursor ?? { x: 0, y: 0 };
      const amt = Number(e.rotation ?? 0) * Number(e.amount ?? 1);
      this.log?.scroll(t, p.x, p.y, e.direction === 4 ? amt : 0, e.direction === 4 ? 0 : amt);
    });
    on("keydown", (e) => {
      const t = nowEpoch() - t0;
      const k = keyEvent(t, keyName(e.keycode), mods(e), process.platform);
      this.log?.key(k);
      if (k) this.live.push(k);
    });
  }

  private writeChunk(kind: "video" | "audio" | "camera" | "system", buf: Buffer): void {
    const fd = kind === "video" ? this.videoFd : kind === "audio" ? this.audioFd : kind === "camera" ? this.camFd : this.sysFd;
    if (fd !== null) fs.writeSync(fd, buf);
  }

  chunk(kind: "video" | "audio" | "camera" | "system", data: ArrayBuffer | Uint8Array): void {
    this.writeChunk(kind, Buffer.from(data instanceof Uint8Array ? data : new Uint8Array(data)));
  }

  /** Stop logging (the renderer's recorders have flushed their last chunks). */
  stopInput(stopAt?: number): void {
    // the moment Stop was pressed (renderer clock), not when the last chunk landed here
    this.stopEpoch = stopAt && Number.isFinite(stopAt) ? stopAt : nowEpoch();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const [ev, fn] of this.listeners) this.hook?.removeListener(ev, fn);
    this.listeners = [];
    if (this.info) this.log?.end(this.stopEpoch - this.info.videoStart);
    for (const k of ["videoFd", "audioFd", "camFd", "sysFd", "eventsFd"] as const) {
      const fd = this[k];
      if (fd !== null) fs.closeSync(fd);
      this[k] = null;
    }
  }

  /** Turn the raw files into a Lens bundle. Returns the bundle directory. */
  async finalize(ffmpeg: string, onProgress?: (stage: string) => void): Promise<{ dir: string; durationMs: number }> {
    const info = this.info;
    if (!info) throw new Error("recording never started");
    const dir = this.dir;
    onProgress?.("video");
    // VFR webm -> constant-rate H.264 (the editor indexes frames as round(t * fps / 1000)); frame 0 = first
    // captured frame. Chromium's desktop capture sends a frame only when the screen changes, so a still
    // screen before Stop leaves the webm short: the last frame is held (tpad clone) up to the Stop time.
    const wallS = Math.max(0.1, (this.stopEpoch - info.videoStart) / 1000);
    await run(ffmpeg, ["-v", "error", "-y", "-i", path.join(dir, "recording.webm"), "-map", "0:v:0", "-vf", "tpad=stop_mode=clone:stop_duration=600",
      "-fps_mode", "cfr", "-r", String(info.fps), "-t", wallS.toFixed(3),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path.join(dir, "screen.mp4")]);
    const probe = await probeDuration(ffmpeg, path.join(dir, "screen.mp4"));
    const durationMs = probe ?? wallS * 1000;
    const tracks: unknown[] = [];
    if (info.mic && fs.existsSync(path.join(dir, "mic.webm")) && fs.statSync(path.join(dir, "mic.webm")).size > 0) {
      onProgress?.("audio");
      // pinned to 48 kHz stereo here, so every later step (preview, STT, export) reads one fixed format
      // (a mono / layout-less Opus mic broke the v0.1.0 export graph on Windows)
      await run(ffmpeg, ["-v", "error", "-y", "-i", path.join(dir, "mic.webm"), "-vn", "-af", "aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo:sample_rates=48000", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", path.join(dir, "mic.wav")]);
      tracks.push({ id: "mic", kind: "mic", path: "mic.wav", offsetMs: Math.round((info.mic.start - info.videoStart) * 10) / 10, volume: 1, muted: false });
    }
    const nonEmpty = (f: string) => fs.existsSync(path.join(dir, f)) && fs.statSync(path.join(dir, f)).size > 0;
    if (info.system && nonEmpty("system.webm")) {
      onProgress?.("system audio");
      await run(ffmpeg, ["-v", "error", "-y", "-i", path.join(dir, "system.webm"), "-vn", "-af", "aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo:sample_rates=48000", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", path.join(dir, "system.wav")]);
      tracks.push({ id: "system", kind: "system", path: "system.wav", offsetMs: Math.round((info.system.start - info.videoStart) * 10) / 10, volume: 1, muted: false });
    }
    let webcam = false;
    if (info.webcam && nonEmpty("cam.webm")) {
      onProgress?.("camera");
      // on the screen's clock: a camera that started late is padded with its first frame, an early one trimmed
      const lagS = (info.webcam.start - info.videoStart) / 1000;
      const vf = [lagS > 0 ? `tpad=start_mode=clone:start_duration=${lagS.toFixed(3)}` : null, "tpad=stop_mode=clone:stop_duration=600"].filter(Boolean).join(",");
      await run(ffmpeg, ["-v", "error", "-y", ...(lagS < 0 ? ["-ss", (-lagS).toFixed(3)] : []), "-i", path.join(dir, "cam.webm"), "-map", "0:v:0", "-vf", vf,
        "-fps_mode", "cfr", "-r", String(info.fps), "-t", (durationMs / 1000).toFixed(3), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path.join(dir, "cam.mp4")]);
      webcam = true;
    }
    const crop = info.crop && info.crop.w > 0 && info.crop.h > 0 ? info.crop : null;
    const pixelRatio = this.captured ? this.captured.scaleFactor * (info.capture.width / (this.captured.physical?.width ?? this.captured.bounds.width * this.captured.scaleFactor)) : 1;
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ width: info.capture.width, height: info.capture.height, fps: info.fps, durationMs, pixelRatio: Math.round(pixelRatio * 1000) / 1000 }));
    // Windows #9: Chromium (Electron 38) does not implement getDisplayMedia's cursor: "never" yet, so the
    // OS cursor is usually baked into the frames. Then Lens's own cursor starts off, so the editor
    // and export never show two cursors; it turns on by itself once the capture really excludes it.
    const baked = cursorBaked(info.cursor);
    fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ version: 1, audio: { tracks }, ...(baked ? { cursor: { visible: false } } : {}), ...(webcam ? { camera: { enabled: true } } : {}), ...(crop ? { crop } : {}), ...(info.output ? { output: info.output } : {}) }, null, 2));
    fs.writeFileSync(path.join(dir, "recording.json"), JSON.stringify({
      app: "lens-desktop", platform: process.platform, source: { id: info.sourceId, name: info.sourceName, kind: info.kind, displayId: info.displayId ?? null },
      capture: info.capture, cursor: info.cursor ? { ...info.cursor, baked } : null, fps: info.fps, videoMime: info.videoMime, videoStartEpoch: info.videoStart, clock: info.clock ?? null, stopEpoch: this.stopEpoch, wallMs: this.stopEpoch - info.videoStart,
      displays: this.displays, captured: this.captured, counts: this.log?.counts, clickSources: this.clickSources, warnings: this.warnings,
      // the editor transcribes the mic on-device the first time it opens this recording (Windows #5)
      autoTranscribe: tracks.length > 0,
    }, null, 2));
    return { dir, durationMs };
  }
}

let KEY_NAMES: Map<number, string> | null = null;
export function setKeyTable(table: Record<string, number>): void {
  KEY_NAMES = new Map(Object.entries(table).map(([k, v]) => [v, k]));
}
function keyName(code: number): string | undefined {
  return KEY_NAMES?.get(code);
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let err = "";
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} failed (${code}): ${err.slice(-600)}`))));
  });
}

/** Container duration in ms from `ffmpeg -i` ("Duration: 00:00:08.03"). */
export async function probeDuration(ffmpeg: string, file: string): Promise<number | null> {
  return new Promise((resolve) => {
    const p = spawn(ffmpeg, ["-hide_banner", "-i", file]);
    let err = "";
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", () => resolve(null));
    p.on("close", () => {
      const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(err);
      resolve(m ? Math.round(((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000) : null);
    });
  });
}
