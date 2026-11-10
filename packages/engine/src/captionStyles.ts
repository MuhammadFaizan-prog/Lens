/**
 * Caption fonts and one-click caption styles (Windows request "diff diff fonts for the captions").
 *
 * Our own design: the families are Lens's bundled OFL fonts (palette.ts BUILTIN_FONTS, files in
 * assets/fonts), the presets are our own combinations of the caption style fields. Applying a preset
 * replaces only the look (font, weight, case, colours, box, outline, highlight style, size); position,
 * line breaking and the caption text are left alone.
 */
import { CAPTION_HIGHLIGHT_STYLES, type CaptionHighlightStyle, type CaptionStyle } from "./project.js";
import { DEFAULT_FONT, luminance, resolveColor, HEX } from "./palette.js";
import { EXTRA_FONTS, type FontKind } from "./fontCatalog.js";

export interface CaptionFontOption {
  /** Family name as written to captions.style.font; "@font" = the theme / brand font. */
  family: string;
  label: string;
  kind: FontKind | "theme";
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
  { family: "Oswald", label: "Oswald", kind: "condensed", bold: true },
  { family: "Bebas Neue", label: "Bebas Neue", kind: "condensed", bold: false },
  { family: "DM Serif Display", label: "DM Serif Display", kind: "serif", bold: false },
  { family: "Caveat", label: "Caveat", kind: "hand", bold: true },
  { family: "JetBrains Mono", label: "JetBrains Mono", kind: "mono", bold: true },
  // second batch (Windows v0.1.3 "add more styles n fonts"), fontCatalog.ts
  ...EXTRA_FONTS.map((f) => ({ family: f.family, label: f.family, kind: f.kind, bold: !!f.bold })),
];

/** Picker categories, in display order ("mine" = fonts the user imported). */
export const CAPTION_FONT_CATEGORIES: Array<{ id: FontKind | "all" | "mine"; label: string }> = [
  { id: "all", label: "All" },
  { id: "sans", label: "Sans" },
  { id: "serif", label: "Serif" },
  { id: "display", label: "Display" },
  { id: "rounded", label: "Rounded" },
  { id: "condensed", label: "Condensed" },
  { id: "mono", label: "Mono" },
  { id: "hand", label: "Handwriting" },
  { id: "mine", label: "My fonts" },
];

/** Picker filter: case-insensitive substring of the label, within a category ("all": every built-in). */
export function filterCaptionFonts<T extends { label: string; kind: string }>(fonts: T[], query: string, category: string): T[] {
  const q = query.trim().toLowerCase();
  return fonts.filter((f) => (category === "all" || f.kind === category || f.kind === "theme" && category === "all") && (!q || f.label.toLowerCase().includes(q)));
}

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

const NO_BG = { enabled: false, color: "#000000", opacity: 0.66 };
const OUTLINE = (width: number, color = "#000000") => ({ enabled: true, color, width });

export const CAPTION_PRESETS: CaptionPreset[] = [
  // "Clean" is exactly the default caption (defaultProject) with the theme font: choosing it restores the original look
  { id: "clean", label: "Clean", hint: "The default: bold, white on a dark pill", style: { ...BASE, font: undefined } },
  { id: "bold-pop", label: "Bold pop", hint: "Big Montserrat capitals with a black outline, no box", style: { ...BASE, font: "Montserrat", fontSize: 56, uppercase: true, background: { ...BASE.background, enabled: false }, stroke: { enabled: true, color: "#000000", width: 0.12 } } },
  { id: "boxed", label: "Boxed", hint: "Dark Poppins text on a light card", style: { ...BASE, font: "Poppins", textColor: "#111318", highlightColor: "#ff5a36", background: { enabled: true, color: "#ffffff", opacity: 0.94 } } },
  { id: "subtitle", label: "Subtitle", hint: "Film-style Roboto, regular weight, thin outline", style: { ...BASE, font: "Roboto", weight: "regular", fontSize: 40, highlightColor: "#ffffff", background: { ...BASE.background, enabled: false }, stroke: { enabled: true, color: "#000000", width: 0.06 } } },
  { id: "highlight-word", label: "Highlight word", hint: "Poppins with the spoken word on a coloured box", style: { ...BASE, font: "Poppins", fontSize: 48, background: { ...BASE.background, enabled: false }, stroke: { enabled: true, color: "#000000", width: 0.08 }, highlightStyle: "box" } },
  { id: "headline", label: "Headline", hint: "Tall Bebas Neue capitals on a translucent box", style: { ...BASE, font: "Bebas Neue", fontSize: 64, uppercase: true, background: { enabled: true, color: "#000000", opacity: 0.5 } } },
  // second batch (Windows v0.1.3 "add more styles"): our own combinations of the fields below
  ...MORE_PRESETS(),
];


