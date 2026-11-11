import type { CameraLayoutKind, CameraLayoutSegment, Rect } from "./types.js";
import type { ProjectConfig } from "./project.js";
import { ease, type CameraAnimKind, type ElementAnim } from "./transitions.js";

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Output pixel size for an aspect ratio. resolution is the short side (the height for 16:9). */
export function outputSize(aspect: string, resolution: number): { width: number; height: number } {
  let [aw, ah] = aspect.split(":").map(Number) as [number, number];
  // "auto" (or anything unparsable) without a source to follow: 16:9 (canvasSize handles auto)
  if (!(aw > 0 && ah > 0)) [aw, ah] = [16, 9];
  if (aw >= ah) return { width: even((resolution * aw) / ah), height: even(resolution) };
  return { width: even(resolution), height: even((resolution * ah) / aw) };
}

/**
 * Canvas size of a project (feat/canvas-layout): a custom W x H in px (output.size {w, h}) wins; aspect
 * "auto" follows the (user-cropped) source, `source` w x h; otherwise outputSize(aspect, resolution).
 */
export function canvasSize(output: ProjectConfig["output"], source: { width: number; height: number }): { width: number; height: number } {
  const sz = output.size;
  if (sz && sz.w > 0 && sz.h > 0) return { width: even(sz.w), height: even(sz.h) };
  if (output.aspect === "auto") {
    const r = source.width / Math.max(1, source.height);
    const res = output.resolution;
    return r >= 1 ? { width: even(res * r), height: even(res) } : { width: even(res), height: even(res / r) };
  }
  return outputSize(output.aspect, output.resolution);
}

// ------------------------------------------------------------------ the screen card (feat/canvas-layout)

