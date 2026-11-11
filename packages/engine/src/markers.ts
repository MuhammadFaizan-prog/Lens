/**
 * Hotkey zoom markers (demand #19). While recording, a global shortcut drops a "zoom here" marker
 * into the recording's marker log (`markers.jsonl` in the bundle, one JSON object per line, times on
 * the video clock like events.jsonl). When the project is created, every marker becomes a manual
 * zoom block that starts at the marker's time and is aimed at where the cursor was when the key was
 * pressed. The blocks are ordinary manual zoom segments: the user moves, trims, re-aims or deletes
 * them in the editor like any other zoom block.
 *
 * A marker log is a separate file so the input-event log and everything that reads it are unchanged.
 */
import type { RecordingMeta, ZoomSegment } from "./types.js";

export const MARKER_LOG_VERSION = 1;

export interface RecordingMarker {
  /** ms on the video clock (t = 0 at the first recorded frame). */
  t: number;
  kind: "zoom";
  /** Cursor position at the key press, capture px; absent when the cursor was unknown. */
  x?: number;
  y?: number;
}

/** One marker-log line (no newline): t to 0.1 ms, positions to 0.01 px. */
export function formatMarker(m: RecordingMarker): string {
  const o: Record<string, unknown> = { t: Math.round(m.t * 10) / 10, kind: m.kind };
  if (typeof m.x === "number" && typeof m.y === "number") {
    o.x = Math.round(m.x * 100) / 100;
    o.y = Math.round(m.y * 100) / 100;
  }
  return JSON.stringify(o);
}

/**
 * Parse a marker log. Lines starting with # are comments (the header); a line that is not valid JSON
 * or lacks a finite t is skipped (a log cut off by a crash mid-line still yields every whole marker).
 * Sorted by time.
 */
export function parseMarkerLog(text: string): RecordingMarker[] {
  const out: RecordingMarker[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const s = raw.trim();
    if (!s || s.startsWith("#")) continue;
    let o: unknown;
    try {
      o = JSON.parse(s);
    } catch {
      continue;
    }
    const r = o as Partial<RecordingMarker> | null;
    if (!r || typeof r !== "object" || typeof r.t !== "number" || !Number.isFinite(r.t) || r.t < 0) continue;
    if ((r.kind ?? "zoom") !== "zoom") continue;
    const m: RecordingMarker = { t: r.t, kind: "zoom" };
    if (typeof r.x === "number" && typeof r.y === "number" && Number.isFinite(r.x) && Number.isFinite(r.y)) {
      m.x = r.x;
      m.y = r.y;
    }
    out.push(m);
  }
  return out.sort((a, b) => a.t - b.t);
}

export interface MarkerZoomOptions {
  /** Zoom of each block (the project's zoom.defaultScale). */
  scale: number;
  /** How long a block lasts when no later marker cuts it short. Default 3000 ms. */
  holdMs?: number;
  /** Shortest block kept; a second press within this of the first is a double tap and is dropped. Default 400 ms. */
  minMs?: number;
}

export const MARKER_HOLD_MS = 3000;
export const MARKER_MIN_MS = 400;

/**
 * Zoom blocks for the markers: one manual segment per marker, from the marker's time for holdMs (or
 * up to the next marker, so consecutive markers pan from one point to the next instead of
 * overlapping), clamped to the recording. Focus = the cursor at the press (clamped into the frame),
 * or "follow" when the marker has no position.
 */
export function markerZoomSegments(markers: RecordingMarker[], meta: Pick<RecordingMeta, "width" | "height" | "durationMs">, opts: MarkerZoomOptions): ZoomSegment[] {
  const hold = opts.holdMs ?? MARKER_HOLD_MS;
  const min = opts.minMs ?? MARKER_MIN_MS;
  const sorted = [...markers].filter((m) => m.kind === "zoom" && m.t < meta.durationMs).sort((a, b) => a.t - b.t);
  // a press within `min` of the previous kept press is a double tap: ignored
  const kept: RecordingMarker[] = [];
  for (const m of sorted) if (!kept.length || m.t - kept[kept.length - 1]!.t >= min) kept.push(m);
  const out: ZoomSegment[] = [];
  kept.forEach((m, i) => {
    const next = kept[i + 1];
    const end = Math.min(m.t + hold, next ? next.t : Infinity, meta.durationMs);
    if (end - m.t < Math.min(min, hold)) return;
    const focus = typeof m.x === "number" && typeof m.y === "number"
      ? { x: Math.max(0, Math.min(meta.width, m.x)), y: Math.max(0, Math.min(meta.height, m.y)) }
      : ("follow" as const);
    out.push({ id: `marker-${i + 1}`, startMs: Math.round(m.t * 10) / 10, endMs: Math.round(end * 10) / 10, scale: opts.scale, focus, style: "classic", auto: false });
  });
  return out;
}
