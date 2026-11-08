import type { CameraLayoutKind, CameraLayoutSegment, Rect } from "./types.js";
import type { ProjectConfig } from "./project.js";

/** Output pixel size for an aspect ratio. resolution is the short side (the height for 16:9). */
export function outputSize(aspect: string, resolution: number): { width: number; height: number } {
  const [aw, ah] = aspect.split(":").map(Number) as [number, number];
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  if (aw >= ah) return { width: even((resolution * aw) / ah), height: even(resolution) };
  return { width: even(resolution), height: even((resolution * ah) / aw) };
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
 * The screen always keeps its source aspect (H05: re-fit when the output aspect changes).
 */
export function layoutFor(
  kind: CameraLayoutKind,
  out: { width: number; height: number },
  sourceAspect: number,
  cfg: ProjectConfig,
): FrameLayout {
  const short = Math.min(out.width, out.height);
  const pad = cfg.frame.padding * short;
  const area: Rect = { x: pad, y: pad, w: out.width - 2 * pad, h: out.height - 2 * pad };
  const camSize = cfg.camera.size * short;
  const margin = Math.max(pad * 0.5, short * 0.03);
  const corner = (size: number): Rect => {
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
      return { screen: fitRect(area, sourceAspect), screenOpacity: 1, camera: null, cameraOpacity: 0, cameraCutout: false, kind };
    case "camera-overlay":
      return { screen: fitRect(area, sourceAspect), screenOpacity: 1, camera: corner(camSize), cameraOpacity: 1, cameraCutout: false, kind };
    case "camera-cutout": {
      const size = camSize * 1.5;
      return { screen: fitRect(area, sourceAspect), screenOpacity: 1, camera: corner(size), cameraOpacity: 1, cameraCutout: true, kind };
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
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs);
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
