/**
 * Annotations (demand #4): text, arrows, box / ellipse highlights, numbered step badges and callout
 * bubbles, plus full-frame text slides. Lens's own design (clean room, see docs/Annotations.md).
 *
 * Annotations are project data (`project.annotations`), never baked into the source footage. The
 * engine owns every decision: timing, in/out animation state (fade, spring pop, draw-on,
 * typewriter) and geometry, which it tessellates into a short list of drawing ops per frame
 * (filled polygons, stroked polylines, text boxes). Renderers (compositor/render.py and the
 * editor's Canvas2D renderer) only transform the points and draw the ops, so preview == export.
 *
 * Anchors:
 *  - "screen": geometry in source px (full recording, before crop). The renderer maps it through
 *    the virtual camera like a mask, so it follows zoom and pan, and draws it inside the screen
 *    (clipped by the rounded frame, under the cursor). Sizes scale with the zoom.
 *  - "frame": positions as fractions (0..1) of the output frame, sizes in px at 1080p (scaled with
 *    the output resolution like captions). Drawn as a fixed overlay above the webcam.
 */
import type { Rect, Vec2 } from "./types.js";
import { BUILTIN_PALETTE, DEFAULT_FONT, FONT_TOKEN, isColorValue, resolveColor, resolveFont, type Palette } from "./palette.js";

export type AnnotationKind = "text" | "arrow" | "rect" | "ellipse" | "badge" | "callout";
export type AnnotationAnchor = "screen" | "frame";
export type TextRole = "title" | "lower-third" | "label";
export type InAnimation = "none" | "fade" | "pop" | "draw" | "typewriter";
export type OutAnimation = "none" | "fade" | "pop" | "draw";
export type ArrowHead = "triangle" | "open" | "dot" | "none";

export interface AnnotationStyle {
  /**
   * Stroke / main colour: #rrggbb (an override on this item) or a theme slot ("@primary"), which
   * follows the preset palette and the brand kit (see palette.ts). The same holds for fill and textColor.
   */
  color: string;
  /** Fill colour of shapes, bubbles, badges and text backings; null = no fill. */
  fill: string | null;
  fillOpacity: number;
  /** Stroke width; source px (screen anchor) or px at 1080p (frame anchor). 0 = no stroke. */
  strokeWidth: number;
  fontSize: number;
  bold: boolean;
  textColor: string;
  /** Corner radius of rects, bubbles and text backings (same units as strokeWidth). */
  radius: number;
  shadow: { enabled: boolean; opacity: number; blur: number; offsetY: number };
  /** Overall opacity 0..1. */
  opacity: number;
  /** Font family, or "@font" (the theme font; the default). */
  font?: string;
}

export interface AnimationSpec<K> {
  kind: K;
  ms: number;
}

export interface Annotation {
  id: string;
  kind: AnnotationKind;
  /** Source time (recording ms), like masks and zoom blocks. */
  startMs: number;
  endMs: number;
  anchor: AnnotationAnchor;
  /** rect / ellipse / callout bubble / text box (w = wrap width, h = 0 for auto height). */
  rect?: Rect;
  /** arrow tail and head; callout pointer tip in `to`. */
  from?: Vec2;
  to?: Vec2;
  /** Arrow bend: control-point offset as a fraction of the arrow's length, sign = side. */
  curve?: number;
  head?: ArrowHead;
  tail?: ArrowHead;
  /** badge centre */
  at?: Vec2;
  /** badge radius (same units as strokeWidth) */
  size?: number;
  /** badge number; null / undefined = numbered automatically by start time among auto badges */
  number?: number | null;
  /** text of text / callout items, and the label pill next to a badge */
  text?: string;
  role?: TextRole;
  align?: "left" | "center" | "right";
  in: AnimationSpec<InAnimation>;
  out: AnimationSpec<OutAnimation>;
  style: AnnotationStyle;
  /** Set on badges created from an accepted step-label draft (stepLabels.drafts[].id). */
  stepId?: string;
}

/** A full-frame title card inserted into the output at a source time, with its own duration. */
export interface TextSlide {
  id: string;
  /** Source time (recording ms) the slide is inserted before; inside a cut it lands where the cut is. */
  atMs: number;
  durationMs: number;
  title: string;
  subtitle: string;
  background: string;
  textColor: string;
  /** Short accent bar under the title; null = none. */
  accent: string | null;
  /** Cross-fade with the video at both ends (ms, inside durationMs). */
  fadeMs: number;
  /** px at 1080p */
  titleSize: number;
  subtitleSize: number;
  /** Font family or "@font" (default). */
  font?: string;
  /** solid = the background colour; theme = the project backdrop (brand intro / outro cards). */
  fill?: "solid" | "theme";
  /** A logo above the title (brand cards): image path relative to the bundle and its width / height. */
  logo?: { path: string; aspect: number } | null;
}

/** One auto step-label draft: a click, the text read around it, and its review state. */
export interface StepDraft {
  id: string;
  /** Click time and point (source ms / source px). */
  clickMs: number;
  x: number;
  y: number;
  /** Draft label ("Click Save"), editable in the review list. */
  label: string;
  /** The control text OCR read near the click (empty when nothing was read). */
  target: string;
  verb: string;
  confidence: number;
  state: "pending" | "accepted" | "dismissed";
  /** The clicked control's box in source px (the read text padded to roughly a button), when one was found. */
  box?: { x: number; y: number; w: number; h: number } | null;
}

export interface StepLabelSettings {
  drafts: StepDraft[];
  generatedAt: string | null;
}

// ------------------------------------------------------------------------------ drawing ops