function MORE_PRESETS(): CaptionPreset[] {
  return [
    { id: "reels", label: "Reels", hint: "TikTok / Reels: big Poppins capitals, thick outline, spoken word in green", style: { ...BASE, font: "Poppins", fontSize: 60, uppercase: true, background: NO_BG, stroke: OUTLINE(0.14), highlightColor: "#2ee66b" } },
    { id: "karaoke-pill", label: "Karaoke pill", hint: "Spoken word on a pink pill", style: { ...BASE, font: "Poppins", fontSize: 50, background: NO_BG, stroke: OUTLINE(0.08), highlightStyle: "pill", highlightColor: "#ff3d7f" } },
    { id: "word-pop", label: "Word pop", hint: "Words appear one by one; the spoken word pops in larger", style: { ...BASE, font: "Montserrat", fontSize: 56, uppercase: true, background: NO_BG, stroke: OUTLINE(0.12), highlightStyle: "pop", highlightColor: "#ffd23f", reveal: true } },
    { id: "word-boxes", label: "Word boxes", hint: "Every word on its own dark box", style: { ...BASE, font: "Kanit", fontSize: 48, background: { enabled: true, color: "#000000", opacity: 0.82 }, boxMode: "word", highlightColor: "#ffd23f" } },
    { id: "gradient", label: "Gradient", hint: "Archivo Black with a warm top-to-bottom gradient", style: { ...BASE, font: "Archivo Black", fontSize: 54, background: NO_BG, stroke: OUTLINE(0.06), gradient: { enabled: true, from: "#ffe259", to: "#ff7a3d" }, highlightColor: "#ffffff" } },
    { id: "neon", label: "Neon", hint: "Glowing cyan Righteous, spoken word in pink", style: { ...BASE, font: "Righteous", fontSize: 54, textColor: "#eafcff", background: NO_BG, glow: { enabled: true, color: "#00d9ff", radius: 0.16 }, highlightColor: "#ff4fd8" } },
    { id: "typewriter", label: "Typewriter", hint: "Courier Prime typed out word by word on paper", style: { ...BASE, font: "Courier Prime", fontSize: 42, weight: "regular", textColor: "#1d2027", highlightColor: "#1d2027", background: { enabled: true, color: "#f4f1ea", opacity: 0.94 }, boxShape: "square", reveal: true } },
    { id: "lower-third", label: "Lower third", hint: "A full-width bar with an accent stripe", style: { ...BASE, font: "Barlow", fontSize: 42, background: { enabled: true, color: "#101418", opacity: 0.86 }, boxShape: "bar", accent: "@highlight" } },
    { id: "classic-subtitle", label: "Classic subtitle", hint: "TV subtitles: Fira Sans on a box per line", style: { ...BASE, font: "Fira Sans", fontSize: 40, weight: "regular", highlightColor: "#ffffff", background: { enabled: true, color: "#000000", opacity: 0.78 }, boxMode: "line", boxShape: "square" } },
    { id: "soft-shadow", label: "Soft shadow", hint: "Minimal: Inter with a soft drop shadow, no box", style: { ...BASE, font: "Inter", fontSize: 46, background: NO_BG, shadow: { enabled: true, color: "#000000", opacity: 0.7, dx: 0, dy: 0.06, blur: 0.08 } } },
    { id: "comic", label: "Comic", hint: "Bangers capitals in yellow with a hard offset shadow", style: { ...BASE, font: "Bangers", fontSize: 58, uppercase: true, textColor: "#ffe23f", highlightColor: "#ff3b3b", background: NO_BG, stroke: OUTLINE(0.1), shadow: { enabled: true, color: "#000000", opacity: 1, dx: 0.05, dy: 0.06, blur: 0 } } },
    { id: "emoji", label: "Emoji friendly", hint: "Rounded Varela Round on a white card; leaves room for emoji", style: { ...BASE, font: "Varela Round", fontSize: 46, textColor: "#1d2027", highlightStyle: "pill", highlightColor: "#ffd23f", background: { enabled: true, color: "#ffffff", opacity: 0.94 } } },
    { id: "impact", label: "Impact", hint: "Tall Anton capitals with an outline", style: { ...BASE, font: "Anton", fontSize: 64, uppercase: true, background: NO_BG, stroke: OUTLINE(0.1), highlightColor: "#ffd23f" } },
    { id: "glass", label: "Glass", hint: "Frosted pill: the picture behind the caption is blurred", style: { ...BASE, font: "Poppins", fontSize: 46, background: { enabled: true, color: "#ffffff", opacity: 0.2 }, backdropBlur: 0.35, highlightColor: "#ffd23f", shadow: { enabled: true, color: "#000000", opacity: 0.35, dx: 0, dy: 0.03, blur: 0.04 } } },
    { id: "two-tone", label: "Two tone", hint: "First line white, second line yellow", style: { ...BASE, font: "Montserrat", fontSize: 50, background: NO_BG, stroke: OUTLINE(0.09), line2Color: "#ffd23f", highlightColor: "#2ee6ff" } },
    { id: "bounce", label: "Bounce", hint: "Lilita One; the spoken word bounces", style: { ...BASE, font: "Lilita One", fontSize: 56, background: NO_BG, stroke: OUTLINE(0.1), highlightStyle: "bounce", highlightColor: "#7cf3ff" } },
    { id: "underline", label: "Underline sweep", hint: "A bar sweeps under the spoken word", style: { ...BASE, font: "Titillium Web", fontSize: 48, background: { enabled: true, color: "#000000", opacity: 0.55 }, highlightStyle: "underline", highlightColor: "#ff5a36" } },
    { id: "handwritten", label: "Handwritten", hint: "Permanent Marker with a soft shadow", style: { ...BASE, font: "Permanent Marker", fontSize: 50, weight: "regular", background: NO_BG, shadow: { enabled: true, color: "#000000", opacity: 0.65, dx: 0.02, dy: 0.04, blur: 0.05 }, highlightColor: "#ffd23f" } },
    { id: "karaoke", label: "Karaoke fill", hint: "Words fill with colour as they are spoken", style: { ...BASE, font: "Kanit", fontSize: 52, uppercase: true, background: NO_BG, stroke: OUTLINE(0.1), highlightStyle: "karaoke", highlightColor: "#ffd23f" } },
    { id: "retro", label: "Retro terminal", hint: "Green VT323 on a black box with a faint glow", style: { ...BASE, font: "VT323", fontSize: 56, weight: "regular", textColor: "#39ff14", highlightColor: "#ffffff", background: { enabled: true, color: "#000000", opacity: 0.86 }, boxShape: "square", glow: { enabled: true, color: "#39ff14", radius: 0.1 } } },
  ];
}

