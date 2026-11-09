/**
 * The recorder's input-event log: events.jsonl in a Lens bundle, one engine InputEvent per line
 * (packages/engine/src/types.ts), parsed by the engine's parseEventLog. Times are ms on the video
 * clock (t = 0 at the first recorded video frame); positions are capture px of the recorded display.
 *
 * Privacy (docs/Rules.md rule 5): a key press is stored with its name only when it is a shortcut
 * (Ctrl / Alt / Meta / Cmd held, the key itself not a modifier). Every other key press (letters,
 * digits, Shift+letter, Enter, Backspace, ...) is stored as timing only: `{"t":..,"type":"key","key":"","modifiers":[]}`.
 * Bare modifier presses are not stored at all.
 */
import type { InputEvent, Modifier, MouseButton } from "../../../../packages/engine/src/types";

export const EVENT_LOG_VERSION = 1;

export interface ModState {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

/** Key names of modifier keys (uiohook-napi UiohookKey names). */
export const MODIFIER_KEY_NAMES = new Set(["Ctrl", "CtrlRight", "Alt", "AltRight", "Shift", "ShiftRight", "Meta", "MetaRight", "CapsLock", "NumLock", "ScrollLock"]);

/** uiohook key name -> the engine's key name (events.ts KEY_GLYPH / shortcut labels). */
export function engineKeyName(name: string): string {
  if (name === "Space") return " ";
  if (/^Numpad\d$/.test(name)) return name.slice(6);
  const map: Record<string, string> = {
    Semicolon: ";", Equal: "=", Comma: ",", Minus: "-", Period: ".", Slash: "/", Backquote: "`",
    BracketLeft: "[", Backslash: "\\", BracketRight: "]", Quote: "'", NumpadAdd: "+", NumpadSubtract: "-",
    NumpadMultiply: "*", NumpadDivide: "/", NumpadDecimal: ".", NumpadEnter: "Enter",
  };
  return map[name] ?? name;
}

/**
 * The event to store for a key press, or null when nothing is stored. `name` is the uiohook key name
 * (undefined for unknown keycodes). `platform` decides whether Meta is "cmd" (macOS) or "meta".
 */
export function keyEvent(t: number, name: string | undefined, mods: ModState, platform: string = "win32"): InputEvent | null {
  if (name && MODIFIER_KEY_NAMES.has(name)) return null;
  const shortcut = mods.ctrl || mods.alt || mods.meta;
  if (!shortcut || !name) return { t, type: "key", key: "", modifiers: [] };
  const modifiers: Modifier[] = [];
  if (mods.ctrl) modifiers.push("ctrl");
  if (mods.alt) modifiers.push("alt");
  if (mods.shift) modifiers.push("shift");
  if (mods.meta) modifiers.push(platform === "darwin" ? "cmd" : "meta");
  return { t, type: "key", key: engineKeyName(name), modifiers };
}

/** uiohook mouse button number -> engine button (1 left, 2 right, 3 middle). */
export function mouseButton(b: unknown): MouseButton {
  return b === 2 ? "right" : b === 3 ? "middle" : "left";
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** One JSONL line (no newline): t to 0.1 ms, positions to 0.01 px. */
export function formatEvent(e: InputEvent): string {
  const o: Record<string, unknown> = { ...e, t: r1(e.t) };
  if ("x" in e) {
    o.x = r2(e.x);
    o.y = r2(e.y);
  }
  return JSON.stringify(o);
}

export function headerLine(info: Record<string, unknown>): string {
  return `# lens-events v${EVENT_LOG_VERSION} ${JSON.stringify(info)}`;
}

/**
 * Builds the log as events arrive. Cursor samples (about 60 Hz) are written only when the position
 * changes; when the cursor starts moving after standing still, the last still position is written
 * again at the previous sample's time, so linear interpolation between samples (rawCursorAt) does not
 * smear the movement back over the still period.
 */
export class EventLogWriter {
  private lastMove: { t: number; x: number; y: number } | null = null;
  private lastWrittenT = -Infinity;
  private pendingStill: { t: number; x: number; y: number } | null = null;
  counts = { move: 0, down: 0, up: 0, scroll: 0, key: 0, shortcut: 0 };

  constructor(private readonly write: (line: string) => void) {}

  private put(e: InputEvent): void {
    this.write(formatEvent(e) + "\n");
  }

  move(t: number, x: number, y: number): void {
    const last = this.lastMove;
    if (last && Math.abs(last.x - x) < 0.005 && Math.abs(last.y - y) < 0.005) {
      this.pendingStill = { t, x, y };
      return;
    }
    if (this.pendingStill && this.pendingStill.t > this.lastWrittenT) {
      this.put({ t: this.pendingStill.t, type: "move", x: this.pendingStill.x, y: this.pendingStill.y });
      this.counts.move++;
    }
    this.pendingStill = null;
    this.put({ t, type: "move", x, y });
    this.counts.move++;
    this.lastWrittenT = t;
    this.lastMove = { t, x, y };
  }

  down(t: number, x: number, y: number, button: MouseButton): void {
    this.put({ t, type: "down", x, y, button });
    this.counts.down++;
  }

  up(t: number, x: number, y: number, button: MouseButton): void {
    this.put({ t, type: "up", x, y, button });
    this.counts.up++;
  }

  scroll(t: number, x: number, y: number, dx: number, dy: number): void {
    this.put({ t, type: "scroll", x, y, dx, dy });
    this.counts.scroll++;
  }

  key(e: InputEvent | null): void {
    if (!e || e.type !== "key") return;
    this.put(e);
    this.counts.key++;
    if (e.key) this.counts.shortcut++;
  }

  /** Flush a trailing still period (the cursor never moved again before Stop). */
  end(t: number): void {
    if (this.lastMove && t > this.lastWrittenT) {
      this.put({ t, type: "move", x: this.lastMove.x, y: this.lastMove.y });
      this.counts.move++;
      this.lastWrittenT = t;
    }
  }
}
