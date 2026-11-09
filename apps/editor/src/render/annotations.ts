/**
 * Annotations and text slides on Canvas2D: a port of compositor/lens_compositor/annotations.py.
 *
 * The engine tessellates every item into ops (fill polygon, stroked polyline, text box); this file
 * maps the points (through the camera for screen-anchored items), draws each item into its own
 * layer and composites the layer with the item's drop shadow (canvas shadowBlur = 2 sigma, the same
 * Gaussian as the reference) and opacity. Text layout matches the reference: greedy word wrap on
 * advance widths without kerning, line height trunc((ascent + descent) * 1.15), DejaVu Sans / Bold.
 */
import type { AnnOp } from "@lens/engine";
import { makeCanvas, type AnyCanvas } from "./canvas";
import { fontCss, imageAt } from "./assets";

type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export interface DrawableItem {
  ops: AnnOp[];
  opacity: number;
  shadow: [number, number, number, number] | null;
}

export const TEXT_FONT_STACK = `LensCaption, "DejaVu Sans", "Inter", system-ui, sans-serif`;

/** Python's round(): banker's rounding at .5. */
function pyRound(v: number): number {
  const f = Math.floor(v);
  const d = v - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

function rgba(hex: string, a: number): string {
  const s = hex.replace("#", "");
  return `rgba(${parseInt(s.slice(0, 2), 16)},${parseInt(s.slice(2, 4), 16)},${parseInt(s.slice(4, 6), 16)},${a})`;
}

export interface TextLayout {
  size: number;
  font: string;
  lines: string[];
  widths: number[];
  asc: number;
  lh: number;
  top: number;
  xs: number[];
  box: [number, number, number, number];
}

/** Lay out a text op at output scale k with its box at (x, y) in output px (render.py text_geometry). */
export function layoutText(g: Canvas2D, op: Extract<AnnOp, { op: "text" }>, x: number, y: number, k: number): TextLayout {
  const size = Math.max(6, pyRound(op.size * k));
  const font = `${op.bold ? "bold " : ""}${size}px ${fontCss(op.font, TEXT_FONT_STACK)}`;
  g.font = font;
  (g as unknown as { fontKerning: string }).fontKerning = "none";
  const wbox = op.w * k;
  const lines: string[] = [];
  for (const para of op.text.split("\n")) {
    const words = para.split(" ");
    let cur = words[0]!;
    for (const w of words.slice(1)) {
      const cand = `${cur} ${w}`;
      if (wbox > 0 && g.measureText(cand).width > wbox && cur) {
        lines.push(cur);
        cur = w;
      } else cur = cand;
    }
    lines.push(cur);
  }
  const widths = lines.map((s) => g.measureText(s).width);
  const fm = g.measureText("Hg");
  const asc = Math.ceil(fm.fontBoundingBoxAscent);
  const desc = Math.ceil(fm.fontBoundingBoxDescent);
  const lh = Math.trunc((asc + desc) * 1.15);
  const blockH = lh * lines.length;
  const hbox = op.h * k;
  const top = op.valign === "middle" ? (hbox > 0 ? y + (hbox - blockH) / 2 : y - blockH / 2) : y;
  const xs = widths.map((lw) =>
    wbox > 0
      ? op.align === "left" ? x : op.align === "center" ? x + wbox / 2 - lw / 2 : x + wbox - lw
      : op.align === "left" ? x : op.align === "center" ? x - lw / 2 : x - lw,
  );
  const maxw = widths.length ? Math.max(...widths) : 0;
  return { size, font, lines, widths, asc, lh, top, xs, box: [xs.length ? Math.min(...xs) : x, top, maxw, blockH] };
}

let layerCanvas: AnyCanvas | null = null;
function layerOf(w: number, h: number): AnyCanvas {
  if (!layerCanvas || layerCanvas.width < w || layerCanvas.height < h) layerCanvas = makeCanvas(Math.max(w, layerCanvas?.width ?? 0), Math.max(h, layerCanvas?.height ?? 0));
  return layerCanvas;
}

function ctx(c: AnyCanvas): Canvas2D {
  return c.getContext("2d") as Canvas2D;
}

/**
 * Draw items onto g (W x H). toPx maps item coordinates to g px; k scales widths and sizes.
 * Screen-anchored items are drawn into the view canvas, frame-anchored and slides into the output.
 */
export function drawItems(g: Canvas2D, W: number, H: number, items: DrawableItem[], toPx: (x: number, y: number) => [number, number], k: number, opacityMul = 1,
  extra: { background?: CanvasImageSource | null } = {}): void {
  for (const it of items) {
    if (!it.ops.length) continue;
    const layer = layerOf(W, H);
    const lg = ctx(layer);
    lg.save();
    lg.setTransform(1, 0, 0, 1, 0, 0);
    lg.globalAlpha = 1;
    lg.globalCompositeOperation = "source-over";
    lg.clearRect(0, 0, W, H);
    lg.lineCap = "round";
    lg.lineJoin = "round";
    for (const o of it.ops) {
      if (o.op === "background") {
        if (extra.background) lg.drawImage(extra.background, 0, 0);
        continue;
      }
      if (o.op === "image") {
        const [ix, iy] = toPx(o.x, o.y);
        const w = Math.max(1, Math.round(o.w * k));
        const h = Math.max(1, Math.round(o.h * k));
        const im = imageAt(o.path, w, h);
        if (im) {
          lg.globalAlpha = o.alpha;
          lg.drawImage(im as CanvasImageSource, Math.round(ix), Math.round(iy));
          lg.globalAlpha = 1;
        }
        continue;
      }
      if (o.op === "fill" || o.op === "stroke") {
        const n = o.pts.length / 2;
        lg.beginPath();
        for (let i = 0; i < n; i++) {
          const [x, y] = toPx(o.pts[2 * i]!, o.pts[2 * i + 1]!);
          if (i === 0) lg.moveTo(x, y);
          else lg.lineTo(x, y);
        }
        if (o.op === "fill") {
          lg.closePath();
          lg.fillStyle = rgba(o.color, o.alpha);
          lg.fill();
        } else {
          const w = o.width * k;
          if (n === 1) {
            const [x, y] = toPx(o.pts[0]!, o.pts[1]!);
            lg.beginPath();
            lg.arc(x, y, w / 2, 0, Math.PI * 2);
            lg.fillStyle = rgba(o.color, o.alpha);
            lg.fill();
          } else {
            if (o.closed) lg.closePath();
            lg.lineWidth = w;
            lg.strokeStyle = rgba(o.color, o.alpha);
            lg.stroke();
          }
        }
      } else {
        const [tx, ty] = toPx(o.x, o.y);
        const L = layoutText(lg, o, tx, ty, k);
        if (o.bg) {
          const [bx, by, bw, bh] = L.box;
          const px = o.bg.padX * k;
          const py = o.bg.padY * k;
          const w = bw + 2 * px;
          const h = bh + 2 * py;
          lg.beginPath();
          lg.roundRect(bx - px, by - py, w, h, Math.max(0, Math.min(o.bg.radius * k, w / 2, h / 2)));
          lg.fillStyle = rgba(o.bg.color, o.bg.alpha);
          lg.fill();
        }
        lg.font = L.font;
        lg.textBaseline = "alphabetic";
        lg.fillStyle = o.color;
        let left = o.chars;
        for (let li = 0; li < L.lines.length; li++) {
          let s = L.lines[li]!;
          if (o.chars >= 0) {
            if (left <= 0) break;
            s = s.slice(0, left);
            left -= L.lines[li]!.length + 1;
          }
          if (s) lg.fillText(s, L.xs[li]!, L.top + li * L.lh + L.asc);
        }
      }
    }
    lg.restore();
    const op = it.opacity * opacityMul;
    g.save();
    g.globalAlpha = op;
    if (it.shadow) {
      const [so, blur, dx, dy] = it.shadow;
      g.shadowColor = `rgba(0,0,0,${so})`;
      g.shadowBlur = blur * k;
      g.shadowOffsetX = pyRound(dx * k);
      g.shadowOffsetY = pyRound(dy * k);
    }
    g.drawImage(layer as CanvasImageSource, 0, 0, W, H, 0, 0, W, H);
    g.restore();
  }
}