/** Fields of the second batch: a preset that does not set one removes it, so switching styles leaves nothing behind. */
const MORE_KEYS = ["reveal", "boxMode", "boxShape", "accent", "gradient", "glow", "shadow", "backdropBlur", "line2Color"] as const;

/** The style with preset `id` applied (unknown id: unchanged). Position and line breaking are kept. */
export function applyCaptionPreset(style: CaptionStyle, id: string): CaptionStyle {
  const pr = CAPTION_PRESETS.find((x) => x.id === id);
  if (!pr) return style;
  const out: CaptionStyle = { ...style, ...pr.style, background: { ...pr.style.background! }, stroke: { ...pr.style.stroke! }, preset: pr.id };
  if (pr.style.font === undefined) delete out.font;
  for (const k of MORE_KEYS) {
    const v = pr.style[k];
    if (v === undefined) delete out[k];
    else if (typeof v === "object" && v) (out as unknown as Record<string, unknown>)[k] = { ...v };
  }
  return out;
}

/** Caption look with every optional field filled in (what both renderers draw when a field is absent). */
export function captionLook(cs: Partial<CaptionStyle>): { weight: "regular" | "bold"; uppercase: boolean; stroke: { enabled: boolean; color: string; width: number }; highlightStyle: CaptionHighlightStyle } {
  return {
    weight: cs.weight === "regular" ? "regular" : "bold",
    uppercase: cs.uppercase === true,
    stroke: cs.stroke ? { enabled: !!cs.stroke.enabled, color: cs.stroke.color, width: cs.stroke.width } : { enabled: false, color: "#000000", width: 0.08 },
    highlightStyle: cs.highlightStyle && CAPTION_HIGHLIGHT_STYLES.includes(cs.highlightStyle) ? cs.highlightStyle : "color",
  };
}