export type AnnOp =
  | { op: "fill"; pts: number[]; color: string; alpha: number }
  | { op: "stroke"; pts: number[]; closed: boolean; width: number; color: string; alpha: number }
  | {
      op: "text";
      text: string;
      /** Box: x, y top-left; w = wrap width (0 = no wrap, x is then the anchor of `align`); h = box height (0 = auto). */
      x: number;
      y: number;
      w: number;
      h: number;
      size: number;
      bold: boolean;
      color: string;
      align: "left" | "center" | "right";
      valign: "top" | "middle";
      /** Visible characters (typewriter); -1 = all. Layout always uses the full text. */
      chars: number;
      bg: { color: string; alpha: number; padX: number; padY: number; radius: number } | null;
      /** Font family; absent = the default (DejaVu Sans). */
      font?: string;
    }
  /** An image (logo) in a box, whole px, with alpha. */
  | { op: "image"; path: string; x: number; y: number; w: number; h: number; alpha: number }
  /** Paint the plan's backdrop (style.background) over the whole frame. */
  | { op: "background" };

export interface AnnFrame {
  id: string;
  kind: AnnotationKind;
  space: AnnotationAnchor;
  opacity: number;
  /** [opacity, blur (gaussian sigma x2), dx, dy] in the space's units; null = no shadow. */
  shadow: [number, number, number, number] | null;
  ops: AnnOp[];
  /** Animation state (for the editor and tests): path fraction drawn, pop scale, visible chars (-1 all). */
  anim: { draw: number; scale: number; chars: number };
}

export interface SlideFrame {
  id: string;
  opacity: number;
  ops: AnnOp[];
}

// ------------------------------------------------------------------------------ animation curves

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function easeOutCubic(u: number): number {
  const v = clamp01(u);
  return 1 - (1 - v) ** 3;
}

export function easeInOutCubic(u: number): number {
  const v = clamp01(u);
  return v < 0.5 ? 4 * v * v * v : 1 - (-2 * v + 2) ** 3 / 2;
}

/** Damping ratio and natural frequency (per unit of animation time) of the pop spring. */
export const POP_ZETA = 0.5;
export const POP_OMEGA = 9;

/**
 * Pop: an underdamped spring step response from 0 to 1 over the animation time (u = 0..1), with
 * one visible overshoot (~16% at zeta 0.5). Exactly 1 from u = 1 on, so the item rests at size.
 */
export function popSpring(u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const z = POP_ZETA;
  const w = POP_OMEGA;
  const wd = w * Math.sqrt(1 - z * z);
  const e = Math.exp(-z * w * u);
  const x = 1 - e * (Math.cos(wd * u) + (z / Math.sqrt(1 - z * z)) * Math.sin(wd * u));
  // remove the residual at u = 1 smoothly so the curve lands on exactly 1
  const r = 1 - (1 - Math.exp(-z * w) * (Math.cos(wd) + (z / Math.sqrt(1 - z * z)) * Math.sin(wd)));
  return x + r * u * u;
}

/** Pop scale: grows from 40% with the spring's overshoot. */
export function popScale(u: number): number {
  return 0.4 + 0.6 * popSpring(u);
}

export interface AnimState {
  opacity: number;
  scale: number;
  draw: number;
  /** fraction of characters shown (1 = all) */
  type: number;
}

/**
 * Animation state of an item at source time t: in-animation over [start, start + in.ms], out over
 * [end - out.ms, end] (both shortened to half the item's life when it is short). Draw-on of an
 * outline also fades its fill in; typewriter of a non-text item falls back to fade.
 */
export function animState(a: Pick<Annotation, "startMs" | "endMs" | "in" | "out">, t: number): AnimState | null {
  if (t < a.startMs || t >= a.endMs) return null;
  const life = a.endMs - a.startMs;
  const inMs = a.in.kind === "none" ? 0 : Math.max(0, Math.min(a.in.ms, life / 2));
  const outMs = a.out.kind === "none" ? 0 : Math.max(0, Math.min(a.out.ms, life / 2));
  const s: AnimState = { opacity: 1, scale: 1, draw: 1, type: 1 };
  const apply = (kind: InAnimation | OutAnimation, u: number) => {
    switch (kind) {
      case "fade":
        s.opacity *= easeOutCubic(u);
        break;
      case "pop":
        s.scale *= popScale(u);
        s.opacity *= clamp01(u / 0.3);
        break;
      case "draw":
        s.draw = Math.min(s.draw, easeInOutCubic(u));
        break;
      case "typewriter":
        s.type = Math.min(s.type, clamp01(u));
        break;
    }
  };
  if (inMs > 0 && t < a.startMs + inMs) apply(a.in.kind, (t - a.startMs) / inMs);
  if (outMs > 0 && t > a.endMs - outMs) apply(a.out.kind, (a.endMs - t) / outMs);
  return s;
}

// ------------------------------------------------------------------------------ geometry

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

function flat(pts: Vec2[]): number[] {
  const out: number[] = [];
  for (const p of pts) out.push(r2(p.x), r2(p.y));
  return out;
}

/** Quadratic arrow path from -> to, bent by `curve` (fraction of length, sign = side). */
export function arrowPath(from: Vec2, to: Vec2, curve = 0, n = 48): Vec2[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const cx = (from.x + to.x) / 2 + (-dy / len) * curve * len;
  const cy = (from.y + to.y) / 2 + (dx / len) * curve * len;
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const a = (1 - u) * (1 - u);
    const b = 2 * (1 - u) * u;
    const c = u * u;
    pts.push({ x: a * from.x + b * cx + c * to.x, y: a * from.y + b * cy + c * to.y });
  }
  return pts;
}

