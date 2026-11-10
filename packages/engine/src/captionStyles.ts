/**
 * Caption fonts and one-click caption styles (Windows request "diff diff fonts for the captions").
 *
 * Our own design: the families are Lens's bundled OFL fonts (palette.ts BUILTIN_FONTS, files in
 * assets/fonts), the presets are our own combinations of the caption style fields. Applying a preset
 * replaces only the look (font, weight, case, colours, box, outline, highlight style, size); position,
 * line breaking and the caption text are left alone.
 */
import type { CaptionStyle } from "./project.js";
import { DEFAULT_FONT, luminance, resolveColor, HEX } from "./palette.js";

export interface CaptionFontOption {
  /** Family name as written to captions.style.font; "@font" = the theme / brand font. */
  family: string;
  label: string;
  kind: "sans" | "display" | "serif" | "hand" | "mono" | "theme";
  /** The face has a real bold (false: the bold toggle draws the same face). */
  bold: boolean;
}

/** The caption font picker, in display order. */
export const CAPTION_FONTS: CaptionFontOption[] = [
  { family: "@font", label: "Theme font", kind: "theme", bold: true },
  { family: DEFAULT_FONT, label: "DejaVu Sans", kind: "sans", bold: true },
  { family: "Inter", label: "Inter", kind: "sans", bold: true },
  { family: "Poppins", label: "Poppins", kind: "sans", bold: true },
  { family: "Montserrat", label: "Montserrat", kind: "sans", bold: true },
  { family: "Roboto", label: "Roboto", kind: "sans", bold: true },
  { family: "Open Sans", label: "Open Sans", kind: "sans", bold: true },
  { family: "Oswald", label: "Oswald", kind: "display", bold: true },
  { family: "Bebas Neue", label: "Bebas Neue", kind: "display", bold: false },
  { family: "DM Serif Display", label: "DM Serif Display", kind: "serif", bold: false },
  { family: "Caveat", label: "Caveat", kind: "hand", bold: true },
  { family: "JetBrains Mono", label: "JetBrains Mono", kind: "mono", bold: true },
];

export type CaptionStylePatch = Partial<Omit<CaptionStyle, "position" | "y" | "maxWordsPerLine" | "maxCharsPerLine">>;

export interface CaptionPreset {
  id: string;
  label: string;
  /** One line for the picker's tooltip. */
  hint: string;
  style: CaptionStylePatch;
}

/**
 * The look fields a preset sets. Every preset writes all of them, so switching presets never leaves
 * a field from the previous one behind.
 */
const BASE: Required<Pick<CaptionStyle, "fontSize" | "textColor" | "highlightColor" | "background" | "weight" | "uppercase" | "stroke" | "highlightStyle">> & { font?: string } = {
  fontSize: 44,
  textColor: "#ffffff",
  highlightColor: "@highlight",
  background: { enabled: true, color: "#000000", opacity: 0.66 },
  weight: "bold",
  uppercase: false,
  stroke: { enabled: false, color: "#000000", width: 0.08 },
  highlightStyle: "color",
};

export const CAPTION_PRESETS: CaptionPreset[] = [
  // "Clean" is exactly the default caption (defaultProject) with the theme font: choosing it restores the original look
  { id: "clean", label: "Clean", hint: "The default: bold, white on a dark pill", style: { ...BASE, font: undefined } },
  { id: "bold-pop", label: "Bold pop", hint: "Big Montserrat capitals with a black outline, no box", style: { ...BASE, font: "Montserrat", fontSize: 56, uppercase: true, background: { ...BASE.background, enabled: false }, stroke: { enabled: true, color: "#000000", width: 0.12 } } },
  { id: "boxed", label: "Boxed", hint: "Dark Poppins text on a light card", style: { ...BASE, font: "Poppins", textColor: "#111318", highlightColor: "#ff5a36", background: { enabled: true, color: "#ffffff", opacity: 0.94 } } },
  { id: "subtitle", label: "Subtitle", hint: "Film-style Roboto, regular weight, thin outline", style: { ...BASE, font: "Roboto", weight: "regular", fontSize: 40, highlightColor: "#ffffff", background: { ...BASE.background, enabled: false }, stroke: { enabled: true, color: "#000000", width: 0.06 } } },
  { id: "highlight-word", label: "Highlight word", hint: "Poppins with the spoken word on a coloured box", style: { ...BASE, font: "Poppins", fontSize: 48, background: { ...BASE.background, enabled: false }, stroke: { enabled: true, color: "#000000", width: 0.08 }, highlightStyle: "box" } },
  { id: "headline", label: "Headline", hint: "Tall Bebas Neue capitals on a translucent box", style: { ...BASE, font: "Bebas Neue", fontSize: 64, uppercase: true, background: { enabled: true, color: "#000000", opacity: 0.5 } } },
];

/** The style with preset `id` applied (unknown id: unchanged). Position and line breaking are kept. */
export function applyCaptionPreset(style: CaptionStyle, id: string): CaptionStyle {
  const pr = CAPTION_PRESETS.find((x) => x.id === id);
  if (!pr) return style;
  const out: CaptionStyle = { ...style, ...pr.style, background: { ...pr.style.background! }, stroke: { ...pr.style.stroke! }, preset: pr.id };
  if (pr.style.font === undefined) delete out.font;
  return out;
}

/** Caption look with every optional field filled in (what both renderers draw when a field is absent). */
export function captionLook(cs: Partial<CaptionStyle>): { weight: "regular" | "bold"; uppercase: boolean; stroke: { enabled: boolean; color: string; width: number }; highlightStyle: "color" | "box" } {
  return {
    weight: cs.weight === "regular" ? "regular" : "bold",
    uppercase: cs.uppercase === true,
    stroke: cs.stroke ? { enabled: !!cs.stroke.enabled, color: cs.stroke.color, width: cs.stroke.width } : { enabled: false, color: "#000000", width: 0.08 },
    highlightStyle: cs.highlightStyle === "box" ? "box" : "color",
  };
}

/** Outline width in whole px for a font size (both renderers round the same way). */
export function captionStrokePx(fontSize: number, width: number): number {
  return Math.max(1, Math.round(fontSize * width));
}

/** Text colour on the box highlight: dark on a light box, white on a dark one. */
export function boxHighlightText(boxColor: string): string {
  const c = HEX.test(boxColor) ? boxColor : resolveColor(boxColor);
  return luminance(c) > 0.45 ? "#111318" : "#ffffff";
}
