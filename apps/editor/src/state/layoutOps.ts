/**
 * Project edits for the canvas layout UI (feat/canvas-layout): the aspect picker, the screen card
 * (move / resize / Fit / Fill / Center / Reset) and the source crop insets. Pure, unit-tested in
 * test/layoutOps.test.ts. Every edit is applied through store.edit / gestures by the components.
 */
import { cardFromRect, centerCard, customWindow, fillCard, fillWindow, framingMode, normalizeCrop, validCard } from "@lens/engine";
import type { CardTransform, FramingMode, ProjectConfig, Rect } from "@lens/engine";

export const ASPECTS = ["auto", "16:9", "9:16", "1:1", "4:5", "4:3", "21:9"] as const;
export type AspectChoice = (typeof ASPECTS)[number] | "custom";

export const aspectLabel = (a: AspectChoice): string => (a === "auto" ? "Auto" : a === "custom" ? "Custom" : a);

/** What the picker shows: a custom W x H wins over the aspect, like canvasSize. */
export function aspectChoiceOf(p: ProjectConfig): AspectChoice {
  const s = p.output.size;
  if (s && s.w > 0 && s.h > 0) return "custom";
  return (ASPECTS as readonly string[]).includes(p.output.aspect) ? (p.output.aspect as AspectChoice) : "custom";
}

const even = (n: number) => Math.max(16, Math.min(8192, Math.round(n / 2) * 2));

/**
 * Pick an aspect: the canvas takes it, the custom size goes and the card re-fits, centred (card null).
 * The framing mode the user picked (Fit / Fill / Follow / Custom) is kept (fix/aspect-framing-014):
 * a Fit project still shows the whole recording, never cropped; a custom window re-locks to the new
 * canvas shape about its centre (customWindow).
 */
export function setAspect(p: ProjectConfig, a: Exclude<AspectChoice, "custom">): ProjectConfig {
  return { ...p, output: { ...p.output, aspect: a, size: null, fit: fitOf(p) }, card: null };
}

/** output.fit in step with the framing mode (follow = "fill", the rest "fit"). */
const fitOf = (p: ProjectConfig): "fit" | "fill" => (framingMode(p.output) === "follow" ? "fill" : "fit");

/** Custom canvas W x H in px (rounded to even, 16..8192); the card re-fits, centred. */
export function setCustomSize(p: ProjectConfig, w: number, h: number): ProjectConfig {
  if (!(w > 0 && h > 0)) return p;
  return { ...p, output: { ...p.output, size: { w: even(w), h: even(h) }, fit: fitOf(p) }, card: null };
}

// ------------------------------------------------------------------ framing (fix/aspect-framing-014)

export const FRAMING_LABELS: Record<FramingMode, string> = { fit: "Fit", fill: "Fill", follow: "Follow cursor", custom: "Custom" };
export const FRAMING_HINTS: Record<FramingMode, string> = {
  fit: "The whole recording, letterboxed and centred",
  fill: "Crop to fill the canvas, centred",
  follow: "Fill the canvas and pan with the cursor and zooms",
  custom: "Choose the part of the recording to show",
};

/** The mode the controls show: a free card is "free" (it owns the placement). */
export function framingChoiceOf(p: ProjectConfig): FramingMode | "free" {
  return validCard(p.card) ? "free" : framingMode(p.output);
}

/**
 * Pick a framing mode: the free card goes (the card re-fits, centred) and output.fit is kept in step
 * (follow = "fill", the rest "fit") so presets and older builds read the same thing. Custom starts
 * from the window the canvas showed (the follow / fill window, centred) unless one is set.
 */
export function setFraming(p: ProjectConfig, mode: FramingMode, meta: { width: number; height: number }, out: { width: number; height: number }): ProjectConfig {
  const output: ProjectConfig["output"] = { ...p.output, framing: mode, fit: mode === "follow" ? "fill" : "fit" };
  if (mode === "custom" && !output.framingRect) output.framingRect = fillWindow(normalizeCrop(p.crop, meta), out.width / out.height);
  return { ...p, output, card: null };
}

/** The custom window as the engine will use it (source px, aspect locked, inside the crop). */
export function framingWindowOf(p: ProjectConfig, meta: { width: number; height: number }, out: { width: number; height: number }): Rect {
  const crop = normalizeCrop(p.crop, meta);
  return framingMode(p.output) === "custom" ? customWindow(crop, out.width / out.height, p.output.framingRect) : fillWindow(crop, out.width / out.height);
}

/** Set the custom window (source px): Custom mode, clamped and aspect-locked like the engine does. */
export function setFramingRect(p: ProjectConfig, r: Rect, meta: { width: number; height: number }, out: { width: number; height: number }): ProjectConfig {
  const win = customWindow(normalizeCrop(p.crop, meta), out.width / out.height, r);
  return { ...p, output: { ...p.output, framing: "custom", fit: "fit", framingRect: win }, card: null };
}