export function pathLength(pts: Vec2[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  return s;
}

/** The first `len` units of a polyline (by arc length). */
export function truncatePath(pts: Vec2[], len: number): Vec2[] {
  if (pts.length < 2) return pts.slice();
  if (len <= 0) return [pts[0]!];
  const out: Vec2[] = [pts[0]!];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (acc + d >= len) {
      const u = d > 0 ? (len - acc) / d : 0;
      out.push({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
      return out;
    }
    acc += d;
    out.push(b);
  }
  return out;
}

/** Closed polygon of an ellipse inscribed in r, starting at the top, clockwise (screen y down). */
export function ellipsePoints(r: Rect, n = 96): Vec2[] {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    out.push({ x: cx + (r.w / 2) * Math.cos(a), y: cy + (r.h / 2) * Math.sin(a) });
  }
  return out;
}

type Side = "top" | "right" | "bottom" | "left";

/**
 * Closed polygon of a rounded rect, clockwise, starting at the end of the top-left corner.
 * `notch` inserts a callout pointer (base centre along a side, base width, tip) into that side.
 */
export function roundRectPoints(r: Rect, radius: number, notch?: { side: Side; at: number; width: number; tip: Vec2 }): Vec2[] {
  const rr = Math.max(0, Math.min(radius, r.w / 2, r.h / 2));
  const seg = rr > 0 ? 8 : 0;
  const out: Vec2[] = [];
  const x0 = r.x;
  const y0 = r.y;
  const x1 = r.x + r.w;
  const y1 = r.y + r.h;
  const edge = (side: Side, a: Vec2, b: Vec2) => {
    out.push(a);
    if (notch && notch.side === side) {
      const horiz = side === "top" || side === "bottom";
      const dir = horiz ? Math.sign(b.x - a.x) : Math.sign(b.y - a.y);
      const h = notch.width / 2;
      if (horiz) out.push({ x: notch.at - dir * h, y: a.y }, notch.tip, { x: notch.at + dir * h, y: a.y });
      else out.push({ x: a.x, y: notch.at - dir * h }, notch.tip, { x: a.x, y: notch.at + dir * h });
    }
    out.push(b);
  };
  const arc = (cx: number, cy: number, a0: number) => {
    for (let i = 1; i < seg; i++) {
      const a = a0 + (i / seg) * (Math.PI / 2);
      out.push({ x: cx + rr * Math.cos(a), y: cy + rr * Math.sin(a) });
    }
  };
  edge("top", { x: x0 + rr, y: y0 }, { x: x1 - rr, y: y0 });
  arc(x1 - rr, y0 + rr, -Math.PI / 2);
  edge("right", { x: x1, y: y0 + rr }, { x: x1, y: y1 - rr });
  arc(x1 - rr, y1 - rr, 0);
  edge("bottom", { x: x1 - rr, y: y1 }, { x: x0 + rr, y: y1 });
  arc(x0 + rr, y1 - rr, Math.PI / 2);
  edge("left", { x: x0, y: y1 - rr }, { x: x0, y: y0 + rr });
  arc(x0 + rr, y0 + rr, Math.PI);
  const ded = out.filter((p, i) => i === 0 || Math.abs(p.x - out[i - 1]!.x) > 1e-9 || Math.abs(p.y - out[i - 1]!.y) > 1e-9);
  const f = ded[0]!;
  const l = ded[ded.length - 1]!;
  if (ded.length > 1 && Math.abs(f.x - l.x) < 1e-9 && Math.abs(f.y - l.y) < 1e-9) ded.pop();
  return ded;
}

/** Where a callout's pointer leaves its bubble: the side facing the tip, the base centre clamped clear of the corners. */
export function calloutNotch(r: Rect, radius: number, tip: Vec2, baseWidth: number): { side: Side; at: number; width: number; tip: Vec2 } | undefined {
  const inside = tip.x > r.x && tip.x < r.x + r.w && tip.y > r.y && tip.y < r.y + r.h;
  if (inside) return undefined;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const dx = tip.x - cx;
  const dy = tip.y - cy;
  // which side the ray from the centre exits through (normalised by the box's half sizes)
  const side: Side = Math.abs(dx) / (r.w / 2) > Math.abs(dy) / (r.h / 2) ? (dx > 0 ? "right" : "left") : dy > 0 ? "bottom" : "top";
  const rr = Math.max(0, Math.min(radius, r.w / 2, r.h / 2));
  const horiz = side === "top" || side === "bottom";
  const len = horiz ? r.w : r.h;
  const w = Math.max(2, Math.min(baseWidth, len - 2 * rr - 2));
  const lo = (horiz ? r.x : r.y) + rr + w / 2 + 1;
  const hi = (horiz ? r.x + r.w : r.y + r.h) - rr - w / 2 - 1;
  const ideal = horiz ? cx + dx * ((r.h / 2) / Math.max(1e-6, Math.abs(dy))) : cy + dy * ((r.w / 2) / Math.max(1e-6, Math.abs(dx)));
  const at = lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, ideal));
  return { side, at, width: w, tip };
}

function scalePts(pts: Vec2[], pivot: Vec2, s: number): Vec2[] {
  if (s === 1) return pts;
  return pts.map((p) => ({ x: pivot.x + (p.x - pivot.x) * s, y: pivot.y + (p.y - pivot.y) * s }));
}

/** Arrow head polygon(s) at tip pointing along unit tangent (ux, uy). */
function headOps(kind: ArrowHead, tip: Vec2, ux: number, uy: number, len: number, width: number, color: string, alpha: number): AnnOp[] {
  if (kind === "none" || len <= 0) return [];
  const bx = tip.x - ux * len;
  const by = tip.y - uy * len;
  const px = -uy * (width / 2);
  const py = ux * (width / 2);
  if (kind === "triangle") return [{ op: "fill", pts: flat([tip, { x: bx + px, y: by + py }, { x: bx - px, y: by - py }]), color, alpha }];
  if (kind === "open") {
    const sw = Math.max(1, len * 0.22);
    return [{ op: "stroke", pts: flat([{ x: bx + px, y: by + py }, tip, { x: bx - px, y: by - py }]), closed: false, width: sw, color, alpha }];
  }
  // dot
  const c = { x: tip.x - ux * (len / 2), y: tip.y - uy * (len / 2) };
  return [{ op: "fill", pts: flat(ellipsePoints({ x: c.x - len / 2, y: c.y - len / 2, w: len, h: len }, 32)), color, alpha }];
}

