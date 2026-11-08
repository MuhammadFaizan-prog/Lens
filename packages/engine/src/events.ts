import type { InputEvent, Modifier, TimeRange, Vec2 } from "./types.js";

/** Parse a JSON-lines input-event log. Blank lines and lines starting with # are ignored. */
export function parseEventLog(text: string): InputEvent[] {
  const out: InputEvent[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const s = line.trim();
    if (!s || s.startsWith("#")) return;
    let e: unknown;
    try {
      e = JSON.parse(s);
    } catch {
      throw new Error(`event log line ${i + 1}: invalid JSON`);
    }
    if (typeof e !== "object" || e === null || typeof (e as { t?: unknown }).t !== "number")
      throw new Error(`event log line ${i + 1}: missing numeric t`);
    out.push(e as InputEvent);
  });
  return out.sort((a, b) => a.t - b.t);
}

export function positionedEvents(events: InputEvent[]): Array<InputEvent & { x: number; y: number }> {
  return events.filter((e): e is InputEvent & { x: number; y: number } => "x" in e && "y" in e);
}

/** Raw cursor position at time t by linear interpolation of positioned events. */
export function rawCursorAt(events: InputEvent[], tMs: number): Vec2 | null {
  const pos = positionedEvents(events);
  if (pos.length === 0) return null;
  const first = pos[0]!;
  if (tMs <= first.t) return { x: first.x, y: first.y };
  for (let i = 1; i < pos.length; i++) {
    const b = pos[i]!;
    if (b.t >= tMs) {
      const a = pos[i - 1]!;
      const span = b.t - a.t;
      const u = span <= 0 ? 1 : (tMs - a.t) / span;
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
    }
  }
  const last = pos[pos.length - 1]!;
  return { x: last.x, y: last.y };
}

export function clicks(events: InputEvent[]): Array<{ t: number; x: number; y: number }> {
  return events
    .filter((e): e is Extract<InputEvent, { type: "down" }> => e.type === "down")
    .map((e) => ({ t: e.t, x: e.x, y: e.y }));
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "Command", "Option", "CapsLock"]);
const SHORTCUT_MODS: Modifier[] = ["cmd", "ctrl", "alt", "meta"];

function isShortcut(e: Extract<InputEvent, { type: "key" }>): boolean {
  return e.modifiers.some((m) => SHORTCUT_MODS.includes(m));
}

export interface TypingOptions {
  /** Max gap between keystrokes inside one stretch. */
  maxGapMs: number;
  minKeys: number;
  minDurationMs: number;
}

export const DEFAULT_TYPING: TypingOptions = { maxGapMs: 800, minKeys: 6, minDurationMs: 1500 };

/** Detect typing stretches (E04). Shortcuts and bare modifier presses do not count as typing. */
export function detectTyping(events: InputEvent[], opts: TypingOptions = DEFAULT_TYPING): TimeRange[] {
  const keys = events.filter(
    (e): e is Extract<InputEvent, { type: "key" }> => e.type === "key" && !isShortcut(e) && !MODIFIER_KEYS.has(e.key),
  );
  const out: TimeRange[] = [];
  let start = -1;
  let last = -1;
  let count = 0;
  const flush = () => {
    if (start >= 0 && count >= opts.minKeys && last - start >= opts.minDurationMs) out.push({ startMs: start, endMs: last });
  };
  for (const k of keys) {
    if (start < 0 || k.t - last > opts.maxGapMs) {
      flush();
      start = k.t;
      count = 0;
    }
    last = k.t;
    count++;
  }
  flush();
  return out;
}

const KEY_GLYPH: Record<string, string> = {
  cmd: "⌘",
  meta: "⌘",
  ctrl: "Ctrl",
  alt: "⌥",
  shift: "⇧",
  Enter: "↩",
  Backspace: "⌫",
  Tab: "⇥",
  Escape: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  " ": "Space",
};

export interface ShortcutOverlay {
  startMs: number;
  endMs: number;
  label: string;
}

/** Keyboard shortcut overlays (E11): only modifier combos, never plain typing (Security.md). */
export function shortcutOverlays(events: InputEvent[], displayMs: number): ShortcutOverlay[] {
  const out: ShortcutOverlay[] = [];
  for (const e of events) {
    if (e.type !== "key" || !isShortcut(e) || MODIFIER_KEYS.has(e.key)) continue;
    const order: Modifier[] = ["ctrl", "alt", "shift", "cmd", "meta"];
    const mods = order.filter((m) => e.modifiers.includes(m)).map((m) => KEY_GLYPH[m] ?? m);
    const key = KEY_GLYPH[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
    const label = [...mods, key].join(" ");
    const prev = out[out.length - 1];
    if (prev && prev.label === label && e.t - prev.startMs < displayMs) {
      prev.endMs = e.t + displayMs;
      continue;
    }
    if (prev && prev.endMs > e.t) prev.endMs = e.t;
    out.push({ startMs: e.t, endMs: e.t + displayMs, label });
  }
  return out;
}
