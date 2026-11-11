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
 * 3D motion (plan frame m3d): the rounded card (step 7) is drawn through the WebGL2 perspective pass
 * (gl3d.ts) instead of a flat blit, and the shadow (step 2) is the projected card outline, so it
 * follows the tilt. Everything inside the card (masks, clicks, screen annotations, cursor) moves
 * with it; webcam, frame annotations, shortcut, caption, watermark and slides stay flat on top.
 * Frames without m3d never touch WebGL.
 *
 * Every motion decision comes from the plan; this file only draws. Known, intentional differences
 * from the reference are listed in docs/Editor.md ("Preview vs export").
 */
import { transitionLayers } from "@lens/engine";
import { boxHighlightText, captionEffects, captionLook, captionMotion, captionStrokePx, cardOutline, hasArabicScript, type Motion3DFrame, type PlanFrame, type RenderPlan } from "@lens/engine";
import { CARD_PAD, Gl3dPass } from "./gl3d";
import { makeCanvas, type AnyCanvas } from "./canvas";
import { cursorSprite } from "./cursorSprite";
import { drawItems } from "./annotations";
import { fontCss, fontSet, imageAspect, imageAt } from "./assets";
import { backdropById, drawBackdrop, gradientStops } from "./backdrops";

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

/**
 * The screen card's rect on frame f in whole output px (x, y, w, h): the one place the card rect is
 * computed. The 2D blit, the shadow and the 3D pass all start from it.
 */
export function cardRect(f: PlanFrame): [number, number, number, number] {
  const [sx, sy, sw0, sh0] = f.layout.screen.map(pyRound) as [number, number, number, number];
  return [sx, sy, Math.max(2, sw0), Math.max(2, sh0)];
}

export class PlanRenderer {
  private gl3d: Gl3dPass | null = null;
  private card: AnyCanvas | null = null;
  /** Wall-clock ms of the last 3D pass (card texture + GL draw + readback), for perf logging. */
  last3dMs = 0;
  private bgKey = "";
  private bg: AnyCanvas | null = null;
  private shadowKey = "";
  private shadow: AnyCanvas | null = null;
  private view: AnyCanvas | null = null;
  private tmp: AnyCanvas | null = null;

  private trA: AnyCanvas | null = null;
  private trB: AnyCanvas | null = null;
  private trBlur: AnyCanvas | null = null;

  /**
   * Draw output frame `index` of `plan` into g (sized plan.output.width x height). A frame near a cut
   * join (plan frame `tr`, demand #14) is two frames composited: this one and the other side of the
   * join (frame tr.other, held still), whose source images are `other`.
   * `overlay` (demand #11, NLE hand-off): only the layer an editor puts over the plain recording, on a
   * transparent frame: click effects, screen-anchored annotations and the cursor (through the camera,
   * clipped to the rounded screen card) and frame-anchored annotations. No backdrop, shadow, screen,
   * masks, webcam, captions, shortcut pill, watermark or slides.
   */
  draw(g: Canvas2D, plan: RenderPlan, index: number, imgs: FrameImages, other?: FrameImages | null, opts: { overlay?: boolean } = {}): void {
    // the NLE overlay (demand #11) carries no cut transitions: the editor's own cut joins the clips
    if (opts.overlay) return this.drawOne(g, plan, index, imgs, opts);
    const f = plan.frames[Math.max(0, Math.min(plan.frames.length - 1, index))];
    const tr = f?.tr;
    if (!f || !tr || !plan.frames[tr.other]) return this.drawOne(g, plan, index, imgs);
    const { width: W, height: H } = plan.output;
    if (!this.trA || this.trA.width !== W || this.trA.height !== H) this.trA = makeCanvas(W, H);
    if (!this.trB || this.trB.width !== W || this.trB.height !== H) this.trB = makeCanvas(W, H);
    const self = this.trA;
    const oth = this.trB;
    this.drawOne(ctx2d(oth), plan, tr.other, other ?? { screen: null, cam: null });
    this.drawOne(ctx2d(self), plan, index, imgs);
    // A = outgoing (before the join), B = incoming; B is drawn over A
    const [A, B] = tr.incoming ? [oth, self] : [self, oth];
    const L = transitionLayers(tr.kind, tr.u);
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = "source-over";
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    g.globalAlpha = 1;
    g.fillStyle = "#000000";
    g.fillRect(0, 0, W, H);
    const short = Math.min(W, H);
    const layer = (c: AnyCanvas, l: { alpha: number; scale: number; dx: number; blur: number }) => {
      if (l.alpha <= 0) return;
      let src = c;
      const sigma = l.blur * short;
      if (sigma > 0.05) {
        // blurred copy over the sharp one (the blur fades the edges to transparent; the sharp layer
        // fills them), made opaque first so the layer's alpha applies once
        if (!this.trBlur || this.trBlur.width !== W || this.trBlur.height !== H) this.trBlur = makeCanvas(W, H);
        const bg2 = ctx2d(this.trBlur);
        bg2.save();
        bg2.setTransform(1, 0, 0, 1, 0, 0);
        bg2.globalAlpha = 1;
        bg2.globalCompositeOperation = "source-over";
        bg2.filter = "none";
        bg2.drawImage(c as CanvasImageSource, 0, 0);
        bg2.filter = `blur(${sigma.toFixed(2)}px)`;
        bg2.drawImage(c as CanvasImageSource, 0, 0);
        bg2.restore();
        src = this.trBlur;
      }
      g.save();
      g.globalAlpha = Math.min(1, l.alpha);
      g.translate(W / 2 + l.dx * W, H / 2);
      g.scale(l.scale, l.scale);
      g.translate(-W / 2, -H / 2);
      g.drawImage(src as CanvasImageSource, 0, 0);
      g.restore();
    };
    layer(A, L.a);
    layer(B, L.b);
    g.restore();
  }