export const ANNOTATION_KINDS: AnnotationKind[] = ["text", "arrow", "rect", "ellipse", "badge", "callout"];

/** Badge numbers: explicit numbers stay; auto badges (number null/undefined) count 1, 2, 3 by start time. */
export function badgeNumbers(items: Annotation[]): Map<string, number> {
  const auto = items.filter((a) => a.kind === "badge" && (a.number === null || a.number === undefined));
  auto.sort((a, b) => a.startMs - b.startMs || (a.stepId ?? a.id).localeCompare(b.stepId ?? b.id));
  const m = new Map<string, number>();
  auto.forEach((a, i) => m.set(a.id, i + 1));
  for (const a of items) if (a.kind === "badge" && typeof a.number === "number") m.set(a.id, a.number);
  return m;
}

export interface AnnotationSpace {
  /** Source crop offset (screen anchor coordinates are given in full-source px). */
  cropX: number;
  cropY: number;
  /** Output size and the 1080p size scale (frame anchor). */
  width: number;
  height: number;
  resScale: number;
  /** Resolved theme palette for "@slot" colours and "@font" (default: the built-in palette). */
  palette?: Palette;
}

/** The style with theme references resolved to literal colours. */
export function themedStyle(s: AnnotationStyle, pal: Palette = BUILTIN_PALETTE): AnnotationStyle {
  return { ...s, color: resolveColor(s.color, pal), textColor: resolveColor(s.textColor, pal), fill: s.fill === null ? null : resolveColor(s.fill, pal), font: resolveFont(s.font, pal) };
}

/** Text-op font field: omitted for the default font so pre-#9 plans stay byte-identical. */
function fontField(family: string | undefined): { font?: string } {
  return family && family !== DEFAULT_FONT ? { font: family } : {};
}

/**
 * The drawing ops of one annotation at source time t (null when it is not on screen). Coordinates
 * are cropped source px (screen anchor) or output px (frame anchor).
 */