/**
 * Window edit from a numeric field: x / y move it (size kept), w or h resize it about its centre with
 * the other side following the locked aspect.
 */
export function editFramingField(p: ProjectConfig, field: "x" | "y" | "w" | "h", v: number, meta: { width: number; height: number }, out: { width: number; height: number }): ProjectConfig {
  const cur = framingWindowOf(p, meta, out);
  const a = out.width / out.height;
  let r: Rect = cur;
  if (field === "x") r = { ...cur, x: v };
  else if (field === "y") r = { ...cur, y: v };
  else {
    const w = field === "w" ? v : v * a;
    const h = w / a;
    r = { x: cur.x + (cur.w - w) / 2, y: cur.y + (cur.h - h) / 2, w, h };
  }
  if (field === "x" || field === "y") {
    // a pure move: clamp inside the crop without customWindow's area-keeping resize nudging the size
    const crop = normalizeCrop(p.crop, meta);
    r = { ...r, x: Math.min(crop.x + crop.w - r.w, Math.max(crop.x, Math.round(r.x))), y: Math.min(crop.y + crop.h - r.h, Math.max(crop.y, Math.round(r.y))) };
    return { ...p, output: { ...p.output, framing: "custom", fit: "fit", framingRect: r }, card: null };
  }
  return setFramingRect(p, r, meta, out);
}

/** Reset the custom window: the centred Fill window, still Custom. */
export function resetFramingRect(p: ProjectConfig, meta: { width: number; height: number }, out: { width: number; height: number }): ProjectConfig {
  return { ...p, output: { ...p.output, framing: "custom", fit: "fit", framingRect: fillWindow(normalizeCrop(p.crop, meta), out.width / out.height) }, card: null };
}

// ------------------------------------------------------------------ screen card

const clampCard = (c: CardTransform): CardTransform => {
  const w = Math.min(4, Math.max(0.02, c.w));
  const h = Math.min(4, Math.max(0.02, c.h));
  const x = Math.min(4, Math.max(-4, c.x));
  const y = Math.min(4, Math.max(-4, c.y));
  return { x, y, w, h };
};

/** Card from an output-px rect (drag, numeric fields), clamped to what validateProject accepts. */
export function setCardRect(p: ProjectConfig, r: Rect, out: { width: number; height: number }): ProjectConfig {
  return { ...p, card: clampCard(cardFromRect(r, out)) };
}

/** Fit: back to today's padded, source-shaped placement (padding applies). */
export function cardFit(p: ProjectConfig): ProjectConfig {
  return { ...p, card: null };
}

/** Fill: the card covers the canvas; its shape trims the source, centred. */
export function cardFill(p: ProjectConfig): ProjectConfig {
  return { ...p, card: fillCard() };
}

/** Center the current card (given as an output-px rect) on the canvas, keeping its size. */
export function cardCenter(p: ProjectConfig, current: Rect, out: { width: number; height: number }): ProjectConfig {
  const c = validCard(p.card) ? p.card : cardFromRect(current, out);
  return { ...p, card: centerCard(c) };
}

/** Reset: no free card and no source crop. */
export function cardReset(p: ProjectConfig): ProjectConfig {
  return { ...p, card: null, crop: null };
}

/** Scale a card rect about its centre so its width is `scale` x the fitted width. */
export function scaledRect(current: Rect, fitted: Rect, scale: number): Rect {
  const s = Math.max(0.02, scale);
  const k = (fitted.w * s) / Math.max(1e-6, current.w);
  const w = current.w * k;
  const h = current.h * k;
  return { x: current.x + (current.w - w) / 2, y: current.y + (current.h - h) / 2, w, h };
}

// ------------------------------------------------------------------ source crop (L / T / R / B insets)

export interface Insets {
  l: number;
  t: number;
  r: number;
  b: number;
}

export function insetsOf(crop: Rect | null, meta: { width: number; height: number }): Insets {
  if (!crop) return { l: 0, t: 0, r: 0, b: 0 };
  return { l: crop.x, t: crop.y, r: Math.max(0, meta.width - crop.x - crop.w), b: Math.max(0, meta.height - crop.y - crop.h) };
}

/** Insets -> project.crop (source px); all zero = null. Keeps at least 16 px of source each way. */
export function setCropInsets(p: ProjectConfig, ins: Insets, meta: { width: number; height: number }): ProjectConfig {
  const r = (v: number) => Math.max(0, Math.round(v));
  let l = r(ins.l);
  let t = r(ins.t);
  const rr = r(ins.r);
  const bb = r(ins.b);
  l = Math.min(l, meta.width - 16);
  t = Math.min(t, meta.height - 16);
  const w = Math.max(16, meta.width - l - rr);
  const h = Math.max(16, meta.height - t - bb);
  if (l === 0 && t === 0 && w === meta.width && h === meta.height) return { ...p, crop: null };
  return { ...p, crop: { x: l, y: t, w, h } };
}
