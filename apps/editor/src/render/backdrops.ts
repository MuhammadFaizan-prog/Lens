/**
 * Lens's own backdrop art (Windows bug #20): twelve procedural abstract images, drawn on demand from a
 * seed and a palette, so they ship as code (no image files, nothing downloaded, works offline) and the
 * preview, the export worker and the picker thumbnails draw exactly the same picture at any size.
 * Original designs; no third-party wallpapers or assets. The table lives in the engine (backdropArt.ts).
 */
import { BUILTIN_BACKDROPS, backdropById, type Backdrop } from "@lens/engine";

export { BUILTIN_BACKDROPS, backdropById, type Backdrop };

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

/** Draw a built-in backdrop filling W x H (resolution independent: positions and sizes are fractions). */
export function drawBackdrop(g: G, b: Backdrop, W: number, H: number): void {
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