export function annotationFrame(a: Annotation, t: number, sp: AnnotationSpace, numbers: Map<string, number>): AnnFrame | null {
  const st = animState(a, t);
  if (!st) return null;
  const opacity = st.opacity * clamp01(a.style.opacity);
  if (opacity <= 0.001) return null;
  const screen = a.anchor === "screen";
  const k = screen ? 1 : sp.resScale;
  const P = (v: Vec2): Vec2 => (screen ? { x: v.x - sp.cropX, y: v.y - sp.cropY } : { x: v.x * sp.width, y: v.y * sp.height });
  const R = (r: Rect): Rect => {
    const p = P({ x: r.x, y: r.y });
    return screen ? { x: p.x, y: p.y, w: r.w, h: r.h } : { x: p.x, y: p.y, w: r.w * sp.width, h: r.h * sp.height };
  };
  const s = themedStyle(a.style, sp.palette);
  const F = fontField(s.font);
  const sw = Math.max(0, s.strokeWidth * k);
  const font = s.fontSize * k;
  const radius = s.radius * k;
  const ops: AnnOp[] = [];
  const fillA = s.fill ? clamp01(s.fillOpacity) : 0;
  const chars = st.type >= 1 ? -1 : Math.floor(st.type * (a.text ?? "").length + 1e-9);
  let pivot: Vec2 = { x: 0, y: 0 };

  switch (a.kind) {
    case "arrow": {
      const from = P(a.from ?? { x: 0, y: 0 });
      const to = P(a.to ?? { x: 0, y: 0 });
      pivot = from;
      const path = arrowPath(from, to, a.curve ?? 0);
      const L = pathLength(path);
      const vis = truncatePath(path, L * st.draw);
      const tip = vis[vis.length - 1]!;
      // tangent at the visible end
      const prev = truncatePath(path, Math.max(0, L * st.draw - Math.max(1, L / 48)));
      const q = prev[prev.length - 1]!;
      let ux = tip.x - q.x;
      let uy = tip.y - q.y;
      const ul = Math.hypot(ux, uy);
      if (ul < 1e-6) {
        ux = (path[1]!.x - path[0]!.x) || 1;
        uy = path[1]!.y - path[0]!.y;
      }
      const ulen = Math.hypot(ux, uy) || 1;
      ux /= ulen;
      uy /= ulen;
      const head = a.head ?? "triangle";
      const hl = Math.max(8 * k, sw * 3.4) * Math.min(1, (L * st.draw) / Math.max(1, Math.max(8 * k, sw * 3.4) * 1.5));
      // the shaft stops inside the head so its round cap does not poke through the point
      const shaftLen = Math.max(0, L * st.draw - (head === "triangle" ? hl * 0.7 : head === "dot" ? hl * 0.5 : 0));
      const shaft = truncatePath(path, shaftLen);
      if (shaft.length >= 2 && sw > 0) ops.push({ op: "stroke", pts: flat(shaft), closed: false, width: r2(sw), color: s.color, alpha: 1 });
      const tail = a.tail ?? "none";
      if (tail !== "none" && st.draw > 0) {
        const t0 = path[0]!;
        const t1 = path[Math.min(2, path.length - 1)]!;
        const tl = Math.hypot(t1.x - t0.x, t1.y - t0.y) || 1;
        ops.push(...headOps(tail, t0, (t0.x - t1.x) / tl, (t0.y - t1.y) / tl, hl, hl * 0.95, s.color, 1));
      }
      if (st.draw > 0) ops.push(...headOps(head, tip, ux, uy, hl, hl * 0.95, s.color, 1));
      break;
    }
    case "rect":
    case "ellipse": {
      const r = R(a.rect ?? { x: 0, y: 0, w: 10, h: 10 });
      pivot = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
      const poly = a.kind === "ellipse" ? ellipsePoints(r) : roundRectPoints(r, radius);
      if (fillA > 0 && s.fill) ops.push({ op: "fill", pts: flat(poly), color: s.fill, alpha: r4(fillA * st.draw) });
      if (sw > 0) {
        if (st.draw >= 1) ops.push({ op: "stroke", pts: flat(poly), closed: true, width: r2(sw), color: s.color, alpha: 1 });
        else if (st.draw > 0) {
          const ring = [...poly, poly[0]!];
          ops.push({ op: "stroke", pts: flat(truncatePath(ring, pathLength(ring) * st.draw)), closed: false, width: r2(sw), color: s.color, alpha: 1 });
        }
      }
      break;
    }
    case "badge": {
      const c = P(a.at ?? { x: 0, y: 0 });
      pivot = c;
      const rad = (a.size ?? 18) * k;
      const circle = ellipsePoints({ x: c.x - rad, y: c.y - rad, w: rad * 2, h: rad * 2 }, 48);
      ops.push({ op: "fill", pts: flat(circle), color: s.fill ?? s.color, alpha: s.fill ? r4(clamp01(s.fillOpacity)) : 1 });
      if (sw > 0) ops.push({ op: "stroke", pts: flat(circle), closed: true, width: r2(sw), color: s.color, alpha: 1 });
      const n = numbers.get(a.id) ?? 1;
      ops.push({ op: "text", text: String(n), x: r2(c.x), y: r2(c.y), w: 0, h: 0, size: r2(rad * 1.05), bold: true, color: s.textColor, align: "center", valign: "middle", chars: -1, bg: null, ...F });
      if (a.text) {
        ops.push({
          op: "text", text: a.text, x: r2(c.x + rad + rad * 0.55 + font * 0.5), y: r2(c.y), w: 0, h: 0, size: r2(font), bold: s.bold, color: s.textColor,
          align: "left", valign: "middle", chars, bg: { color: s.fill ?? s.color, alpha: 0.92, padX: r2(font * 0.5), padY: r2(font * 0.28), radius: r2(font * 0.45) }, ...F,
        });
      }
      break;
    }
    case "callout": {
      const r = R(a.rect ?? { x: 0, y: 0, w: 10, h: 10 });
      pivot = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
      const tip = a.to ? P(a.to) : null;
      const notch = tip ? calloutNotch(r, radius, tip, Math.max(12 * k, Math.min(r.w, r.h) * 0.35)) : undefined;
      const poly = roundRectPoints(r, radius, notch);
      if (s.fill) ops.push({ op: "fill", pts: flat(poly), color: s.fill, alpha: r4(clamp01(s.fillOpacity) * st.draw) });
      if (sw > 0) {
        if (st.draw >= 1) ops.push({ op: "stroke", pts: flat(poly), closed: true, width: r2(sw), color: s.color, alpha: 1 });
        else if (st.draw > 0) {
          const ring = [...poly, poly[0]!];
          ops.push({ op: "stroke", pts: flat(truncatePath(ring, pathLength(ring) * st.draw)), closed: false, width: r2(sw), color: s.color, alpha: 1 });
        }
      }
      if (a.text) {
        const pad = font * 0.6;
        ops.push({ op: "text", text: a.text, x: r2(r.x + pad), y: r2(r.y + r.h / 2), w: r2(Math.max(1, r.w - 2 * pad)), h: 0, size: r2(font), bold: s.bold,
          color: s.textColor, align: a.align ?? "left", valign: "middle", chars, bg: null, ...F });
      }
      break;
    }
    case "text": {
      const r = R(a.rect ?? { x: 0.1, y: 0.1, w: 0, h: 0 });
      const pad = { padX: font * 0.5, padY: font * 0.25 };
      const align = a.align ?? "left";
      pivot = { x: r.x + (align === "center" ? r.w / 2 : align === "right" ? r.w : 0), y: r.y };
      const bg = s.fill ? { color: s.fill, alpha: r4(clamp01(s.fillOpacity)), padX: r2(pad.padX), padY: r2(pad.padY), radius: r2(radius) } : null;
      // lower-third: an accent bar to the left of the text
      if (a.role === "lower-third" && sw > 0) {
        const bar = { x: r.x - pad.padX - sw * 2.2, y: r.y - pad.padY, w: sw, h: font * 1.25 + pad.padY * 2 };
        ops.push({ op: "fill", pts: flat(roundRectPoints(bar, sw / 2)), color: s.color, alpha: 1 });
      }
      ops.push({ op: "text", text: a.text ?? "", x: r2(r.x), y: r2(r.y), w: r2(r.w), h: 0, size: r2(font), bold: s.bold, color: s.textColor, align, valign: "top", chars, bg, ...F });
      break;
    }
  }

  const sc = st.scale;
  const out = sc === 1 ? ops : ops.map((o) => scaleOp(o, pivot, sc));
  const sh = s.shadow.enabled && s.shadow.opacity > 0 ? ([r4(clamp01(s.shadow.opacity)), r2(s.shadow.blur * k * sc), 0, r2(s.shadow.offsetY * k * sc)] as [number, number, number, number]) : null;
  return { id: a.id, kind: a.kind, space: a.anchor, opacity: r4(opacity), shadow: sh, ops: out, anim: { draw: r4(st.draw), scale: r4(sc), chars } };
}

