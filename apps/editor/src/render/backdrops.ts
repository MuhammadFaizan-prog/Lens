/**
 * Lens's own backdrop art (Windows bug #20): procedural abstract images, drawn on demand from a seed
 * and a palette, so they ship as code (no image files, nothing downloaded, works offline) and the
 * preview, the export worker and the picker thumbnails draw exactly the same picture at any size.
 * Original designs; no third-party wallpapers or assets. The table lives in the engine (backdropArt.ts).
 *
 * The original twelve are vector Canvas2D drawings (below, unchanged). The v0.1.4 "field" backdrops
 * are per-pixel functions (engine backdropField.ts) rendered at the exact size asked for, so a 4K
 * export gets 4K pixels. They are cached per (backdrop, size); on the UI thread a large one renders in
 * a worker (render/backdropWorker.ts) while a small render of the same picture stands in, and
 * ensurePlanAssets() waits for it so the preview redraws once it lands. The export worker renders
 * synchronously, so the exported frames always carry the full-resolution picture.
 */
import { BACKDROP_CATEGORIES, BUILTIN_BACKDROPS, backdropById, backdropCategories, isFieldStyle, renderBackdropField, type Backdrop, type BackdropCategory } from "@lens/engine";
import { makeCanvas, type AnyCanvas } from "./canvas";

export { BACKDROP_CATEGORIES, BUILTIN_BACKDROPS, backdropById, backdropCategories, type Backdrop, type BackdropCategory };

type G = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Draw a built-in backdrop filling W x H (resolution independent: positions and sizes are fractions).
 * Returns false when a stand-in was drawn because the full-size field backdrop is still rendering
 * (UI thread only); draw again once prepareBackdrop() resolves.
 */
export function drawBackdrop(g: G, b: Backdrop, W: number, H: number): boolean {
  if (isFieldStyle(b.style)) return drawField(g, b, W, H);
  drawClassic(g, b, W, H);
  return true;
}

/** The original twelve's vector drawing (unchanged since v0.1.2: old projects render identically). */
function drawClassic(g: G, b: Backdrop, W: number, H: number): void {
  const r = rng(b.seed);
  const c = b.colors;
  const lin = g.createLinearGradient(0, 0, W, H);
  lin.addColorStop(0, c[0]!);
  lin.addColorStop(1, c[1]!);
  g.fillStyle = lin;
  g.fillRect(0, 0, W, H);
  const S = Math.max(W, H);
  g.save();
  if (b.style === "blobs" || b.style === "grain") {
    for (let i = 0; i < 7; i++) {
      const x = r() * W;
      const y = r() * H;
      const rad = S * (0.25 + r() * 0.45);
      const col = c[2 + (i % 2)]!;
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      gr.addColorStop(0, hexA(col, 0.55));
      gr.addColorStop(1, hexA(col, 0));
      g.fillStyle = gr;
      g.fillRect(0, 0, W, H);
    }
  }
  if (b.style === "waves") {
    for (let i = 0; i < 6; i++) {
      const amp = H * (0.05 + r() * 0.1);
      const y0 = H * (0.25 + i * 0.12);
      const ph = r() * Math.PI * 2;
      const k = (Math.PI * 2 * (0.6 + r())) / W;
      g.beginPath();
      g.moveTo(0, H);
      for (let x = 0; x <= W; x += Math.max(4, W / 160)) g.lineTo(x, y0 + Math.sin(x * k + ph) * amp);
      g.lineTo(W, H);
      g.closePath();
      g.fillStyle = hexA(c[2 + (i % 2)]!, 0.16);
      g.fill();
    }
  }
  if (b.style === "rays") {
    const cx = W * (0.2 + r() * 0.6);
    const cy = -H * 0.2;
    for (let i = 0; i < 9; i++) {
      const a0 = Math.PI * (0.15 + (i / 9) * 0.7) + (r() - 0.5) * 0.05;
      const a1 = a0 + 0.035 + r() * 0.05;
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + Math.cos(a0) * S * 2, cy + Math.sin(a0) * S * 2);
      g.lineTo(cx + Math.cos(a1) * S * 2, cy + Math.sin(a1) * S * 2);
      g.closePath();
      g.fillStyle = hexA(c[2 + (i % 2)]!, 0.18);
      g.fill();
    }
    const gr = g.createRadialGradient(cx, cy, 0, cx, cy, S * 1.1);
    gr.addColorStop(0, hexA(c[3]!, 0.35));
    gr.addColorStop(1, hexA(c[3]!, 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, W, H);
  }
  if (b.style === "grain") {
    // fine deterministic speckle (stars / film grain), density per area
    const n = Math.round((W * H) / 900);
    for (let i = 0; i < n; i++) {
      g.fillStyle = hexA(c[3]!, 0.15 + r() * 0.5);
      const s = Math.max(1, (S / 1080) * (r() < 0.95 ? 1 : 2.4));
      g.fillRect(r() * W, r() * H, s, s);
    }
  }
  g.restore();
}