  private drawOne(g: Canvas2D, plan: RenderPlan, index: number, imgs: FrameImages, opts: { overlay?: boolean } = {}): void {
    const overlay = !!opts.overlay;
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
    if (overlay) g.clearRect(0, 0, W, H);
    else g.drawImage(this.background(plan) as CanvasImageSource, 0, 0);

    // 2. shadow (cached per rect, like render.py shadow_layer)
    const [sx, sy, sw, sh] = cardRect(f);
    const shadow = style.shadow;
    if (overlay) {
      // no shadow on the overlay layer
    } else if (f.m3d && f.layout.screenOpacity > 0 && shadow.opacity > 0) {
      g.drawImage(this.shadowLayer3d(W, H, f.m3d, sx, sy, sw, sh, style.radius, shadow, shadow.opacity * f.layout.screenOpacity) as CanvasImageSource, 0, 0);
    } else if (f.layout.screenOpacity > 0 && shadow.opacity > 0) {
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
    const map = this.drawScreen(vg, plan, f, overlay ? null : imgs.screen, sw, sh);

    // 4. masks
    if (f.masks.length && !overlay) this.drawMasks(vg, view, f, map, sw, sh);

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

    // 7. rounded composite (flat, or through the 3D perspective pass)
    if (f.m3d) {
      this.drawCard3d(g, f.m3d, view, [sx, sy, sw, sh], style.radius, f.layout.screenOpacity, W, H);
    } else {
      g.save();
      g.globalAlpha = f.layout.screenOpacity;
      roundRectPath(g, sx, sy, sw, sh, style.radius);
      g.clip();
      g.drawImage(view as CanvasImageSource, sx, sy);
      g.restore();
    }

    // 8. webcam
    if (!overlay && imgs.cam && f.layout.camera && f.layout.cameraOpacity > 0) this.drawWebcam(g, plan, f, imgs.cam);

    // 8b. frame-anchored annotations
    const frm = annotations.filter((a) => a.space === "frame");
    if (frm.length) drawItems(g, W, H, frm, (x, y) => [x, y], 1);

    if (overlay) {
      g.restore();
      return;
    }

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
    if (f.slide) {
      const fx = f.slide.fx;
      if (fx) {
        // enter / exit transform (demand #14): offset, scale about the centre, blur
        g.save();
        g.translate(W / 2 + fx[0], H / 2 + fx[1]);
        g.scale(fx[2], fx[2]);
        g.translate(-W / 2, -H / 2);
        if (fx[3] > 0.05) g.filter = `blur(${fx[3].toFixed(2)}px)`;
      }
      drawItems(g, W, H, [{ ops: f.slide.ops, opacity: f.slide.opacity, shadow: null }], (x, y) => [x, y], 1, 1, { background: this.background(plan) as CanvasImageSource });
      if (fx) g.restore();
    }
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
    let complete = true;
    if (bg.kind === "hidden") {
      // no backdrop (Windows bug #20): black behind a recording that fills the frame
      g.fillStyle = "#000000";
      g.fillRect(0, 0, W, H);
    } else if (bg.kind === "image" && bg.imagePath) {
      const blur = bg.blur || 0;
      if (blur > 0) g.filter = `blur(${blur}px)`;
      const builtin = backdropById(bg.imagePath);
      if (builtin) {
        // drawn larger than the frame when blurred so the edges stay solid
        const m = Math.ceil(blur * 3);
        g.save();
        g.translate(-m, -m);
        // a field backdrop still rendering off-thread draws a stand-in: draw again once it lands
        if (!drawBackdrop(g, builtin, W + 2 * m, H + 2 * m)) complete = false;
        g.restore();
      } else {
        g.fillStyle = colors[0]!;
        g.fillRect(-4 * blur, -4 * blur, W + 8 * blur, H + 8 * blur);
        const ar = imageAspect(bg.imagePath);
        if (ar) {
          const cover = (bg as { fit?: string }).fit !== "contain";
          let w = W;
          let h = W / ar;
          if (cover ? h < H : h > H) {
            h = H;
            w = H * ar;
          }
          const m = cover ? Math.ceil(blur * 3) : 0;
          const im = imageAt(bg.imagePath, Math.round(w + 2 * m), Math.round(h + 2 * m));
          if (im) g.drawImage(im as CanvasImageSource, Math.round((W - w) / 2 - m), Math.round((H - h) / 2 - m));
          else complete = false;
        } else complete = false;
      }
    } else {
      if (bg.kind === "gradient" && colors.length >= 2) {
        const ang = ((bg.angle ?? 135) * Math.PI) / 180;
        const dx = Math.sin(ang);
        const dy = -Math.cos(ang);
        const span = Math.abs((W / 2) * dx) + Math.abs((H / 2) * dy);
        // render.py: u = (proj / span + 1) / 2 with proj measured from the centre along (dx, dy)
        const gr = g.createLinearGradient(W / 2 - dx * span, H / 2 - dy * span, W / 2 + dx * span, H / 2 + dy * span);
        for (const [at, col] of gradientStops(colors, bg.stops)) gr.addColorStop(at, col);
        g.fillStyle = gr;
      } else {
        g.fillStyle = colors[0]!;
      }
      if (bg.blur > 0) g.filter = `blur(${bg.blur}px)`;
      g.fillRect(-4 * (bg.blur || 0), -4 * (bg.blur || 0), W + 8 * (bg.blur || 0), H + 8 * (bg.blur || 0));
    }
    g.filter = "none";
    this.bg = c;
    // an uploaded image still loading: draw it again next frame
    this.bgKey = complete ? key : "";
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

  /** The rounded card (at its opacity, CARD_PAD transparent border) through the WebGL2 pass. */
  private drawCard3d(g: Canvas2D, m: Motion3DFrame, view: AnyCanvas, rect: [number, number, number, number], radius: number, opacity: number, W: number, H: number): void {
    const t0 = performance.now();
    const [, , sw, sh] = rect;
    const cw = sw + 2 * CARD_PAD;
    const ch = sh + 2 * CARD_PAD;
    if (!this.card || this.card.width !== cw || this.card.height !== ch) this.card = makeCanvas(cw, ch);
    const cg = ctx2d(this.card);
    cg.save();
    cg.setTransform(1, 0, 0, 1, 0, 0);
    cg.clearRect(0, 0, cw, ch);
    cg.globalAlpha = opacity;
    roundRectPath(cg, CARD_PAD, CARD_PAD, sw, sh, radius);
    cg.clip();
    cg.drawImage(view as CanvasImageSource, CARD_PAD, CARD_PAD);
    cg.restore();
    if (!this.gl3d) this.gl3d = new Gl3dPass();
    const out = this.gl3d.render(this.card, m, rect, W, H);
    g.drawImage(out as CanvasImageSource, 0, 0);
    this.last3dMs = performance.now() - t0;
  }

  /** Shadow of the projected card outline: same blur / offset / opacity as the flat shadow, following the tilt. */
  private shadowLayer3d(W: number, H: number, m: Motion3DFrame, x: number, y: number, w: number, h: number, radius: number, s: RenderPlan["style"]["shadow"], opacity: number): AnyCanvas {
    const c = this.shadow && this.shadow.width === W && this.shadow.height === H ? this.shadow : makeCanvas(W, H);
    this.shadow = c;
    this.shadowKey = "";
    const g = ctx2d(c);
    g.clearRect(0, 0, W, H);
    const ox = s.offsetY * Math.cos((s.angle * Math.PI) / 180);
    const oy = s.offsetY * Math.sin((s.angle * Math.PI) / 180);
    const FAR = W + H + 1000;
    const pts = cardOutline(m, x, y, w, h, radius, 8);
    g.save();
    g.shadowColor = `rgba(0,0,0,${opacity})`;
    g.shadowBlur = s.blur;
    g.shadowOffsetX = ox + FAR;
    g.shadowOffsetY = oy;
    g.fillStyle = "#000";
    g.beginPath();
    pts.forEach(([px, py], i) => (i ? g.lineTo(px - FAR, py) : g.moveTo(px - FAR, py)));
    g.closePath();
    g.fill();
    g.restore();
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
    const cur = f.cur!;
    const [px, py, op, sc, shape] = cur;
    const theme = style.cursorTheme === "light" ? "light" : "classic";
    const forced = style.cursorShape !== "system";
    // demand #12: while the cursor type changes, the old type fades out under the new one
    const layers: Array<[string, number]> = !forced && cur.length === 7 ? [[cur[5], 1 - cur[6]], [shape, cur[6]]] : [[forced ? style.cursorShape : shape, 1]];
    const base = 26 * style.cursorSize * (plan.source.pixelRatio || 1);
    const size = Math.max(6, pyRound(base * map.k * sc));
    const rx = (px - map.x0) * map.k;
    const ry = (py - map.y0) * map.ky;
    const mb = style.motionBlur;
    let prevPt: [number, number] | null = null;
    if (mb.enabled && prev && prev.cur) {
      const pm = viewMapOf(plan, prev);
      prevPt = [(prev.cur[0] - pm.x0) * pm.k, (prev.cur[1] - pm.y0) * pm.ky];
    }
    for (const [name, w] of layers) {
      if (w <= 0) continue;
      const spr = cursorSprite(name, theme);
      const hx = spr.hot[0] * size;
      const hy = spr.hot[1] * size;
      const put = (x: number, y: number, a: number) => {
        vg.globalAlpha = a;
        vg.drawImage(spr.canvas as CanvasImageSource, x, y, size, size);
      };
      const o = op * w;
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
            put(tx - hx, ty - hy, o / n);
          }
        } else put(rx - hx, ry - hy, o);
      } else put(rx - hx, ry - hy, o);
    }
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
    g.save();
    const L = captionLayout(g, plan, f, W, H);
    if (!L) {
      g.restore();
      return;
    }
    const { cs, size, words, lines, widths, lineW, asc, lh, blockH, top, look, useFont } = L;
    const fx = captionEffects(cs);
    const padx = size * 0.55;
    const pady = size * 0.28;
    const bg = cs.background ?? { enabled: true, color: "#000000", opacity: 0.66 };
    const active = cs.wordHighlight !== false ? L.active : -1;
    const hs = look.highlightStyle;
    const shown = f.caption!.shown;
    const visible = (j: number) => shown === undefined || j < shown;
    const motion = captionMotion(hs, f.caption!.progress);
    const hiColor = cs.highlightColor ?? "#ffd23f";
    const boxHi = (hs === "box" || hs === "pill") && active >= 0;
    const strokePx = look.stroke.enabled ? captionStrokePx(size, look.stroke.width) : 0;
    // word x positions, line by line (shared by the backgrounds, highlight and text passes)
    const placed: Array<{ j: number; li: number; x: number; y: number; w: number }> = [];
    lines.forEach((ln, li) => {
      let x = (W - lineW[li]!) / 2;
      const y = top + li * lh;
      // right-to-left captions carry their left-to-right drawing order (word-level bidi)
      const order = L.visual?.[li] ?? ln;
      for (const j of order) {
        const n = ln.indexOf(j);
        placed.push({ j, li, x, y, w: widths[li]![n]! });
        x += widths[li]![n]! + L.space;
      }
    });
    // the spoken word under pop / bounce: its own size (whole px), centred on its slot, lifted
    const wordFont = (j: number): { x: (p: { x: number; w: number }) => number; dy: number; scaled: boolean } => {
      if (j !== active || (hs !== "pop" && hs !== "bounce")) return { x: (p) => p.x, dy: 0, scaled: false };
      const dy = -jsRound(size * motion.lift);
      if (hs === "bounce" || motion.scale === 1) return { x: (p) => p.x, dy, scaled: false };
      return { x: (p) => p.x + (p.w - measureScaled(j)) / 2, dy, scaled: true };
    };
    const big = Math.max(1, jsRound(size * motion.scale));
    const setWord = (j: number, scaled: boolean) => {
      useFont(j);
      if (scaled) g.font = g.font.replace(`${size}px`, `${big}px`);
    };
    const measureScaled = (j: number) => {
      setWord(j, true);
      return g.measureText(words[j]!).width;
    };

