/**
 * Canvas2D live renderer: draws one frame of an engine RenderPlan.
 *
 * This is a port of compositor/lens_compositor/render.py (the reference) to Canvas2D, pass for pass,
 * so the preview matches the export:
 *
 *   background -> shadow -> screen (crop, camera transform, motion blur) -> masks -> click effects
 *   -> screen-anchored annotations -> cursor (motion blur) -> rounded mask -> webcam (crop, mirror)
 *   -> frame-anchored annotations -> shortcut pill -> caption -> text slide
 *
 * Every motion decision comes from the plan; this file only draws. Known, intentional differences
 * from the reference are listed in docs/Editor.md ("Preview vs export").
 */
import type { PlanFrame, RenderPlan } from "@lens/engine";
import { makeCanvas, type AnyCanvas } from "./canvas";
import { cursorSprite } from "./cursorSprite";
import { drawItems } from "./annotations";
import { fontCss, imageAt } from "./assets";

export { makeCanvas };
type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export interface FrameImages {
  screen: CanvasImageSource | null;
  cam?: CanvasImageSource | null;
}

export const CAPTION_FONT = "LensCaption";
const FONT_STACK = `${CAPTION_FONT}, "DejaVu Sans", "Inter", system-ui, sans-serif`;

/** Python's round(): banker's rounding at .5, used where the reference does int(round(v)). */
export function pyRound(v: number): number {
  const f = Math.floor(v);
  const d = v - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

function ctx2d(c: AnyCanvas): Canvas2D {
  const g = c.getContext("2d", { willReadFrequently: false }) as Canvas2D | null;
  if (!g) throw new Error("no 2d context");
  return g;
}

function hexRgb(h: string): [number, number, number] {
  const s = h.replace("#", "");
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

function roundRectPath(g: Canvas2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  g.beginPath();
  g.roundRect(x, y, w, h, rr);
}

/** Separable soft-rect alpha (render.py _soft_rect_alpha): linear feather centred on the border. */
function softRectAlpha(w: number, h: number, x0: number, y0: number, x1: number, y1: number, feather: number, scale: number): ImageData {
  const f = Math.max(1, feather);
  const ax = new Float32Array(w);
  const ay = new Float32Array(h);
  const cl = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  for (let i = 0; i < w; i++) {
    const x = i + 0.5;
    ax[i] = cl((x - x0) / f + 0.5) * cl((x1 - x) / f + 0.5);
  }
  for (let j = 0; j < h; j++) {
    const y = j + 0.5;
    ay[j] = cl((y - y0) / f + 0.5) * cl((y1 - y) / f + 0.5);
  }
  const img = new ImageData(w, h);
  const d = img.data;
  for (let j = 0; j < h; j++) {
    const a = ay[j]! * scale;
    for (let i = 0; i < w; i++) {
      const o = (j * w + i) * 4;
      d[o + 3] = Math.round(255 * a * ax[i]!);
    }
  }
  return img;
}

interface ViewMap {
  x0: number;
  y0: number;
  k: number;
  ky: number;
}

export class PlanRenderer {
  private bgKey = "";
  private bg: AnyCanvas | null = null;
  private shadowKey = "";
  private shadow: AnyCanvas | null = null;
  private view: AnyCanvas | null = null;
  private tmp: AnyCanvas | null = null;

  /** Draw output frame `index` of `plan` into g (sized plan.output.width x height). */
  draw(g: Canvas2D, plan: RenderPlan, index: number, imgs: FrameImages): void {
    const f = plan.frames[Math.max(0, Math.min(plan.frames.length - 1, index))];
    if (!f) return;
    const prev = index > 0 ? plan.frames[index - 1] ?? null : null;
    const { width: W, height: H } = plan.output;
    const style = plan.style;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";

    // 1. background
    g.drawImage(this.background(plan) as CanvasImageSource, 0, 0);

    // 2. shadow (cached per rect, like render.py shadow_layer)
    const [sx, sy, sw0, sh0] = f.layout.screen.map(pyRound) as [number, number, number, number];
    const sw = Math.max(2, sw0);
    const sh = Math.max(2, sh0);
    const shadow = style.shadow;
    if (f.layout.screenOpacity > 0 && shadow.opacity > 0) {
      g.drawImage(this.shadowLayer(W, H, sx, sy, sw, sh, style.radius, shadow, shadow.opacity * f.layout.screenOpacity) as CanvasImageSource, 0, 0);
    }

    // 3. screen through the virtual camera
    const view = this.viewCanvas(sw, sh);
    const vg = ctx2d(view);
    vg.setTransform(1, 0, 0, 1, 0, 0);
    vg.globalAlpha = 1;
    vg.globalCompositeOperation = "source-over";
    vg.clearRect(0, 0, sw, sh);
    vg.imageSmoothingEnabled = true;
    vg.imageSmoothingQuality = "high";
    const map = this.drawScreen(vg, plan, f, imgs.screen, sw, sh);

    // 4. masks
    if (f.masks.length) this.drawMasks(vg, view, f, map, sw, sh);

    // 5. click effects
    if (style.clickEffect !== "none") {
      for (const [px, py, p] of f.clicks) {
        const rx = (px - map.x0) * map.k;
        const ry = (py - map.y0) * map.ky;
        const ease = 1 - (1 - p) ** 3;
        const radius = Math.trunc((8 + 34 * ease) * map.k * 0.75);
        const alpha = 0.55 * (1 - p);
        vg.save();
        vg.globalAlpha = alpha;
        const cx = Math.trunc(rx) + 0.5;
        const cy = Math.trunc(ry) + 0.5;
        vg.beginPath();
        if (style.clickEffect === "ripple") {
          vg.arc(cx, cy, radius, 0, Math.PI * 2);
          vg.lineWidth = Math.max(2, Math.trunc(3 * map.k));
          vg.strokeStyle = "#ffffff";
          vg.stroke();
        } else if (style.clickEffect === "circle") {
          vg.arc(cx, cy, radius, 0, Math.PI * 2);
          vg.fillStyle = "#ffffff";
          vg.fill();
        } else {
          vg.arc(cx, cy, Math.trunc(radius * 1.2), 0, Math.PI * 2);
          vg.fillStyle = "rgb(255,220,60)";
          vg.fill();
        }
        vg.restore();
      }
    }

    // 5b. screen-anchored annotations (through the camera, under the cursor)
    const annotations = f.annotations ?? [];
    const scr = annotations.filter((a) => a.space === "screen");
    if (scr.length) drawItems(vg, sw, sh, scr, (x, y) => [(x - map.x0) * map.k, (y - map.y0) * map.ky], map.k);

    // 6. cursor
    if (f.cur) this.drawCursor(vg, plan, f, prev, map);

    // 7. rounded composite
    g.save();
    g.globalAlpha = f.layout.screenOpacity;
    roundRectPath(g, sx, sy, sw, sh, style.radius);
    g.clip();
    g.drawImage(view as CanvasImageSource, sx, sy);
    g.restore();

    // 8. webcam
    if (imgs.cam && f.layout.camera && f.layout.cameraOpacity > 0) this.drawWebcam(g, plan, f, imgs.cam);

    // 8b. frame-anchored annotations
    const frm = annotations.filter((a) => a.space === "frame");
    if (frm.length) drawItems(g, W, H, frm, (x, y) => [x, y], 1);

    // 9. shortcut pill + caption
    if (f.shortcut) this.drawShortcut(g, f.shortcut, W, H);
    if (f.caption) this.drawCaption(g, plan, f, W, H);

    // 9b. brand watermark above the caption (slides cover it)
    const wm = plan.watermark;
    if (wm) {
      const im = imageAt(wm.path, wm.w, wm.h);
      if (im) {
        g.save();
        g.globalAlpha = wm.opacity;
        g.drawImage(im as CanvasImageSource, wm.x, wm.y);
        g.restore();
      }
    }

    // 10. text slide over everything
    if (f.slide) drawItems(g, W, H, [{ ops: f.slide.ops, opacity: f.slide.opacity, shadow: null }], (x, y) => [x, y], 1, 1, { background: this.background(plan) as CanvasImageSource });
    g.restore();
  }

  private background(plan: RenderPlan): AnyCanvas {
    const { width: W, height: H } = plan.output;
    const bg = plan.style.background;
    const key = JSON.stringify([bg, W, H]);
    if (this.bg && key === this.bgKey) return this.bg;
    const c = makeCanvas(W, H);
    const g = ctx2d(c);
    const colors = bg.colors.length ? bg.colors : ["#202020"];
    if (bg.kind === "gradient" && colors.length >= 2) {
      const ang = ((bg.angle ?? 135) * Math.PI) / 180;
      const dx = Math.sin(ang);
      const dy = -Math.cos(ang);
      const span = Math.abs((W / 2) * dx) + Math.abs((H / 2) * dy);
      // render.py: u = (proj / span + 1) / 2 with proj measured from the centre along (dx, dy)
      const gr = g.createLinearGradient(W / 2 - dx * span, H / 2 - dy * span, W / 2 + dx * span, H / 2 + dy * span);
      colors.forEach((col, i) => gr.addColorStop(i / (colors.length - 1), col));
      g.fillStyle = gr;
    } else {
      g.fillStyle = colors[0]!;
    }
    if (bg.blur > 0) g.filter = `blur(${bg.blur}px)`;
    g.fillRect(-4 * (bg.blur || 0), -4 * (bg.blur || 0), W + 8 * (bg.blur || 0), H + 8 * (bg.blur || 0));
    g.filter = "none";
    this.bg = c;
    this.bgKey = key;
    return c;
  }

  private shadowLayer(W: number, H: number, x: number, y: number, w: number, h: number, radius: number, s: RenderPlan["style"]["shadow"], opacity: number): AnyCanvas {
    const key = JSON.stringify([W, H, x, y, w, h, radius, s, opacity]);
    if (this.shadow && key === this.shadowKey) return this.shadow;
    const c = this.shadow && this.shadow.width === W && this.shadow.height === H ? this.shadow : makeCanvas(W, H);
    const g = ctx2d(c);
    g.clearRect(0, 0, W, H);
    const ox = s.offsetY * Math.cos((s.angle * Math.PI) / 180);
    const oy = s.offsetY * Math.sin((s.angle * Math.PI) / 180);
    // Draw the shape far off-canvas and let only its shadow land: canvas shadowBlur is a Gaussian
    // with sigma = shadowBlur / 2, the same as render.py's GaussianBlur(sigma = blur / 2).
    const FAR = W + H + 1000;
    g.save();
    g.shadowColor = `rgba(0,0,0,${opacity})`;
    g.shadowBlur = s.blur;
    g.shadowOffsetX = pyRound(ox) + FAR;
    g.shadowOffsetY = pyRound(oy);
    g.fillStyle = "#000";
    roundRectPath(g, x - FAR, y, w, h, radius);
    g.fill();
    g.restore();
    this.shadow = c;
    this.shadowKey = key;
    return c;
  }

  private viewCanvas(w: number, h: number): AnyCanvas {
    if (!this.view || this.view.width !== w || this.view.height !== h) this.view = makeCanvas(w, h);
    return this.view;
  }

  private tmpCanvas(w: number, h: number): AnyCanvas {
    if (!this.tmp || this.tmp.width < w || this.tmp.height < h) this.tmp = makeCanvas(Math.max(w, this.tmp?.width ?? 0), Math.max(h, this.tmp?.height ?? 0));
    return this.tmp;
  }

  private drawScreen(vg: Canvas2D, plan: RenderPlan, f: PlanFrame, img: CanvasImageSource | null, sw: number, sh: number): ViewMap {
    const [cropX, cropY, srcW, srcH] = plan.source.crop;
    const [cx, cy, s] = f.cam;
    const vw = srcW / s;
    const vh = srcH / s;
    const x0 = cx - vw / 2;
    const y0 = cy - vh / 2;
    const k = sw / vw;
    const ky = sh / vh;
    const fps = plan.output.fps;
    const mb = plan.style.motionBlur;
    const [vx, vy, vs] = f.camVel;
    const speedOut = (Math.hypot(vx, vy) * k) / fps + (Math.abs(vs) * sw) / fps;
    const blit = (c: [number, number, number], alpha: number) => {
      if (!img) return;
      const w = srcW / c[2];
      const h = srcH / c[2];
      const kk = sw / w;
      const kky = sh / h;
      // OpenCV maps pixel centres (dst j <- src j/k + x0); canvas maps pixel edges. Shift by
      // 0.5 - 0.5/k so both sample the same source position.
      const ax = c[0] - w / 2 + 0.5 - 0.5 / kk + cropX;
      const ay = c[1] - h / 2 + 0.5 - 0.5 / kky + cropY;
      vg.globalAlpha = alpha;
      vg.drawImage(img, ax, ay, w, h, 0, 0, sw, sh);
    };
    if (mb.enabled && speedOut > 1.5) {
      const n = Math.max(2, Math.trunc(mb.samples));
      const shutter = (mb.strength * (1000 / fps)) / 1000;
      for (let j = 0; j < n; j++) {
        const dt = (j / (n - 1) - 0.5) * shutter;
        // running average: sample j blended at 1/(j+1) equals the mean of all samples
        blit([cx + vx * dt, cy + vy * dt, Math.max(1, s + vs * dt)], 1 / (j + 1));
      }
      vg.globalAlpha = 1;
    } else {
      blit([cx, cy, s], 1);
    }
    vg.globalAlpha = 1;
    return { x0, y0, k, ky };
  }

  private drawMasks(vg: Canvas2D, view: AnyCanvas, f: PlanFrame, map: ViewMap, vw: number, vh: number): void {
    let spotDim = 0;
    const spots: Array<{ x0: number; y0: number; x1: number; y1: number; fe: number; op: number }> = [];
    for (const m of f.masks) {
      const [x, y, w, h] = m.rect;
      const rx0 = (x - map.x0) * map.k;
      const ry0 = (y - map.y0) * map.ky;
      const rx1 = (x + w - map.x0) * map.k;
      const ry1 = (y + h - map.y0) * map.ky;
      const fe = m.feather * map.k;
      const op = m.opacity;
      if (m.kind === "spotlight") {
        spots.push({ x0: rx0, y0: ry0, x1: rx1, y1: ry1, fe, op });
        spotDim = Math.max(spotDim, m.strength * op);
        continue;
      }
      const pad = Math.ceil(fe + 2);
      const bx0 = Math.max(0, Math.floor(rx0) - pad);
      const by0 = Math.max(0, Math.floor(ry0) - pad);
      const bx1 = Math.min(vw, Math.ceil(rx1) + pad);
      const by1 = Math.min(vh, Math.ceil(ry1) + pad);
      const bw = bx1 - bx0;
      const bh = by1 - by0;
      if (bw < 2 || bh < 2) continue;
      const eff = makeCanvas(bw, bh);
      const eg = ctx2d(eff);
      if (m.kind === "blur") {
        const sigma = Math.max(0.5, m.strength * map.k);
        const mg = Math.ceil(sigma * 3);
        // blur a margin around the region; outside the view, replicate the edge (OpenCV pads too)
        const ex0 = bx0 - mg;
        const ey0 = by0 - mg;
        const ew = bw + 2 * mg;
        const eh = bh + 2 * mg;
        const src = makeCanvas(ew, eh);
        const sg = ctx2d(src);
        drawClampedRegion(sg, view, ex0, ey0, ew, eh, vw, vh);
        eg.filter = `blur(${sigma}px)`;
        eg.drawImage(src as CanvasImageSource, -mg, -mg);
        eg.filter = "none";
      } else {
        pixelateInto(eg, ctx2d(view), map, rx0, ry0, bx0, by0, bx1, by1, vw, vh, Math.max(2, pyRound(m.strength * map.k)));
      }
      // keep the effect only where the feathered rect is (alpha = soft rect * opacity)
      const alpha = makeCanvas(bw, bh);
      ctx2d(alpha).putImageData(softRectAlpha(bw, bh, rx0 - bx0, ry0 - by0, rx1 - bx0, ry1 - by0, fe, op), 0, 0);
      eg.globalCompositeOperation = "destination-in";
      eg.drawImage(alpha as CanvasImageSource, 0, 0);
      eg.globalCompositeOperation = "source-over";
      vg.drawImage(eff as CanvasImageSource, bx0, by0);
    }
    if (spotDim > 0) {
      // out = view * (1 - dim * (1 - spot)): a black layer at alpha dim with the spot punched out
      const layer = this.tmpCanvas(vw, vh);
      const lg = ctx2d(layer);
      lg.save();
      lg.clearRect(0, 0, layer.width, layer.height);
      lg.fillStyle = `rgba(0,0,0,${spotDim})`;
      lg.fillRect(0, 0, vw, vh);
      lg.globalCompositeOperation = "destination-out";
      for (const s of spots) {
        const pad = Math.ceil(s.fe + 2);
        const bx0 = Math.max(0, Math.floor(s.x0) - pad);
        const by0 = Math.max(0, Math.floor(s.y0) - pad);
        const bx1 = Math.min(vw, Math.ceil(s.x1) + pad);
        const by1 = Math.min(vh, Math.ceil(s.y1) + pad);
        if (bx1 - bx0 < 1 || by1 - by0 < 1) continue;
        const a = makeCanvas(bx1 - bx0, by1 - by0);
        ctx2d(a).putImageData(softRectAlpha(bx1 - bx0, by1 - by0, s.x0 - bx0, s.y0 - by0, s.x1 - bx0, s.y1 - by0, s.fe, s.op), 0, 0);
        lg.drawImage(a as CanvasImageSource, bx0, by0);
      }
      lg.restore();
      vg.drawImage(layer as CanvasImageSource, 0, 0, vw, vh, 0, 0, vw, vh);
    }
  }

  private drawCursor(vg: Canvas2D, plan: RenderPlan, f: PlanFrame, prev: PlanFrame | null, map: ViewMap): void {
    const style = plan.style;
    const [px, py, op, sc, shape] = f.cur!;
    const shapeName = style.cursorShape === "system" ? shape : style.cursorShape;
    const base = 26 * style.cursorSize * (plan.source.pixelRatio || 1);
    const size = Math.max(6, pyRound(base * map.k * sc));
    const spr = cursorSprite(shapeName);
    const hx = spr.hot[0] * size;
    const hy = spr.hot[1] * size;
    const rx = (px - map.x0) * map.k;
    const ry = (py - map.y0) * map.ky;
    const mb = style.motionBlur;
    const put = (x: number, y: number, a: number) => {
      vg.globalAlpha = a;
      vg.drawImage(spr.canvas as CanvasImageSource, x, y, size, size);
    };
    let prevPt: [number, number] | null = null;
    if (mb.enabled && prev && prev.cur) {
      const pm = viewMapOf(plan, prev);
      prevPt = [(prev.cur[0] - pm.x0) * pm.k, (prev.cur[1] - pm.y0) * pm.ky];
    }
    if (prevPt) {
      const pdx = rx - prevPt[0];
      const pdy = ry - prevPt[1];
      const dist = Math.hypot(pdx, pdy);
      if (dist > 3) {
        const n = Math.min(Math.trunc(mb.samples), Math.max(2, Math.trunc(dist / 3)));
        for (let j = 0; j < n; j++) {
          const u = (j + 1) / n;
          const tx = prevPt[0] + pdx * (1 - mb.strength) + pdx * mb.strength * u;
          const ty = prevPt[1] + pdy * (1 - mb.strength) + pdy * mb.strength * u;
          put(tx - hx, ty - hy, op / n);
        }
      } else put(rx - hx, ry - hy, op);
    } else put(rx - hx, ry - hy, op);
    vg.globalAlpha = 1;
  }

  private drawWebcam(g: Canvas2D, plan: RenderPlan, f: PlanFrame, img: CanvasImageSource): void {
    const [cxr, cyr, cwr, chr] = f.layout.camera!.map(pyRound) as [number, number, number, number];
    if (cwr <= 2 || chr <= 2) return;
    const iw = (img as { width: number }).width;
    const ih = (img as { height: number }).height;
    let qx = 0;
    let qy = 0;
    let cw0 = iw;
    let ch0 = ih;
    const crop = plan.style.cameraCrop;
    if (crop) {
      const [x, y, w, h] = crop.map(pyRound) as [number, number, number, number];
      qx = Math.max(0, Math.min(iw - 2, x));
      qy = Math.max(0, Math.min(ih - 2, y));
      cw0 = Math.min(iw, qx + w) - qx;
      ch0 = Math.min(ih, qy + h) - qy;
    }
    const sc = Math.max(cwr / cw0, chr / ch0);
    const rsW = Math.ceil(cw0 * sc);
    const rsH = Math.ceil(ch0 * sc);
    const ox = Math.floor((rsW - cwr) / 2);
    const oy = Math.floor((rsH - chr) / 2);
    const shape = plan.style.cameraShape;
    const rad = shape === "circle" ? Math.min(cwr, chr) / 2 : shape === "square" ? 0 : Math.min(cwr, chr) * 0.12;
    g.save();
    g.globalAlpha = f.layout.cameraOpacity;
    roundRectPath(g, cxr, cyr, cwr, chr, rad);
    g.clip();
    const sw = cwr / sc;
    const shh = chr / sc;
    if (plan.style.cameraMirror) {
      g.translate(cxr + cwr, cyr);
      g.scale(-1, 1);
      g.drawImage(img, qx + (cw0 - ox / sc - sw), qy + oy / sc, sw, shh, 0, 0, cwr, chr);
    } else {
      g.drawImage(img, qx + ox / sc, qy + oy / sc, sw, shh, cxr, cyr, cwr, chr);
    }
    g.restore();
  }

  private drawShortcut(g: Canvas2D, text: string, W: number, H: number): void {
    const size = Math.max(14, Math.trunc(H * 0.032));
    g.save();
    g.font = `bold ${size}px ${FONT_STACK}`;
    setNoKerning(g);
    g.textBaseline = "alphabetic";
    const m = g.measureText(text);
    const asc = Math.ceil(m.fontBoundingBoxAscent);
    const tb0 = -m.actualBoundingBoxLeft;
    const tb1 = asc - m.actualBoundingBoxAscent;
    const tw = Math.round(m.actualBoundingBoxRight + m.actualBoundingBoxLeft);
    const th = Math.round(m.actualBoundingBoxAscent + m.actualBoundingBoxDescent);
    const padx = Math.trunc(th * 0.9);
    const pady = Math.trunc(th * 0.6);
    const bx = Math.floor((W - tw) / 2) - padx;
    const by = Math.trunc(H * 0.86) - th - pady;
    g.fillStyle = "rgba(15,15,18,0.843)";
    roundRectPath(g, bx, by, tw + 2 * padx + 1, th + 2 * pady + 1, Math.trunc(th * 0.7));
    g.fill();
    g.fillStyle = "#ffffff";
    g.fillText(text, bx + padx - tb0, by + pady - tb1 + asc);
    g.restore();
  }

  private drawCaption(g: Canvas2D, plan: RenderPlan, f: PlanFrame, W: number, H: number): void {
    const cap = f.caption!;
    const cs = plan.style.captions;
    const words = cap.words;
    if (!words.length) return;
    const size = Math.max(10, pyRound(cs.fontSize ?? H * 0.04));
    g.save();
    g.font = `bold ${size}px ${fontCss((cs as { font?: string }).font, FONT_STACK)}`;
    setNoKerning(g);
    g.textBaseline = "alphabetic";
    const space = g.measureText(" ").width;
    const lines: number[][] = [];
    let i = 0;
    for (const n of cap.lines) {
      lines.push(Array.from({ length: n }, (_, j) => i + j));
      i += n;
    }
    const widths = lines.map((ln) => ln.map((j) => g.measureText(words[j]!).width));
    const lineW = widths.map((ws) => ws.reduce((a, b) => a + b, 0) + space * (ws.length - 1));
    const fm = g.measureText("Hg");
    const asc = Math.ceil(fm.fontBoundingBoxAscent);
    const desc = Math.ceil(fm.fontBoundingBoxDescent);
    const lh = Math.trunc((asc + desc) * 1.12);
    const blockH = lh * lines.length;
    const pos = cs.position ?? "bottom";
    const top = pos === "top" ? Math.trunc(H * 0.07) : pos === "custom" ? Math.trunc((cs.y ?? 0.88) * H - blockH / 2) : Math.trunc(H * 0.93) - blockH;
    const padx = size * 0.55;
    const pady = size * 0.28;
    const bg = cs.background ?? { enabled: true, color: "#000000", opacity: 0.66 };
    if (bg.enabled !== false) {
      const bw = Math.max(...lineW);
      const x0 = (W - bw) / 2 - padx;
      const [r, gg, b] = hexRgb(bg.color ?? "#000000");
      g.fillStyle = `rgba(${r},${gg},${b},${Math.trunc(255 * (bg.opacity ?? 0.66)) / 255})`;
      roundRectPath(g, x0, top - pady, bw + 2 * padx + 1, blockH + 2 * pady + 1, Math.trunc(size * 0.45));
      g.fill();
    }
    const active = cs.wordHighlight !== false ? cap.active : -1;
    lines.forEach((ln, li) => {
      let x = (W - lineW[li]!) / 2;
      const y = top + li * lh;
      ln.forEach((j, n) => {
        g.fillStyle = j === active ? cs.highlightColor ?? "#ffd23f" : cs.textColor ?? "#ffffff";
        g.fillText(words[j]!, x, y + asc);
        x += widths[li]![n]! + space;
      });
    });
    g.restore();
  }
}

function setNoKerning(g: Canvas2D): void {
  // PIL (basic layout) does not kern; match it so word widths agree.
  (g as unknown as { fontKerning: string }).fontKerning = "none";
}

export function viewMapOf(plan: RenderPlan, f: PlanFrame): ViewMap {
  const [, , srcW, srcH] = plan.source.crop;
  const [cx, cy, s] = f.cam;
  const sw = Math.max(2, pyRound(f.layout.screen[2]));
  const sh = Math.max(2, pyRound(f.layout.screen[3]));
  const vw = srcW / s;
  const vh = srcH / s;
  return { x0: cx - vw / 2, y0: cy - vh / 2, k: sw / vw, ky: sh / vh };
}

/** Copy view[x0..x0+w, y0..y0+h] into g at (0,0), replicating edge pixels where it leaves the view. */
function drawClampedRegion(g: Canvas2D, view: AnyCanvas, x0: number, y0: number, w: number, h: number, vw: number, vh: number): void {
  const ix0 = Math.max(0, x0);
  const iy0 = Math.max(0, y0);
  const ix1 = Math.min(vw, x0 + w);
  const iy1 = Math.min(vh, y0 + h);
  if (ix1 <= ix0 || iy1 <= iy0) return;
  const v = view as CanvasImageSource;
  const dx = ix0 - x0;
  const dy = iy0 - y0;
  const iw = ix1 - ix0;
  const ih = iy1 - iy0;
  g.imageSmoothingEnabled = false;
  g.drawImage(v, ix0, iy0, iw, ih, dx, dy, iw, ih);
  // edges: stretch the outermost row / column into the margin
  if (dx > 0) g.drawImage(v, ix0, iy0, 1, ih, 0, dy, dx, ih);
  if (dx + iw < w) g.drawImage(v, ix1 - 1, iy0, 1, ih, dx + iw, dy, w - dx - iw, ih);
  if (dy > 0) g.drawImage(g.canvas as CanvasImageSource, 0, dy, w, 1, 0, 0, w, dy);
  if (dy + ih < h) g.drawImage(g.canvas as CanvasImageSource, 0, dy + ih - 1, w, 1, 0, dy + ih, w, h - dy - ih);
  g.imageSmoothingEnabled = true;
}

/** Pixelate (render.py): blocks of bi px anchored to the mask origin, block = mean of its pixels. */
function pixelateInto(eg: Canvas2D, vg: Canvas2D, _map: ViewMap, rx0: number, ry0: number, bx0: number, by0: number, bx1: number, by1: number, vw: number, vh: number, bi: number): void {
  const ox = Math.floor(rx0);
  const oy = Math.floor(ry0);
  const gx0 = Math.max(0, ox - Math.ceil((ox - bx0) / bi) * bi);
  const gy0 = Math.max(0, oy - Math.ceil((oy - by0) / bi) * bi);
  const gx1 = Math.min(vw, gx0 + Math.ceil((bx1 - gx0) / bi) * bi);
  const gy1 = Math.min(vh, gy0 + Math.ceil((by1 - gy0) / bi) * bi);
  const gw = gx1 - gx0;
  const gh = gy1 - gy0;
  if (gw < 1 || gh < 1) return;
  const src = vg.getImageData(gx0, gy0, gw, gh);
  const out = new ImageData(gw, gh);
  const d = src.data;
  const o = out.data;
  for (let by = 0; by < gh; by += bi) {
    for (let bx = 0; bx < gw; bx += bi) {
      const ex = Math.min(gw, bx + bi);
      const ey = Math.min(gh, by + bi);
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = by; y < ey; y++)
        for (let x = bx; x < ex; x++) {
          const p = (y * gw + x) * 4;
          r += d[p]!;
          g += d[p + 1]!;
          b += d[p + 2]!;
          n++;
        }
      r /= n;
      g /= n;
      b /= n;
      for (let y = by; y < ey; y++)
        for (let x = bx; x < ex; x++) {
          const p = (y * gw + x) * 4;
          o[p] = r;
          o[p + 1] = g;
          o[p + 2] = b;
          o[p + 3] = 255;
        }
    }
  }
  eg.putImageData(out, gx0 - bx0, gy0 - by0);
}