// ---- field backdrops -------------------------------------------------------------------------------

/** Above this many pixels the UI thread renders a field backdrop in a worker, not inline. */
const UI_SYNC_MAX_PX = 260_000;
const LRU_MAX = 4;
const fields = new Map<string, AnyCanvas>();
const pending = new Map<string, Promise<boolean>>();
const onUiThread = () => typeof document !== "undefined";
const keyOf = (b: Backdrop, W: number, H: number) => `${b.id}|${b.seed}|${b.colors.join(",")}|${b.variant ?? 0}|${W}x${H}`;

function toCanvas(px: Uint8ClampedArray, W: number, H: number): AnyCanvas {
  const c = makeCanvas(W, H);
  const g = c.getContext("2d") as G;
  g.putImageData(new ImageData(px as Uint8ClampedArray<ArrayBuffer>, W, H), 0, 0);
  return c;
}

function remember(key: string, c: AnyCanvas): void {
  fields.delete(key);
  fields.set(key, c);
  while (fields.size > LRU_MAX) fields.delete(fields.keys().next().value!);
}

function fieldNow(b: Backdrop, W: number, H: number): AnyCanvas {
  const key = keyOf(b, W, H);
  let c = fields.get(key);
  if (!c) {
    c = toCanvas(renderBackdropField(b, W, H), W, H);
    remember(key, c);
  } else remember(key, c);
  return c;
}

/** A small render of the same picture (cached), drawn scaled up while the full size renders. */
const standIns = new Map<string, AnyCanvas>();
function standIn(b: Backdrop, W: number, H: number): AnyCanvas {
  const k = Math.min(1, 384 / Math.max(W, H));
  const w = Math.max(1, Math.round(W * k));
  const h = Math.max(1, Math.round(H * k));
  const key = keyOf(b, w, h);
  let c = standIns.get(key);
  if (!c) {
    c = toCanvas(renderBackdropField(b, w, h), w, h);
    if (standIns.size > 16) standIns.clear();
    standIns.set(key, c);
  }
  return c;
}

/**
 * Two workers: "main" renders the backdrop the preview / export draws, "thumb" the picker thumbnails,
 * so 50 thumbnails queued when the Background picker opens never delay the frame's own backdrop.
 */