/** A free card placement: top-left and size as fractions of the canvas width / height. */
export interface CardTransform {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function validCard(c: CardTransform | null | undefined): c is CardTransform {
  return !!c && [c.x, c.y, c.w, c.h].every(Number.isFinite) && c.w > 0 && c.h > 0;
}

/** Today's placement (and the Fit button): the source aspect fitted inside the padded canvas. */
export function fittedCardRect(out: { width: number; height: number }, sourceAspect: number, cfg: Pick<ProjectConfig, "background" | "frame">): Rect {
  const short = Math.min(out.width, out.height);
  const pad = cfg.background.kind === "hidden" ? 0 : cfg.frame.padding * short;
  return fitRect({ x: pad, y: pad, w: out.width - 2 * pad, h: out.height - 2 * pad }, sourceAspect);
}

/**
 * THE screen card rect (output px) before any per-frame motion: the one place the card's base
 * placement is computed. Auto zoom happens inside it (the virtual camera's viewport is drawn into
 * this rect), so cursor, clicks, masks and screen-anchored annotations move with it. A 3D / perspective
 * pass composes on top of the rect this returns (see docs/Editor.md "Screen card").
 * `sourceAspect` is the aspect of the content shown in the card (the effective crop, cardCrop()).
 */
export function cardRect(out: { width: number; height: number }, sourceAspect: number, cfg: Pick<ProjectConfig, "background" | "frame" | "card">): Rect {
  const c = cfg.card;
  if (validCard(c)) return { x: c.x * out.width, y: c.y * out.height, w: c.w * out.width, h: c.h * out.height };
  return fittedCardRect(out, sourceAspect, cfg);
}

/** Card rect (output px) -> fractions of the canvas, rounded to 1e-5 (what project.card stores). */
export function cardFromRect(r: Rect, out: { width: number; height: number }): CardTransform {
  const q = (v: number) => Math.round(v * 1e5) / 1e5;
  return { x: q(r.x / out.width), y: q(r.y / out.height), w: q(r.w / out.width), h: q(r.h / out.height) };
}

/** Fill: a card covering the whole canvas (its shape trims the source, centred). */
export function fillCard(): CardTransform {
  return { x: 0, y: 0, w: 1, h: 1 };
}

/** Centre a card on the canvas, keeping its size. */
export function centerCard(c: CardTransform): CardTransform {
  const q = (v: number) => Math.round(v * 1e5) / 1e5;
  return { x: q((1 - c.w) / 2), y: q((1 - c.h) / 2), w: c.w, h: c.h };
}

/**
 * The part of the (user-cropped) source shown in the card. A card whose shape differs from the
 * crop's (a free resize without Shift, Fill on another aspect) trims the crop, centred, to the card's
 * aspect, so nothing is ever stretched. No custom card = the crop unchanged (today's behaviour).
 */
export function cardCrop(crop: Rect, out: { width: number; height: number }, cfg: Pick<ProjectConfig, "card">): Rect {
  const c = cfg.card;
  if (!validCard(c)) return crop;
  const a = (c.w * out.width) / (c.h * out.height);
  const ca = crop.w / crop.h;
  if (Math.abs(a - ca) / ca < 1e-3) return crop;
  let w = crop.w;
  let h = crop.h;
  if (a > ca) h = Math.max(2, Math.round(w / a));
  else w = Math.max(2, Math.round(h * a));
  return { x: Math.round(crop.x + (crop.w - w) / 2), y: Math.round(crop.y + (crop.h - h) / 2), w, h };
}

/** Largest rect with the given aspect that fits inside box, centered. */
export function fitRect(box: Rect, aspect: number): Rect {
  let w = box.w;
  let h = w / aspect;
  if (h > box.h) {
    h = box.h;
    w = h * aspect;
  }
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

export interface FrameLayout {
  screen: Rect;
  screenOpacity: number;
  camera: Rect | null;
  cameraOpacity: number;
  /** Camera drawn without frame and with its background removed (D01 cutout). */
  cameraCutout: boolean;
  kind: CameraLayoutKind;
}

/**
 * Static layout for each camera layout kind (D01). Rects are in output px.
 * The screen always keeps its source aspect (H05: re-fit when the output aspect changes). Screen-only,
 * overlay and cutout layouts put the screen in the card (cardRect); split / fullscreen camera own their slots.
 */
export function layoutFor(
  kind: CameraLayoutKind,
  out: { width: number; height: number },
  sourceAspect: number,
  cfg: ProjectConfig,
): FrameLayout {
  const short = Math.min(out.width, out.height);
  // a hidden backdrop has nothing to show around the recording: it fills the frame
  const pad = cfg.background.kind === "hidden" ? 0 : cfg.frame.padding * short;
  const area: Rect = { x: pad, y: pad, w: out.width - 2 * pad, h: out.height - 2 * pad };
  const card = cardRect(out, sourceAspect, cfg);
  const camSize = cfg.camera.size * short;
  const margin = Math.max(pad * 0.5, short * 0.03);
  const corner = (size: number): Rect => {
    const pos = cfg.camera.position;
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      // free position (on-canvas drag): centre in output fractions, kept inside the frame
      return { x: Math.min(out.width - size, Math.max(0, pos.x * out.width - size / 2)), y: Math.min(out.height - size, Math.max(0, pos.y * out.height - size / 2)), w: size, h: size };
    }
    const right = cfg.camera.corner.endsWith("right");
    const bottom = cfg.camera.corner.startsWith("bottom");
    return {
      x: right ? out.width - margin - size : margin,
      y: bottom ? out.height - margin - size : margin,
      w: size,
      h: size,
    };
  };
  switch (kind) {
    case "screen-only":
      return { screen: card, screenOpacity: 1, camera: null, cameraOpacity: 0, cameraCutout: false, kind };
    case "camera-overlay":
      return { screen: card, screenOpacity: 1, camera: corner(camSize), cameraOpacity: 1, cameraCutout: false, kind };
    case "camera-cutout": {
      const size = camSize * 1.5;
      return { screen: card, screenOpacity: 1, camera: corner(size), cameraOpacity: 1, cameraCutout: true, kind };
    }
    case "split": {
      const gap = short * 0.025;
      const landscape = out.width >= out.height;
      if (landscape) {
        const screenBox: Rect = { x: area.x, y: area.y, w: area.w * 0.66 - gap / 2, h: area.h };
        const camBox: Rect = { x: area.x + area.w * 0.66 + gap / 2, y: area.y, w: area.w * 0.34 - gap / 2, h: area.h };
        const screen = fitRect(screenBox, sourceAspect);
        const cam = { x: camBox.x, y: screen.y, w: camBox.w, h: screen.h };
        return { screen, screenOpacity: 1, camera: cam, cameraOpacity: 1, cameraCutout: false, kind };
      }
      const screenBox: Rect = { x: area.x, y: area.y, w: area.w, h: area.h * 0.5 - gap / 2 };
      const camBox: Rect = { x: area.x, y: area.y + area.h * 0.5 + gap / 2, w: area.w, h: area.h * 0.5 - gap / 2 };
      return { screen: fitRect(screenBox, sourceAspect), screenOpacity: 1, camera: camBox, cameraOpacity: 1, cameraCutout: false, kind };
    }
    case "fullscreen-camera":
      return { screen: fitRect(area, sourceAspect), screenOpacity: 0, camera: { ...area }, cameraOpacity: 1, cameraCutout: false, kind };
  }
}

function easeInOutCubic(u: number): number {
  const v = Math.min(1, Math.max(0, u));
  return v < 0.5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2;
}

function lerpRect(a: Rect, b: Rect, u: number): Rect {
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, w: a.w + (b.w - a.w) * u, h: a.h + (b.h - a.h) * u };
}

