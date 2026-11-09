/**
 * Editor chrome layout (Windows bugs #2/#3/#11): side panel widths, timeline height, collapsed
 * panels, preview fullscreen and preview zoom. Pure sizing rules (unit-tested) plus a tiny store.
 * Sizes the user drags are remembered (localStorage); untouched ones follow the window size, so the
 * editor fits from ~1024x640 to 4K and Windows 125 / 150 % scaling (a 1920x1080 @150 % screen is a
 * 1280x720 CSS viewport).
 */
import { useSyncExternalStore } from "react";

export interface UiLayout {
  leftW: number;
  rightW: number;
  tlH: number;
  leftOpen: boolean;
  rightOpen: boolean;
  fullscreen: boolean;
  /** Preview scale: fit the stage, or 100 % (one output pixel per device pixel, scrollable). */
  previewZoom: "fit" | "100";
}

export const TOPBAR_H = 52;
export const SPLIT = 5;
/** Smallest centre column / stage the clamps keep. */
export const MIN_CENTER_W = 380;
export const MIN_STAGE_H = 240;
export const MIN_TL_H = 120;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Defaults for a viewport: panels and timeline scale with the window inside sane bounds. */
export function defaultLayout(vw: number, vh: number): Pick<UiLayout, "leftW" | "rightW" | "tlH" | "leftOpen" | "rightOpen"> {
  return {
    leftW: clamp(Math.round(vw * 0.17), 200, 272),
    rightW: clamp(Math.round(vw * 0.21), 250, 332),
    tlH: clamp(Math.round(vh * 0.3), 170, 326),
    leftOpen: vw >= 1100,
    rightOpen: true,
  };
}

/** Keep sizes usable for the viewport: the centre column and the stage never collapse. */
export function clampLayout<T extends Pick<UiLayout, "leftW" | "rightW" | "tlH" | "leftOpen" | "rightOpen">>(l: T, vw: number, vh: number): T {
  let leftW = clamp(l.leftW, 180, 480);
  let rightW = clamp(l.rightW, 230, 520);
  const room = vw - MIN_CENTER_W - 2 * SPLIT;
  const used = (l.leftOpen ? leftW : 0) + (l.rightOpen ? rightW : 0);
  if (used > room && used > 0) {
    const k = Math.max(0, room) / used;
    leftW = Math.max(160, Math.floor(leftW * k));
    rightW = Math.max(220, Math.floor(rightW * k));
  }
  const tlH = clamp(l.tlH, MIN_TL_H, Math.max(MIN_TL_H, vh - TOPBAR_H - SPLIT - MIN_STAGE_H));
  return { ...l, leftW, rightW, tlH };
}

const KEY = "lens.editor.layout.v1";
type Saved = Partial<Pick<UiLayout, "leftW" | "rightW" | "tlH" | "leftOpen" | "rightOpen">>;

function readSaved(): Saved {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Saved;
  } catch {
    return {};
  }
}

class UiStore {
  private saved: Saved = typeof localStorage !== "undefined" ? readSaved() : {};
  private extra: Pick<UiLayout, "fullscreen" | "previewZoom"> = { fullscreen: false, previewZoom: "fit" };
  private s: UiLayout = this.compute();
  private listeners = new Set<() => void>();

  private vw(): number {
    return typeof window !== "undefined" ? window.innerWidth : 1600;
  }
  private vh(): number {
    return typeof window !== "undefined" ? window.innerHeight : 1000;
  }
  private compute(): UiLayout {
    const base = { ...defaultLayout(this.vw(), this.vh()), ...this.saved };
    return { ...clampLayout(base, this.vw(), this.vh()), ...this.extra };
  }
  get = (): UiLayout => this.s;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  private emit(): void {
    this.s = this.compute();
    for (const l of this.listeners) l();
  }
  /** Window resized: re-derive untouched sizes and re-clamp. */
  resize(): void {
    this.emit();
  }
  set(patch: Saved): void {
    this.saved = { ...this.saved, ...patch };
    for (const k of Object.keys(patch) as Array<keyof Saved>) if (patch[k] === undefined) delete this.saved[k];
    try {
      localStorage.setItem(KEY, JSON.stringify(this.saved));
    } catch {
      // private mode: keep in memory
    }
    this.emit();
  }
  reset(): void {
    this.saved = {};
    try {
      localStorage.removeItem(KEY);
    } catch {
      // ignore
    }
    this.emit();
  }
  setFullscreen(on: boolean): void {
    if (this.extra.fullscreen === on) return;
    this.extra = { ...this.extra, fullscreen: on };
    const d = typeof document !== "undefined" ? document : null;
    // best effort real fullscreen (Electron / browsers); the CSS mode works without it
    try {
      if (on && d && !d.fullscreenElement) void d.documentElement.requestFullscreen?.().catch(() => undefined);
      if (!on && d?.fullscreenElement) void d.exitFullscreen?.().catch(() => undefined);
    } catch {
      // not allowed here
    }
    this.emit();
  }
  toggleFullscreen(): void {
    this.setFullscreen(!this.extra.fullscreen);
  }
  setPreviewZoom(z: UiLayout["previewZoom"]): void {
    this.extra = { ...this.extra, previewZoom: z };
    this.emit();
  }
}

export const ui = new UiStore();
if (typeof window !== "undefined") {
  window.addEventListener("resize", () => ui.resize());
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && ui.get().fullscreen) ui.setFullscreen(false);
  });
}

export function useUi<T>(sel: (s: UiLayout) => T): T {
  return useSyncExternalStore(ui.subscribe, () => sel(ui.get()));
}