    // 1. background(s)
    if (bg.enabled !== false) {
      const rects = captionBackgroundRects(fx, placed.filter((p) => visible(p.j)), lines.length, lineW, W, top, blockH, asc, size, padx, pady);
      const [r, gg, b] = hexRgb(bg.color ?? "#000000");
      if (fx.backdropBlur > 0 && rects.length) this.blurUnder(g, rects, size * fx.backdropBlur, W, H);
      g.fillStyle = `rgba(${r},${gg},${b},${Math.trunc(255 * (bg.opacity ?? 0.66)) / 255})`;
      for (const q of rects) {
        roundRectPath(g, q.x, q.y, q.w + 1, q.h + 1, q.r);
        g.fill();
      }
      if (fx.accent && rects.length) {
        const q = rects[0]!;
        const ax = fx.boxShape === "bar" ? Math.round((W - Math.max(...lineW)) / 2 - padx) : Math.round(q.x);
        g.fillStyle = fx.accent;
        g.fillRect(ax, Math.round(q.y), Math.max(2, jsRound(size * 0.12)), Math.round(q.h) + 1);
      }
    }

    // 2. glow, then drop shadow: the words' silhouette (with outline), blurred, under everything else
    const silhouette = (color: string): AnyCanvas => {
      const c = this.scratch(W, H);
      const sg = c.getContext("2d") as Canvas2D;
      sg.clearRect(0, 0, W, H);
      sg.save();
      sg.textBaseline = "alphabetic";
      sg.textAlign = "left";
      (sg as unknown as { fontKerning: string }).fontKerning = "none";
      sg.fillStyle = color;
      sg.strokeStyle = color;
      sg.lineJoin = "round";
      sg.miterLimit = 2;
      sg.lineWidth = 2 * strokePx;
      for (const p of placed) {
        if (!visible(p.j)) continue;
        const wf = wordFont(p.j);
        useFont(p.j);
        sg.font = wf.scaled ? g.font.replace(`${size}px`, `${big}px`) : g.font;
        (sg as unknown as { direction: string }).direction = (g as unknown as { direction: string }).direction;
        const x = wf.x(p);
        const y = p.y + asc + wf.dy;
        if (strokePx > 0) sg.strokeText(words[p.j]!, x, y);
        sg.fillText(words[p.j]!, x, y);
      }
      sg.restore();
      return c;
    };
    const ghost = (color: string, opacity: number, dx: number, dy: number, sigma: number) => {
      const c = silhouette(color);
      // only the caption's neighbourhood (the compositor's region): blur margin + offset + one font size
      const m = Math.ceil(sigma * 3) + 2 + Math.max(Math.abs(dx), Math.abs(dy));
      const x0 = Math.max(0, Math.floor(Math.min(...placed.map((p) => p.x))) - m - size);
      const x1 = Math.min(W, Math.ceil(Math.max(...placed.map((p) => p.x + p.w))) + m + size);
      const y0 = Math.max(0, Math.trunc(top) - m - size);
      const y1 = Math.min(H, Math.trunc(top + blockH) + m + size);
      if (x1 <= x0 || y1 <= y0) return;
      g.save();
      g.globalAlpha = opacity;
      if (sigma > 0) g.filter = `blur(${sigma}px)`;
      g.drawImage(c as CanvasImageSource, x0 - dx, y0 - dy, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
      g.restore();
    };
    if (fx.glow) ghost(fx.glow.color, 1, 0, 0, size * fx.glow.radius);
    if (fx.shadow) ghost(fx.shadow.color, fx.shadow.opacity, jsRound(size * fx.shadow.dx), jsRound(size * fx.shadow.dy), size * fx.shadow.blur);

    // 3. highlight decorations under the text
    const ap = active >= 0 ? placed.find((q) => q.j === active && visible(q.j)) : undefined;
    if (boxHi && ap) {
      const wf = wordFont(active);
      const [bx, by, bw, bh, br] = hs === "pill" ? highlightPillRect(ap.x, ap.y + asc, ap.w, size) : [...highlightBoxRect(ap.x, ap.y + asc, ap.w, size), Math.trunc(size * 0.22)];
      g.fillStyle = hiColor;
      roundRectPath(g, bx, by + wf.dy, bw + 1, bh + 1, br);
      g.fill();
    }
    if (hs === "underline" && ap) {
      const [ux, uy, uw, uh] = underlineRect(ap.x, ap.y + asc, ap.w, size, motion.sweep);
      if (uw > 0) {
        g.fillStyle = hiColor;
        g.fillRect(ux, uy, uw, uh);
      }
    }

    // 4. words: outline, then fill (highlight colour, gradient, second-line colour or the text colour)
    for (const p of placed) {
      const j = p.j;
      if (!visible(j)) continue;
      const wf = wordFont(j);
      setWord(j, wf.scaled);
      const x = wf.x(p);
      const y = p.y + asc + wf.dy;
      const onBox = boxHi && j === active;
      // every word sits on the line's baseline (line top + the taller font's ascent), as in the compositor
      if (strokePx > 0 && !onBox) {
        g.lineJoin = "round";
        g.miterLimit = 2;
        g.lineWidth = 2 * strokePx;
        g.strokeStyle = look.stroke.color;
        g.strokeText(words[j]!, x, y);
      }
      const base = p.li >= 1 && fx.line2Color ? fx.line2Color : cs.textColor ?? "#ffffff";
      const lit = active >= 0 && (hs === "karaoke" ? j <= active : j === active && (hs === "color" || hs === "pop" || hs === "bounce"));
      if (onBox) g.fillStyle = boxHighlightText(hiColor);
      else if (lit) g.fillStyle = hiColor;
      else if (fx.gradient) {
        const gr = g.createLinearGradient(0, p.y, 0, p.y + lh);
        gr.addColorStop(0, fx.gradient.from);
        gr.addColorStop(1, fx.gradient.to);
        g.fillStyle = gr;
      } else g.fillStyle = base;
      g.fillText(words[j]!, x, y);
    }
    g.restore();
  }