/** Layout at time t with animated transitions between layout segments. */
export function layoutAt(
  tMs: number,
  segments: CameraLayoutSegment[],
  out: { width: number; height: number },
  sourceAspect: number,
  cfg: ProjectConfig,
): FrameLayout {
  const defaultKind: CameraLayoutKind = cfg.camera.enabled ? "camera-overlay" : "screen-only";
  // "Show webcam" off hides the camera everywhere: layout segments (split, fullscreen camera, ...) only
  // apply while it is on, so the toggle works for projects that carry them too
  const sorted = cfg.camera.enabled ? [...segments].sort((a, b) => a.startMs - b.startMs) : [];
  const kindAt = (t: number): CameraLayoutKind => {
    let k: CameraLayoutKind = defaultKind;
    for (const s of sorted) if (t >= s.startMs && t < s.endMs) k = s.kind;
    return k;
  };
  const cur = kindAt(tMs);
  // Find the most recent boundary to animate from.
  let boundary = -Infinity;
  for (const s of sorted) {
    for (const b of [s.startMs, s.endMs]) if (b <= tMs && b > boundary) boundary = b;
  }
  const to = layoutFor(cur, out, sourceAspect, cfg);
  if (Number.isFinite(boundary) && (cfg.camera.enter || cfg.camera.exit)) {
    // webcam enter / exit animations (demand #14): only where the camera appears or leaves
    const pk = kindAt(boundary - 1);
    if (pk !== cur) {
      const fr = layoutFor(pk, out, sourceAspect, cfg);
      const anim = !fr.camera && to.camera ? cfg.camera.enter : fr.camera && !to.camera ? cfg.camera.exit : null;
      if (anim) return cameraEnterExit(fr, to, anim, tMs - boundary, out);
    }
  }
  if (!Number.isFinite(boundary) || tMs - boundary >= cfg.camera.transitionMs) return to;
  const prevKind = kindAt(boundary - 1);
  if (prevKind === cur) return to;
  const from = layoutFor(prevKind, out, sourceAspect, cfg);
  const u = easeInOutCubic((tMs - boundary) / cfg.camera.transitionMs);
  const camFrom = from.camera ?? (to.camera ? { x: to.camera.x + to.camera.w / 2, y: to.camera.y + to.camera.h / 2, w: 0, h: 0 } : null);
  const camTo = to.camera ?? (from.camera ? { x: from.camera.x + from.camera.w / 2, y: from.camera.y + from.camera.h / 2, w: 0, h: 0 } : null);
  return {
    screen: lerpRect(from.screen, to.screen, u),
    screenOpacity: from.screenOpacity + (to.screenOpacity - from.screenOpacity) * u,
    camera: camFrom && camTo ? lerpRect(camFrom, camTo, u) : null,
    cameraOpacity: from.cameraOpacity + (to.cameraOpacity - from.cameraOpacity) * u,
    cameraCutout: u < 0.5 ? from.cameraCutout : to.cameraCutout,
    kind: cur,
  };
}

/**
 * The layout `local` ms after the webcam appears (from has no camera) or leaves (to has none), animated
 * by the project's camera.enter / camera.exit: fade (opacity), pop (spring scale from 40% about the
 * centre), slide (in from / out to the nearest side edge), scale (grow from the centre with a fade, the
 * legacy look), none (instant). Exits run the same curve on the reversed clock.
 */