export interface CaptionEffects {
  reveal: boolean;
  boxMode: "block" | "line" | "word";
  boxShape: "rounded" | "square" | "bar";
  accent: string | null;
  gradient: { from: string; to: string } | null;
  glow: { color: string; radius: number } | null;
  shadow: { color: string; opacity: number; dx: number; dy: number; blur: number } | null;
  backdropBlur: number;
  line2Color: string | null;
}

/** The second batch's fields with absent / disabled ones filled in (what both renderers draw). */
export function captionEffects(cs: Partial<CaptionStyle>): CaptionEffects {
  return {
    reveal: cs.reveal === true,
    boxMode: cs.boxMode === "line" || cs.boxMode === "word" ? cs.boxMode : "block",
    boxShape: cs.boxShape === "square" || cs.boxShape === "bar" ? cs.boxShape : "rounded",
    accent: cs.accent ?? null,
    gradient: cs.gradient?.enabled ? { from: cs.gradient.from, to: cs.gradient.to } : null,
    glow: cs.glow?.enabled && cs.glow.radius > 0 ? { color: cs.glow.color, radius: cs.glow.radius } : null,
    shadow: cs.shadow?.enabled && cs.shadow.opacity > 0 ? { color: cs.shadow.color, opacity: cs.shadow.opacity, dx: cs.shadow.dx, dy: cs.shadow.dy, blur: cs.shadow.blur } : null,
    backdropBlur: cs.backdropBlur && cs.backdropBlur > 0 ? cs.backdropBlur : 0,
    line2Color: cs.line2Color ?? null,
  };
}

/** Highlight styles that follow the spoken word's progress (the plan carries CaptionFrame.progress for them). */
export function captionNeedsProgress(cs: Partial<CaptionStyle>): boolean {
  return cs.highlightStyle === "pop" || cs.highlightStyle === "bounce" || cs.highlightStyle === "underline";
}

/**
 * The spoken word's motion at `progress` (0..1 through the word): pop starts 25 % larger and settles at
 * 10 % larger in the first 35 %; bounce lifts by up to 18 % of the size over the first 45 %; the
 * underline sweeps across the word in the first 60 % (ease out). Both renderers use these numbers.
 */
export function captionMotion(style: CaptionHighlightStyle, progress: number | undefined): { scale: number; lift: number; sweep: number } {
  const p = Math.min(1, Math.max(0, progress ?? 1));
  if (style === "pop") return { scale: 1.1 + 0.15 * (1 - Math.min(1, p / 0.35)), lift: 0, sweep: 1 };
  if (style === "bounce") return { scale: 1, lift: 0.18 * Math.sin(Math.PI * Math.min(1, p / 0.45)), sweep: 1 };
  if (style === "underline") {
    const q = Math.min(1, p / 0.6);
    return { scale: 1, lift: 0, sweep: 1 - (1 - q) * (1 - q) };
  }
  return { scale: 1, lift: 0, sweep: 1 };
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