type Lane = "main" | "thumb";
const workers: Record<Lane, Worker | null> = { main: null, thumb: null };
const owned: Record<Lane, Set<number>> = { main: new Set(), thumb: new Set() };
let jobs = 0;
const waiting = new Map<number, (px: Uint8ClampedArray | null) => void>();
function settle(id: number, px: Uint8ClampedArray | null): void {
  waiting.get(id)?.(px);
  waiting.delete(id);
}
function renderInWorker(b: Backdrop, W: number, H: number, lane: Lane = "main"): Promise<Uint8ClampedArray | null> {
  try {
    let worker = workers[lane];
    if (!worker) {
      worker = new Worker(new URL("./backdropWorker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (e: MessageEvent<{ id: number; px: Uint8ClampedArray | null }>) => {
        owned[lane].delete(e.data.id);
        settle(e.data.id, e.data.px);
      };
      worker.onerror = () => {
        for (const id of owned[lane]) settle(id, null);
        owned[lane].clear();
        workers[lane] = null;
      };
      workers[lane] = worker;
    }
    const id = ++jobs;
    owned[lane].add(id);
    const w = worker;
    return new Promise((res) => {
      waiting.set(id, res);
      w.postMessage({ id, b, W, H });
    });
  } catch {
    return Promise.resolve(null);
  }
}

/**
 * Make sure the field backdrop is rendered at W x H (no-op for the classic twelve). Resolves true
 * when it was not ready before (the caller redraws).
 */
export function prepareBackdrop(b: Backdrop, W: number, H: number): Promise<boolean> {
  if (!isFieldStyle(b.style)) return Promise.resolve(false);
  W = Math.max(1, Math.round(W));
  H = Math.max(1, Math.round(H));
  const key = keyOf(b, W, H);
  if (fields.has(key)) return Promise.resolve(false);
  if (!onUiThread() || W * H <= UI_SYNC_MAX_PX) {
    fieldNow(b, W, H);
    return Promise.resolve(true);
  }
  let p = pending.get(key);
  if (!p) {
    p = renderInWorker(b, W, H).then((px) => {
      pending.delete(key);
      // no worker (or it failed): render here rather than never
      remember(key, px ? toCanvas(px, W, H) : toCanvas(renderBackdropField(b, W, H), W, H));
      return true;
    });
    pending.set(key, p);
  }
  return p;
}

/** Field backdrops still rendering off-thread (test hook: window.__lens.state().backdropsPending). */
export function pendingBackdrops(): number {
  return pending.size;
}

/** True when the field backdrop at W x H is rendered (classic backdrops always are). */
export function backdropReady(b: Backdrop, W: number, H: number): boolean {
  return !isFieldStyle(b.style) || fields.has(keyOf(b, Math.max(1, Math.round(W)), Math.max(1, Math.round(H))));
}

function drawField(g: G, b: Backdrop, W: number, H: number): boolean {
  const w = Math.max(1, Math.round(W));
  const h = Math.max(1, Math.round(H));
  const key = keyOf(b, w, h);
  const hit = fields.get(key);
  if (hit || !onUiThread() || w * h <= UI_SYNC_MAX_PX) {
    g.drawImage(hit ?? fieldNow(b, w, h), 0, 0);
    return true;
  }
  void prepareBackdrop(b, w, h);
  const lo = standIn(b, w, h);
  g.save();
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(lo, 0, 0, w, h);
  g.restore();
  return false;
}

// ---- picker thumbnails ------------------------------------------------------------------------------

const thumbs = new Map<string, AnyCanvas>();
/** The picker thumbnail of a backdrop at w x h, rendered once per session. */
export function backdropThumb(b: Backdrop, w: number, h: number): AnyCanvas {
  const key = `${b.id}|${w}x${h}`;
  let c = thumbs.get(key);
  if (!c) {
    c = makeCanvas(w, h);
    const g = c.getContext("2d") as G;
    if (isFieldStyle(b.style)) g.putImageData(new ImageData(renderBackdropField(b, w, h) as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
    else drawClassic(g, b, w, h);
    thumbs.set(key, c);
  }
  return c;
}
const thumbPending = new Map<string, Promise<AnyCanvas>>();
/**
 * The picker thumbnail, a field style rendered in the thumbnail worker (v0.1.4 speed pass: 51 field
 * thumbnails were ~0.1-0.4 s of per-pixel math on the UI thread, 0.85 s of main-thread time while an
 * editor with an image backdrop opened). Same function, same size: the same pixels as backdropThumb.
 */
export function backdropThumbAsync(b: Backdrop, w: number, h: number): Promise<AnyCanvas> {
  const key = `${b.id}|${w}x${h}`;
  const hit = thumbs.get(key);
  if (hit) return Promise.resolve(hit);
  if (!isFieldStyle(b.style) || !onUiThread()) return Promise.resolve(backdropThumb(b, w, h));
  let p = thumbPending.get(key);
  if (!p) {
    p = renderInWorker(b, w, h, "thumb").then((px) => {
      thumbPending.delete(key);
      if (!px) return backdropThumb(b, w, h); // no worker: render here rather than never
      const c = toCanvas(px, w, h);
      thumbs.set(key, c);
      return c;
    });
    thumbPending.set(key, p);
  }
  return p;
}
export function thumbCached(id: string, w: number, h: number): boolean {
  return thumbs.has(`${id}|${w}x${h}`);
}

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** CSS for picker swatches of a gradient. */
export function gradientCss(colors: string[], angle: number, stops?: number[]): string {
  if (colors.length < 2) return colors[0] ?? "#000";
  return `linear-gradient(${angle}deg, ${gradientStops(colors, stops).map(([at, c]) => `${c} ${Math.round(at * 1000) / 10}%`).join(", ")})`;
}

/**
 * Gradient stops as [position, colour] sorted by position (Windows bug #20: stops are placed freely).
 * Positions from background.stops when it gives one in 0..1 per colour, else evenly spaced. Same rule
 * as render.py's make_background.
 */
export function gradientStops(colors: string[], stops?: number[]): Array<[number, string]> {
  const ok = !!stops && stops.length === colors.length && stops.every((v) => Number.isFinite(v) && v >= 0 && v <= 1);
  return colors
    .map((c, i): [number, string] => [ok ? stops![i]! : colors.length > 1 ? i / (colors.length - 1) : 0, c])
    .sort((a, b) => a[0] - b[0]);
}