export function cameraEnterExit(from: FrameLayout, to: FrameLayout, anim: ElementAnim<CameraAnimKind>, local: number, out: { width: number; height: number }): FrameLayout {
  const ms = anim.kind === "none" ? 0 : Math.max(0, anim.ms);
  if (local >= ms) return to;
  const entering = !from.camera;
  const raw = Math.min(1, Math.max(0, local / ms));
  const u = ease("ease-in-out", raw);
  const cam = (entering ? to.camera : from.camera)!;
  const vis = ease(anim.easing ?? (anim.kind === "pop" ? "spring" : "ease-out"), entering ? raw : 1 - raw);
  const lin = entering ? raw : 1 - raw;
  let rect: Rect = { ...cam };
  let opacity = (entering ? to.cameraOpacity : from.cameraOpacity) || 1;
  switch (anim.kind) {
    case "fade":
      opacity *= vis;
      break;
    case "pop": {
      const k = 0.4 + 0.6 * vis;
      rect = { x: cam.x + (cam.w * (1 - k)) / 2, y: cam.y + (cam.h * (1 - k)) / 2, w: cam.w * k, h: cam.h * k };
      opacity *= Math.min(1, lin / 0.3);
      break;
    }
    case "slide": {
      const right = cam.x + cam.w / 2 >= out.width / 2;
      const off = right ? out.width - cam.x : -(cam.x + cam.w);
      rect = { ...cam, x: cam.x + off * (1 - vis) };
      break;
    }
    case "scale":
      rect = { x: cam.x + (cam.w * (1 - vis)) / 2, y: cam.y + (cam.h * (1 - vis)) / 2, w: cam.w * vis, h: cam.h * vis };
      opacity *= Math.min(1, Math.max(0, vis));
      break;
  }
  return {
    screen: lerpRect(from.screen, to.screen, u),
    screenOpacity: from.screenOpacity + (to.screenOpacity - from.screenOpacity) * u,
    camera: rect.w > 0.5 && rect.h > 0.5 ? rect : null,
    cameraOpacity: Math.max(0, Math.min(1, opacity)),
    cameraCutout: entering ? to.cameraCutout : from.cameraCutout,
    kind: to.kind,
  };
}

/** Overlay region in normalized viewport coords for smart framing (B05). */
export function overlayAvoidRect(layout: FrameLayout): Rect | null {
  if (!layout.camera || layout.cameraOpacity < 0.5) return null;
  const s = layout.screen;
  const c = layout.camera;
  const x0 = Math.max(s.x, c.x);
  const y0 = Math.max(s.y, c.y);
  const x1 = Math.min(s.x + s.w, c.x + c.w);
  const y1 = Math.min(s.y + s.h, c.y + c.h);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: (x0 - s.x) / s.w, y: (y0 - s.y) / s.h, w: (x1 - x0) / s.w, h: (y1 - y0) / s.h };
}

/**
 * Scale the webcam rect about its anchored corner (CAM-05). Only corner overlays shrink; split and
 * fullscreen layouts own their slot and are left alone.
 */
export function scaleCameraRect(layout: FrameLayout, factor: number, corner: ProjectConfig["camera"]["corner"], freeCamera = false): FrameLayout {
  if (!layout.camera || factor === 1 || (layout.kind !== "camera-overlay" && layout.kind !== "camera-cutout")) return layout;
  const c = layout.camera;
  const w = c.w * factor;
  const h = c.h * factor;
  const free = layout.kind === "camera-overlay" || layout.kind === "camera-cutout" ? freeCamera : false;
  const x = free ? c.x + (c.w - w) / 2 : corner.endsWith("right") ? c.x + c.w - w : c.x;
  const y = free ? c.y + (c.h - h) / 2 : corner.startsWith("bottom") ? c.y + c.h - h : c.y;
  return { ...layout, camera: { x, y, w, h } };
}

/**
 * Fill mode (output.fit = "fill", Windows bug #8): the screen rect that covers the whole output at the
 * source aspect, panned so source x `focusX` (in the current camera viewport [x0, x0 + vw]) sits at the
 * output centre, clamped so no background shows. Vertical pan likewise for outputs wider than the source.
 */
export function fillScreenRect(out: { width: number; height: number }, sourceAspect: number, view: { x0: number; vw: number; y0: number; vh: number }, focus: { x: number; y: number }): Rect {
  const W = out.width;
  const H = out.height;
  let w = H * sourceAspect;
  let h = H;
  if (w < W) {
    w = W;
    h = W / sourceAspect;
  }
  const kx = w / view.vw;
  const ky = h / view.vh;
  const x = Math.min(0, Math.max(W - w, W / 2 - (focus.x - view.x0) * kx));
  const y = Math.min(0, Math.max(H - h, H / 2 - (focus.y - view.y0) * ky));
  return { x, y, w, h };
}