  private scratchCanvas: AnyCanvas | null = null;
  /** A reusable W x H canvas for the caption glow / shadow silhouette. */
  private scratch(W: number, H: number): AnyCanvas {
    if (!this.scratchCanvas || this.scratchCanvas.width !== W || this.scratchCanvas.height !== H) this.scratchCanvas = makeCanvas(W, H);
    return this.scratchCanvas;
  }

  /** Frosted caption background: the picture under the rects, Gaussian-blurred (sigma px), clipped to them. */
  private blurUnder(g: Canvas2D, rects: CaptionRect[], sigma: number, W: number, H: number): void {
    const m = Math.ceil(sigma * 3);
    const x0 = Math.max(0, Math.floor(Math.min(...rects.map((q) => q.x))) - m);
    const y0 = Math.max(0, Math.floor(Math.min(...rects.map((q) => q.y))) - m);
    const x1 = Math.min(W, Math.ceil(Math.max(...rects.map((q) => q.x + q.w + 1))) + m);
    const y1 = Math.min(H, Math.ceil(Math.max(...rects.map((q) => q.y + q.h + 1))) + m);
    if (x1 <= x0 || y1 <= y0) return;
    const tmp = makeCanvas(x1 - x0, y1 - y0);
    const tg = tmp.getContext("2d") as Canvas2D;
    tg.drawImage(g.canvas as CanvasImageSource, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
    g.save();
    g.beginPath();
    for (const q of rects) {
      roundRectPath(g, q.x, q.y, q.w + 1, q.h + 1, q.r);
    }
    g.clip();
    g.filter = `blur(${sigma}px)`;
    g.drawImage(tmp as CanvasImageSource, x0, y0);
    g.restore();
  }
}

/** JavaScript Math.round, named for the compositor's _js_round. */
const jsRound = Math.round;

interface CaptionRect { x: number; y: number; w: number; h: number; r: number }

/**
 * Caption background rects (output px; w / h exclusive of the +1 both renderers add): one pill for the
 * block (the original look), a full-width bar, one box per line, or one per (shown) word.
 */
function captionBackgroundRects(fx: ReturnType<typeof captionEffects>, placed: Array<{ j: number; li: number; x: number; y: number; w: number }>, nLines: number,
  lineW: number[], W: number, top: number, blockH: number, asc: number, size: number, padx: number, pady: number): CaptionRect[] {
  const square = fx.boxShape !== "rounded";
  if (fx.boxShape === "bar") return [{ x: 0, y: top - pady, w: W, h: blockH + 2 * pady, r: 0 }];
  if (fx.boxMode === "block") {
    const bw = Math.max(...lineW);
    return [{ x: (W - bw) / 2 - padx, y: top - pady, w: bw + 2 * padx, h: blockH + 2 * pady, r: square ? 0 : Math.trunc(size * 0.45) }];
  }
  const by = (y: number) => y + asc - jsRound(size * 0.95);
  const bh = jsRound(size * 1.25);
  const r = square ? 0 : Math.trunc(size * 0.3);
  if (fx.boxMode === "line") {
    const out: CaptionRect[] = [];
    for (let li = 0; li < nLines; li++) {
      const ws = placed.filter((p) => p.li === li);
      if (!ws.length) continue;
      const lx = Math.min(...ws.map((p) => p.x));
      const rx = Math.max(...ws.map((p) => p.x + p.w));
      const px = jsRound(size * 0.3);
      out.push({ x: jsRound(lx) - px, y: by(ws[0]!.y), w: jsRound(rx - lx) + 2 * px, h: bh, r });
    }
    return out;
  }
  const px = jsRound(size * 0.16);
  return placed.map((p) => ({ x: jsRound(p.x) - px, y: by(p.y), w: jsRound(p.w) + 2 * px, h: bh, r }));
}

/** The pill highlight (karaoke pill): wider padding, fully rounded. */
function highlightPillRect(x: number, baseline: number, w: number, size: number): [number, number, number, number, number] {
  const pad = jsRound(size * 0.28);
  const h = jsRound(size * 1.14);
  return [jsRound(x) - pad, baseline - jsRound(size * 0.88), jsRound(w) + 2 * pad, h, Math.trunc(h / 2)];
}

/** The underline under the spoken word, `sweep` (0..1) of its width. */
function underlineRect(x: number, baseline: number, w: number, size: number, sweep: number): [number, number, number, number] {
  return [jsRound(x), baseline + jsRound(size * 0.12), jsRound(w * sweep), Math.max(2, jsRound(size * 0.08))];
}

/** The active word's highlight box (output px x, y, w, h) around a word drawn at (x, baseline). */
function highlightBoxRect(x: number, baseline: number, w: number, size: number): [number, number, number, number] {
  const pad = Math.round(size * 0.16);
  return [Math.round(x) - pad, baseline - Math.round(size * 0.9), Math.round(w) + 2 * pad, Math.round(size * 1.16)];
}

interface CaptionLayout {
  cs: RenderPlan["style"]["captions"];
  size: number;
  /** Words as drawn (capitals when uppercase is on). */
  words: string[];
  lines: number[][];
  widths: number[][];
  lineW: number[];
  space: number;
  asc: number;
  lh: number;
  blockH: number;
  top: number;
  active: number;
  visual?: number[][];
  look: ReturnType<typeof captionLook>;
  isScript: boolean[];
  useFont: (j: number) => void;
}

/**
 * Measure a caption the way drawCaption draws it (fonts, weight, case, wrapping, position). Leaves
 * g.font on the main font; callers save / restore g.
 */
function captionLayout(g: Canvas2D, plan: RenderPlan, f: PlanFrame, W: number, H: number): CaptionLayout | null {
  const cap = f.caption;
  if (!cap || !cap.words.length) return null;
  const cs = plan.style.captions;
  const look = captionLook(cs);
  const words = look.uppercase ? cap.words.map((w) => w.toUpperCase()) : cap.words;
  const size = Math.max(10, pyRound(cs.fontSize ?? H * 0.04));
  const wt = look.weight === "regular" ? "normal" : "bold";
  const mainFont = `${wt} ${size}px ${fontCss((cs as { font?: string }).font, FONT_STACK)}`;
  // demand #8: Arabic-script words (Urdu, Arabic) in the plan's script font, shaped right to left
  const scriptFont = cs.scriptFont ? `${wt} ${size}px ${fontCss(cs.scriptFont, FONT_STACK)}` : null;
  const isScript = words.map((w) => !!scriptFont && hasArabicScript(w));
  const useFont = (j: number) => {
    g.font = isScript[j] ? scriptFont! : mainFont;
    (g as unknown as { direction: string }).direction = isScript[j] ? "rtl" : "ltr";
  };
  // a right-to-left line is one Arabic-script run: its spaces come from the script font (as in the compositor)
  const rtlLine = !!cap.visual && isScript.some(Boolean);
  g.font = rtlLine ? scriptFont! : mainFont;
  setNoKerning(g);
  g.textBaseline = "alphabetic";
  g.textAlign = "left";
  (g as unknown as { direction: string }).direction = rtlLine ? "rtl" : "ltr";
  const space = g.measureText(" ").width;
  g.font = mainFont;
  const lines: number[][] = [];
  let i = 0;
  for (const n of cap.lines) {
    lines.push(Array.from({ length: n }, (_, j) => i + j));
    i += n;
  }
  const widths = lines.map((ln) => ln.map((j) => {
    useFont(j);
    return g.measureText(words[j]!).width;
  }));
  g.font = mainFont;
  (g as unknown as { direction: string }).direction = "ltr";
  const lineW = widths.map((ws) => ws.reduce((a, b) => a + b, 0) + space * (ws.length - 1));
  let [asc, desc] = fontVMetrics(g, wt, size, fontCss((cs as { font?: string }).font, FONT_STACK), "Hg");
  if (isScript.some(Boolean)) {
    const [sa, sd] = fontVMetrics(g, wt, size, fontCss(cs.scriptFont, FONT_STACK), "\u0628");
    asc = Math.max(asc, sa);
    desc = Math.max(desc, sd);
  }
  g.font = mainFont;
  const lh = Math.trunc((asc + desc) * 1.12);
  const blockH = lh * lines.length;
  const pos = cs.position ?? "bottom";
  const top = pos === "top" ? Math.trunc(H * 0.07) : pos === "custom" ? Math.trunc((cs.y ?? 0.88) * H - blockH / 2) : Math.trunc(H * 0.93) - blockH;
  return { cs, size, words, lines, widths, lineW, space, asc, lh, blockH, top, active: cap.active, visual: cap.visual, look, isScript, useFont };
}

const vMetricsCache = new Map<string, [number, number]>();

/**
 * Line ascent / descent of a font in whole pixels, as FreeType (PIL getmetrics in render.py) rounds
 * them: measured at 64 x size, so Chrome's per-size rounding of fontBoundingBox* does not leak in,
 * then ceil(v / 64) like FreeType's 26.6 ceiling (Fira Sans 27 px: 26 / 8, where measuring at 27 px
 * gives 26 / 7). Cached per font string once the font has loaded. Leaves g.font changed.
 */
function fontVMetrics(g: Canvas2D, wt: string, size: number, family: string, sample: string): [number, number] {
  const key = `${wt} ${size}px ${family}|${sample}`;
  const hit = vMetricsCache.get(key);
  if (hit) return hit;
  g.font = `${wt} ${size * 64}px ${family}`;
  const m = g.measureText(sample);
  const v: [number, number] = [Math.ceil(m.fontBoundingBoxAscent / 64 - 1e-6), Math.ceil(m.fontBoundingBoxDescent / 64 - 1e-6)];
  if (primaryFaceReady(family) && checkLoaded(`${wt} ${size}px ${family}`, sample)) vMetricsCache.set(key, v);
  return v;
}

function checkLoaded(font: string, sample: string): boolean {
  try {
    return fontSet().check(font, sample);
  } catch {
    return true;
  }
}

/**
 * Whether the first family of a font stack is really there to measure. FontFaceSet.check() is also
 * true for a family that has no face in the set yet (nothing to load, the fallback is drawn), so a
 * caption drawn while a plan font (an imported one, "Lens Lobster") was still loading cached the
 * fallback's ascent / descent for good: the preview's lines then sat 1 px off the export's, which
 * measures after ensurePlanAssets. Only "Lens <family>" faces are registered at run time; any other
 * family (the built-in caption face, system stacks) counts as ready.
 */
function primaryFaceReady(family: string): boolean {
  const first = family.split(",")[0]!.trim().replace(/^["']|["']$/g, "");
  if (!first.startsWith("Lens ")) return true;
  try {
    for (const f of fontSet() as unknown as Iterable<FontFace>) if (f.family.replace(/^["']|["']$/g, "") === first && f.status === "loaded") return true;
  } catch {
    return true;
  }
  return false;
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

/**
 * The caption box drawn on frame f (output px: x, y, w, h including the pill padding), measured the way
 * drawCaption lays it out (same fonts, weight, case and wrapping). Used to pick and drag the caption on the preview.
 */
export function captionBox(g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, plan: RenderPlan, f: PlanFrame): [number, number, number, number] | null {
  const { width: W, height: H } = plan.output;
  g.save();
  const L = captionLayout(g, plan, f, W, H);
  g.restore();
  if (!L) return null;
  const padx = L.size * 0.55;
  const pady = L.size * 0.28;
  const bw = Math.max(...L.lineW);
  return [(W - bw) / 2 - padx, L.top - pady, bw + 2 * padx, L.blockH + 2 * pady];
}
