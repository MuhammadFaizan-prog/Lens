/**
 * Pre-flight check (demand #25): before a recording starts, the recorder checks what would silently
 * ruin the take and says so. Pure logic here (the recorder and main gather the inputs), so it is unit
 * tested with mocked devices and disk.
 *
 * Levels: "block" = the recording would fail or be useless (no source, permission denied, chosen
 * microphone missing, not enough disk for even a short take); "warn" = it records, but something is
 * probably wrong (silent microphone, camera that will not open, little disk left, system audio not
 * supported here); "info" = a hint (notifications / Do Not Disturb); "ok" = checked and fine.
 */

export type Level = "ok" | "info" | "warn" | "block";
export type Permission = "granted" | "denied" | "restricted" | "not-determined" | "unknown";

export interface PreflightInput {
  platform: string;
  /** The chosen screen / window (null = nothing to record), and its capture size when known. */
  source: { name: string; kind: "screen" | "window"; width: number; height: number } | null;
  /** Custom (region) mode with no area drawn yet. */
  regionMissing?: boolean;
  fps: number;
  /** Screen recorder bits per pixel per frame (Settings > Record quality). */
  bpp: number;
  /** Microphones the user chose ("" device id = default device). present = listed by the OS right now. */
  mics: Array<{ id: string; label: string; present: boolean; error?: string | null; peakDb: number | null }>;
  camera: { id: string; label: string; present: boolean; error?: string | null } | null;
  systemAudio: { wanted: boolean; supported: boolean };
  disk: { freeBytes: number | null; path: string };
  permissions: { screen: Permission; microphone: Permission; camera: Permission };
}

export interface Check {
  id: string;
  label: string;
  level: Level;
  detail: string;
}

/** Peak level below this over the test window = the microphone is silent (muted, wrong input, unplugged). */
export const SILENT_DB = -50;
/** Not enough free space for this many minutes = block; for WARN_MIN minutes = warn. */
export const BLOCK_MIN = 2;
export const WARN_MIN = 30;

/**
 * Disk use per minute of recording, bytes: the raw capture (screen at w*h*fps*bpp, 128 kb/s Opus per
 * audio input, 2.5 Mb/s camera) plus what Stop writes next to it (screen.mp4 about the same size as the
 * capture, 48 kHz 16-bit stereo WAV per audio track, cam.mp4).
 */
export function bytesPerMinute(i: Pick<PreflightInput, "source" | "fps" | "bpp" | "mics" | "camera" | "systemAudio">): number {
  const w = i.source?.width ?? 1920;
  const h = i.source?.height ?? 1080;
  const screenBps = w * h * i.fps * i.bpp;
  const audioTracks = i.mics.length + (i.systemAudio.wanted && i.systemAudio.supported ? 1 : 0);
  const rawBps = screenBps + audioTracks * 128_000 + (i.camera ? 2_500_000 : 0);
  const finalBps = screenBps + audioTracks * 48_000 * 2 * 16 + (i.camera ? 2_500_000 : 0);
  return Math.ceil(((rawBps + finalBps) / 8) * 60);
}

const mb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);