function scaleOp(o: AnnOp, pv: Vec2, s: number): AnnOp {
  const sp = (pts: number[]) => pts.map((v, i) => r2(i % 2 === 0 ? pv.x + (v - pv.x) * s : pv.y + (v - pv.y) * s));
  if (o.op === "fill") return { ...o, pts: sp(o.pts) };
  if (o.op === "stroke") return { ...o, pts: sp(o.pts), width: r2(o.width * s) };
  if (o.op === "image" || o.op === "background") return o;
  return {
    ...o,
    x: r2(pv.x + (o.x - pv.x) * s),
    y: r2(pv.y + (o.y - pv.y) * s),
    w: r2(o.w * s),
    h: r2(o.h * s),
    size: r2(o.size * s),
    bg: o.bg ? { ...o.bg, padX: r2(o.bg.padX * s), padY: r2(o.bg.padY * s), radius: r2(o.bg.radius * s) } : null,
  };
}

/** Every annotation on screen at source time t, in list order (later items draw on top). */
export function annotationsAt(items: Annotation[], t: number, sp: AnnotationSpace, numbers = badgeNumbers(items)): AnnFrame[] {
  const out: AnnFrame[] = [];
  for (const a of items) {
    const f = annotationFrame(a, t, sp, numbers);
    if (f) out.push(f);
  }
  return out;
}

/** The slide drawn at output time t inside its span (output px). Theme references resolve against `pal`. */
export function slideFrame(sl: TextSlide, tInSlide: number, W: number, H: number, resScale: number, pal: Palette = BUILTIN_PALETTE): SlideFrame {
  const fade = Math.max(0, Math.min(sl.fadeMs, sl.durationMs / 2));
  const op = fade > 0 ? Math.min(easeOutCubic(tInSlide / fade), easeOutCubic((sl.durationMs - tInSlide) / fade)) : 1;
  const ts = sl.titleSize * resScale;
  const ss = sl.subtitleSize * resScale;
  const F = fontField(resolveFont(sl.font, pal));
  const textColor = resolveColor(sl.textColor, pal);
  const ops: AnnOp[] = [sl.fill === "theme" ? { op: "background" } : { op: "fill", pts: [0, 0, W, 0, W, H, 0, H], color: resolveColor(sl.background, pal), alpha: 1 }];
  const hasSub = !!sl.subtitle.trim();
  // with a subtitle: title above the centre, accent bar under the title's descenders, subtitle below
  const titleY = hasSub ? H * 0.5 - ts * 0.45 : H * 0.5;
  if (sl.logo && sl.logo.path) {
    // logo centred above the title, whole pixels so preview and export sample it identically
    const lh = Math.round(Math.min(H * 0.16, W * 0.16 / Math.max(0.05, sl.logo.aspect)));
    const lw = Math.round(lh * sl.logo.aspect);
    const ly = Math.round(titleY - ts * 0.75 - lh - H * 0.03);
    ops.push({ op: "image", path: sl.logo.path, x: Math.round(W / 2 - lw / 2), y: ly, w: lw, h: lh, alpha: 1 });
  }
  ops.push({ op: "text", text: sl.title, x: r2(W * 0.1), y: r2(titleY), w: r2(W * 0.8), h: 0, size: r2(ts), bold: true, color: textColor, align: "center", valign: "middle", chars: -1, bg: null, ...F });
  if (sl.accent) {
    const bw = ts * 1.6;
    const bh = Math.max(3, ts * 0.09);
    const by = hasSub ? titleY + ts * 0.7 : H * 0.5 + ts * 0.85;
    ops.push({ op: "fill", pts: flat(roundRectPoints({ x: W / 2 - bw / 2, y: by, w: bw, h: bh }, bh / 2)), color: resolveColor(sl.accent, pal), alpha: 1 });
  }
  if (hasSub) ops.push({ op: "text", text: sl.subtitle, x: r2(W * 0.12), y: r2(titleY + ts * 0.7 + Math.max(3, ts * 0.09) + ss * 1.05), w: r2(W * 0.76), h: 0, size: r2(ss), bold: false, color: textColor, align: "center", valign: "middle", chars: -1, bg: null, ...F });
  return { id: sl.id, opacity: r4(op), ops };
}

// ------------------------------------------------------------------------------ defaults + presets

export function defaultAnnotationStyle(kind: AnnotationKind, anchor: AnnotationAnchor = "screen"): AnnotationStyle {
  // "@primary" resolves to #ff5a36 with the built-in palette: the same pixels as before presets
  const base: AnnotationStyle = {
    color: "@primary",
    fill: null,
    fillOpacity: 0.18,
    strokeWidth: 5,
    fontSize: 26,
    bold: true,
    textColor: "#ffffff",
    radius: 10,
    shadow: { enabled: true, opacity: 0.35, blur: 10, offsetY: 3 },
    opacity: 1,
  };
  switch (kind) {
    case "rect":
    case "ellipse":
      return { ...base, fill: "@primary", fillOpacity: 0.12, shadow: { ...base.shadow, enabled: false } };
    case "badge":
      return { ...base, fill: "@primary", fillOpacity: 1, strokeWidth: 3, color: "#ffffff", fontSize: 22, radius: 10 };
    case "callout":
      return { ...base, fill: "#1f2433", fillOpacity: 0.95, strokeWidth: 0, color: "#1f2433", fontSize: anchor === "frame" ? 34 : 22, radius: 14 };
    case "text":
      return { ...base, fill: "#11131a", fillOpacity: 0.72, strokeWidth: 0, fontSize: anchor === "frame" ? 44 : 24, radius: 10 };
    default:
      return base;
  }
}

/** Starting values for a text item by role (title, lower-third, label). */
export function textPreset(role: TextRole): Pick<Annotation, "anchor" | "rect" | "align" | "role" | "in" | "out"> & { style: Partial<AnnotationStyle> } {
  switch (role) {
    case "title":
      return { anchor: "frame", role, rect: { x: 0.1, y: 0.08, w: 0.8, h: 0 }, align: "center", in: { kind: "pop", ms: 450 }, out: { kind: "fade", ms: 300 },
        style: { fontSize: 64, fill: "#11131a", fillOpacity: 0.7, radius: 16 } };
    case "lower-third":
      return { anchor: "frame", role, rect: { x: 0.08, y: 0.76, w: 0.6, h: 0 }, align: "left", in: { kind: "typewriter", ms: 700 }, out: { kind: "fade", ms: 300 },
        style: { fontSize: 40, fill: "#11131a", fillOpacity: 0.78, strokeWidth: 8, color: "@primary", radius: 8 } };
    default:
      return { anchor: "screen", role, rect: { x: 0, y: 0, w: 0, h: 0 }, align: "left", in: { kind: "fade", ms: 250 }, out: { kind: "fade", ms: 250 },
        style: { fontSize: 24, fill: "#11131a", fillOpacity: 0.72, radius: 8 } };
  }
}

export function defaultAnimations(kind: AnnotationKind): Pick<Annotation, "in" | "out"> {
  switch (kind) {
    case "arrow":
      return { in: { kind: "draw", ms: 500 }, out: { kind: "fade", ms: 250 } };
    case "rect":
    case "ellipse":
      return { in: { kind: "draw", ms: 450 }, out: { kind: "fade", ms: 250 } };
    case "badge":
      return { in: { kind: "pop", ms: 450 }, out: { kind: "fade", ms: 250 } };
    case "callout":
      return { in: { kind: "pop", ms: 400 }, out: { kind: "fade", ms: 250 } };
    default:
      return { in: { kind: "fade", ms: 250 }, out: { kind: "fade", ms: 250 } };
  }
}

export function defaultSlide(id: string, atMs: number): TextSlide {
  return { id, atMs, durationMs: 2000, title: "Title", subtitle: "", background: "#11131a", textColor: "#ffffff", accent: "@primary", fadeMs: 250, titleSize: 84, subtitleSize: 40 };
}

/** Fill in missing fields of a partial annotation (project.json written by hand, or old projects). */
export function normalizeAnnotation(raw: Partial<Annotation> & { kind: AnnotationKind; id: string }): Annotation {
  const anchor = raw.anchor ?? (raw.kind === "text" && (raw.role === "title" || raw.role === "lower-third") ? "frame" : "screen");
  const anims = defaultAnimations(raw.kind);
  const st = defaultAnnotationStyle(raw.kind, anchor);
  return {
    ...raw,
    id: raw.id,
    kind: raw.kind,
    startMs: raw.startMs ?? 0,
    endMs: raw.endMs ?? (raw.startMs ?? 0) + 3000,
    anchor,
    in: { ...anims.in, ...(raw.in ?? {}) },
    out: { ...anims.out, ...(raw.out ?? {}) },
    style: { ...st, ...(raw.style ?? {}), shadow: { ...st.shadow, ...(raw.style?.shadow ?? {}) } },
  };
}

export function normalizeSlide(raw: Partial<TextSlide> & { id: string }): TextSlide {
  return { ...defaultSlide(raw.id, raw.atMs ?? 0), ...raw };
}

const IN_KINDS: InAnimation[] = ["none", "fade", "pop", "draw", "typewriter"];
const OUT_KINDS: OutAnimation[] = ["none", "fade", "pop", "draw"];