export function preflightChecks(i: PreflightInput): Check[] {
  const out: Check[] = [];
  // what is recorded
  if (!i.source) out.push({ id: "source", label: "Screen or window", level: "block", detail: "Nothing selected to record. Pick a screen or a window." });
  else if (i.regionMissing) out.push({ id: "source", label: "Screen or window", level: "block", detail: "Custom mode: drag the area to record first." });
  else out.push({ id: "source", label: "Screen or window", level: "ok", detail: `${i.source.kind === "window" ? "Window" : "Screen"} "${i.source.name}"${i.source.width ? `, ${i.source.width}x${i.source.height}` : ""}` });
  // permissions (macOS reports them; elsewhere "unknown" = not asked by the OS)
  const denied = (p: Permission) => p === "denied" || p === "restricted";
  if (denied(i.permissions.screen)) out.push({ id: "perm-screen", label: "Screen recording permission", level: "block", detail: "Lens is not allowed to record the screen. Allow it in System Settings > Privacy & Security > Screen Recording, then restart Lens." });
  // microphones
  if (!i.mics.length) out.push({ id: "mic", label: "Microphone", level: "info", detail: "No microphone: the recording will have no voice." });
  for (const [n, m] of i.mics.entries()) {
    const id = i.mics.length > 1 ? `mic-${n + 1}` : "mic";
    const label = i.mics.length > 1 ? `Microphone ${n + 1} (${m.label})` : `Microphone (${m.label})`;
    if (denied(i.permissions.microphone)) out.push({ id, label, level: "block", detail: "Lens is not allowed to use the microphone. Allow it in the system privacy settings, or turn the microphone off." });
    else if (!m.present) out.push({ id, label, level: "block", detail: "This microphone is not connected. Plug it in or choose another one." });
    else if (m.error) out.push({ id, label, level: "block", detail: `This microphone could not be opened: ${m.error}` });
    else if (m.peakDb === null) out.push({ id, label, level: "warn", detail: "No level reading yet. Say something and check the meter moves." });
    else if (m.peakDb < SILENT_DB) out.push({ id, label, level: "warn", detail: `Silent (peak ${m.peakDb.toFixed(0)} dBFS). Is it muted, or the wrong input? Say something and watch the meter.` });
    else out.push({ id, label, level: "ok", detail: `Hearing you (peak ${m.peakDb.toFixed(0)} dBFS)` });
  }
  // camera
  if (i.camera) {
    if (denied(i.permissions.camera)) out.push({ id: "camera", label: `Camera (${i.camera.label})`, level: "warn", detail: "Lens is not allowed to use the camera: the recording will have no camera." });
    else if (!i.camera.present) out.push({ id: "camera", label: `Camera (${i.camera.label})`, level: "warn", detail: "This camera is not connected: the recording will have no camera." });
    else if (i.camera.error) out.push({ id: "camera", label: `Camera (${i.camera.label})`, level: "warn", detail: `The camera could not be opened (${i.camera.error}): the recording will have no camera.` });
    else out.push({ id: "camera", label: `Camera (${i.camera.label})`, level: "ok", detail: "Camera preview is running" });
  }
  if (i.systemAudio.wanted && !i.systemAudio.supported) out.push({ id: "system-audio", label: "System audio", level: "warn", detail: "System audio cannot be recorded on this system: the recording will not have it." });
  // disk
  const per = bytesPerMinute(i);
  if (i.disk.freeBytes === null) out.push({ id: "disk", label: "Free disk space", level: "warn", detail: `Could not read the free space at ${i.disk.path}.` });
  else {
    const minutes = i.disk.freeBytes / per;
    const est = `about ${mb(per)} per minute`;
    if (minutes < BLOCK_MIN) out.push({ id: "disk", label: "Free disk space", level: "block", detail: `Only ${mb(i.disk.freeBytes)} free at ${i.disk.path}; this recording needs ${est}. Free some space or choose another save folder in Settings.` });
    else if (minutes < WARN_MIN) out.push({ id: "disk", label: "Free disk space", level: "warn", detail: `${mb(i.disk.freeBytes)} free: room for about ${Math.floor(minutes)} min (${est}).` });
    else out.push({ id: "disk", label: "Free disk space", level: "ok", detail: `${mb(i.disk.freeBytes)} free: room for ${minutes >= 600 ? "10+ h" : `about ${Math.floor(minutes)} min`} (${est})` });
  }
  // notifications: no OS exposes Do Not Disturb to apps reliably, so this is a hint
  const dnd = i.platform === "win32" ? "Turn on Do Not Disturb (Windows: Win+N, then Do not disturb)" : i.platform === "darwin" ? "Turn on a Focus mode (Control Center > Focus)" : "Turn on Do Not Disturb in your desktop's notification settings";
  out.push({ id: "notifications", label: "Notifications", level: "info", detail: `${dnd} so pop-ups do not appear in the recording.` });
  return out;
}

/** Worst level of a set of checks (the recorder blocks Start on "block", asks on "warn"). */
export function worst(checks: Check[]): Level {
  const order: Level[] = ["ok", "info", "warn", "block"];
  return checks.reduce<Level>((w, c) => (order.indexOf(c.level) > order.indexOf(w) ? c.level : w), "ok");
}

/**
 * Silent-microphone watch while recording: fires once when every level reading for `ms` (default 5 s)
 * was below SILENT_DB, and clears when sound comes back.
 */
export class SilenceWatch {
  private quietSince: number | null = null;
  silent = false;
  constructor(private readonly ms = 5000, private readonly db = SILENT_DB) {}
  /** Feed one level reading (dBFS) at time t (ms). Returns true when the state changed. */
  push(t: number, levelDb: number): boolean {
    if (levelDb >= this.db) {
      this.quietSince = null;
      if (this.silent) {
        this.silent = false;
        return true;
      }
      return false;
    }
    this.quietSince ??= t;
    if (!this.silent && t - this.quietSince >= this.ms) {
      this.silent = true;
      return true;
    }
    return false;
  }
}