/** Validation errors for annotations, slides and step drafts (empty when valid). */
export function validateAnnotations(items: Annotation[], slides: TextSlide[], steps: StepLabelSettings): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  const fin = (...v: unknown[]) => v.every((x) => typeof x === "number" && Number.isFinite(x));
  if (!Array.isArray(items)) return ["annotations must be a list"];
  for (const a of items) {
    const n = `annotation ${String(a?.id)}`;
    if (!a || typeof a.id !== "string") {
      errs.push("annotation without an id");
      continue;
    }
    if (ids.has(a.id)) errs.push(`${n} is listed twice`);
    ids.add(a.id);
    if (!ANNOTATION_KINDS.includes(a.kind)) errs.push(`${n} has unknown kind ${String(a.kind)}`);
    if (!(a.endMs > a.startMs)) errs.push(`${n} ends before it starts`);
    if (a.anchor !== "screen" && a.anchor !== "frame") errs.push(`${n} anchor must be screen or frame`);
    if (!IN_KINDS.includes(a.in?.kind) || !(a.in.ms >= 0)) errs.push(`${n} has an invalid in-animation`);
    if (!OUT_KINDS.includes(a.out?.kind) || !(a.out.ms >= 0)) errs.push(`${n} has an invalid out-animation`);
    const s = a.style;
    if (!s || !isColorValue(s.color) || !isColorValue(s.textColor) || (s.fill !== null && !isColorValue(s.fill))) errs.push(`${n} colours must be #rrggbb or @primary / @accent / @highlight`);
    else if (s.font !== undefined && (typeof s.font !== "string" || !s.font)) errs.push(`${n} font must be a family name or ${FONT_TOKEN}`);
    else if (!(s.strokeWidth >= 0) || !(s.fontSize > 0) || !(s.opacity >= 0 && s.opacity <= 1) || !(s.fillOpacity >= 0 && s.fillOpacity <= 1) || !(s.radius >= 0))
      errs.push(`${n} style out of range`);
    if (a.kind === "arrow" && !(a.from && a.to && fin(a.from.x, a.from.y, a.to.x, a.to.y))) errs.push(`${n} needs from and to`);
    if ((a.kind === "rect" || a.kind === "ellipse" || a.kind === "callout") && !(a.rect && fin(a.rect.x, a.rect.y) && a.rect.w > 0 && a.rect.h > 0)) errs.push(`${n} needs a rect with positive size`);
    if (a.kind === "text" && !(a.rect && fin(a.rect.x, a.rect.y, a.rect.w) && a.rect.w >= 0)) errs.push(`${n} needs a rect (x, y, w)`);
    if (a.kind === "badge" && !(a.at && fin(a.at.x, a.at.y))) errs.push(`${n} needs at`);
    if (a.number !== undefined && a.number !== null && !(Number.isInteger(a.number) && a.number >= 0)) errs.push(`${n} number must be a whole number or null`);
  }
  if (!Array.isArray(slides)) errs.push("slides must be a list");
  else
    for (const sl of slides) {
      if (!sl || typeof sl.id !== "string") {
        errs.push("slide without an id");
        continue;
      }
      if (ids.has(sl.id)) errs.push(`slide ${sl.id} id is used twice`);
      ids.add(sl.id);
      if (!(sl.durationMs > 0) || !(sl.atMs >= 0)) errs.push(`slide ${sl.id} needs atMs >= 0 and durationMs > 0`);
      if (!isColorValue(sl.background) || !isColorValue(sl.textColor) || (sl.accent !== null && !isColorValue(sl.accent))) errs.push(`slide ${sl.id} colours must be #rrggbb or a theme slot`);
      if (sl.fill !== undefined && sl.fill !== "solid" && sl.fill !== "theme") errs.push(`slide ${sl.id} fill must be solid or theme`);
      if (!(sl.fadeMs >= 0)) errs.push(`slide ${sl.id} fadeMs must be >= 0`);
    }
  if (!steps || !Array.isArray(steps.drafts)) errs.push("stepLabels.drafts must be a list");
  else
    for (const d of steps.drafts) {
      if (!d || typeof d.id !== "string" || !fin(d.clickMs, d.x, d.y)) errs.push("step draft needs id, clickMs, x, y");
      else if (!["pending", "accepted", "dismissed"].includes(d.state)) errs.push(`step draft ${d.id} has unknown state ${String(d.state)}`);
    }
  return errs;
}

// ------------------------------------------------------------------------------ step labels

/** The badge an accepted step draft becomes: auto-numbered, beside the click, label pill next to it. */
export function stepBadge(d: StepDraft, opts: { leadMs?: number; holdMs?: number } = {}): Annotation {
  const lead = opts.leadMs ?? 400;
  const hold = opts.holdMs ?? 2600;
  const style = defaultAnnotationStyle("badge");
  return {
    id: `step-${d.id}`,
    kind: "badge",
    startMs: Math.max(0, d.clickMs - lead),
    endMs: d.clickMs + hold,
    anchor: "screen",
    // up and to the right of the click point, clear of the cursor's hotspot
    at: { x: d.x + 26, y: d.y - 30 },
    size: 17,
    number: null,
    text: d.label,
    in: { kind: "pop", ms: 450 },
    out: { kind: "fade", ms: 250 },
    style,
    stepId: d.id,
  };
}

/**
 * Review step drafts (ids null = all). Accepted drafts get a badge in project.annotations (rebuilt
 * from the draft's current label), dismissed / pending ones lose theirs. Badges number themselves
 * 1, 2, 3 in click order (badgeNumbers).
 */
export function reviewSteps<P extends { annotations: Annotation[]; stepLabels: StepLabelSettings }>(p: P, ids: string[] | null, state: StepDraft["state"]): P {
  const pick = ids ? new Set(ids) : null;
  const touched = new Set<string>();
  const drafts = p.stepLabels.drafts.map((d) => {
    if (pick && !pick.has(d.id)) return d;
    touched.add(d.id);
    return d.state === state ? d : { ...d, state };
  });
  let annotations = p.annotations.filter((a) => !(a.stepId && touched.has(a.stepId)));
  if (state === "accepted") for (const d of drafts) if (touched.has(d.id)) annotations = [...annotations, stepBadge(d)];
  return { ...p, annotations, stepLabels: { ...p.stepLabels, drafts } };
}

/** Edit a draft's label; an accepted draft's badge follows. */
export function editStepLabel<P extends { annotations: Annotation[]; stepLabels: StepLabelSettings }>(p: P, id: string, label: string): P {
  const drafts = p.stepLabels.drafts.map((d) => (d.id === id ? { ...d, label } : d));
  const annotations = p.annotations.map((a) => (a.stepId === id ? { ...a, text: label } : a));
  return { ...p, annotations, stepLabels: { ...p.stepLabels, drafts } };
}

/** Put a step-label run's drafts in the project (re-run keeps the review state and edited label of the same click). */
export function applyStepDrafts<P extends { annotations: Annotation[]; stepLabels: StepLabelSettings }>(p: P, drafts: Array<Omit<StepDraft, "state"> & { state?: StepDraft["state"] }>, generatedAt: string | null = null): P {
  const old = p.stepLabels.drafts;
  const next: StepDraft[] = drafts.map((d) => {
    const prev = old.find((o) => Math.abs(o.clickMs - d.clickMs) < 1 && Math.abs(o.x - d.x) < 2 && Math.abs(o.y - d.y) < 2);
    return prev ? { ...d, label: prev.label, state: prev.state } : { ...d, state: d.state ?? "pending" };
  });
  const base = { ...p, annotations: p.annotations.filter((a) => !a.stepId), stepLabels: { drafts: next, generatedAt } };
  const acc = next.filter((d) => d.state === "accepted").map((d) => d.id);
  return acc.length ? reviewSteps(base, acc, "accepted") : base;
}
