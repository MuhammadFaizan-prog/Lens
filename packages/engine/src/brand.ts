/**
 * Brand kit (demand #9): colours, logo watermark, fonts, and brand-styled intro / outro slides.
 * Lens's own design (clean room, see docs/Presets.md).
 *
 * The brand kit is a palette layer above presets (see palette.ts): when it is enabled, every field
 * that references a slot ("@primary", "@highlight", "@font", an inheriting background) takes the
 * brand's value, so changing the brand primary recolours annotations, step badges, caption
 * highlights, slide accents and the derived backdrop at once. Literal values on an item still win.
 */
import { BUILTIN_FONTS, DEFAULT_FONT, HEX, luminance, mixHex, type FontFiles, type Palette, type PaletteBackground } from "./palette.js";

export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface BrandLogo {
  /** Image file (PNG with alpha recommended), relative to the bundle; null = no logo. */
  path: string | null;
  /** Intrinsic width / height of the image (the editor reads it on upload). */
  aspect: number;
  /** Show the logo as a watermark on the video. */
  watermark: boolean;
  corner: Corner;
  /** Watermark width as a fraction of the output width. */
  size: number;
  /** 0..1 */
  opacity: number;
  /** Safe margin from the frame edges, fraction of the output's short side. */
  margin: number;
  /**
   * Free position (on-canvas drag): the logo's centre as fractions of the output width / height.
   * Absent = the corner. Clamped so the logo stays inside the frame.
   */
  position?: { x: number; y: number } | null;
}

export interface BrandCard {
  enabled: boolean;
  title: string;
  subtitle: string;
  durationMs: number;
  /** Show the logo on the card (when there is one). */
  logo: boolean;
}

export interface BrandKit {
  enabled: boolean;
  name: string;
  colors: {
    primary: string;
    accent: string;
    /** derived = a deep gradient made from the primary colour; custom = colors below. */
    background: { mode: "derived" | "custom"; colors: string[]; angle: number };
  };
  /** Which brand colour the caption word highlight takes. */
  captionHighlight: "primary" | "accent";
  /** Font family for captions, annotation text and slides (a built-in OFL font or one of customFonts). */
  font: string;
  /** Fonts the user added: files relative to the bundle (they bring the licence). */
  customFonts: FontFiles[];
  logo: BrandLogo;
  intro: BrandCard;
  outro: BrandCard;
}

export function defaultBrand(): BrandKit {
  return {
    enabled: false,
    name: "My brand",
    colors: { primary: "#4f6bff", accent: "#ffc94d", background: { mode: "derived", colors: ["#141a3d", "#2c3c99"], angle: 135 } },
    captionHighlight: "primary",
    font: "Inter",
    customFonts: [],
    logo: { path: null, aspect: 1, watermark: true, corner: "bottom-right", size: 0.1, opacity: 0.85, margin: 0.035 },
    intro: { enabled: false, title: "", subtitle: "", durationMs: 2000, logo: true },
    outro: { enabled: false, title: "", subtitle: "", durationMs: 2000, logo: true },
  };
}

/** The backdrop the derived mode builds from the primary colour: deep shade to mid shade, 135°. */
export function derivedBackground(primary: string, angle = 135): PaletteBackground {
  return { kind: "gradient", colors: [mixHex(primary, "#07080c", 0.8), mixHex(primary, "#07080c", 0.42)], angle };
}

/** The brand kit's palette layer, or null when the kit is off. */
export function brandPalette(b: BrandKit | null | undefined): Partial<Palette> | null {
  if (!b || !b.enabled) return null;
  const bg = b.colors.background;
  return {
    primary: b.colors.primary,
    accent: b.colors.accent,
    highlight: b.captionHighlight === "accent" ? b.colors.accent : b.colors.primary,
    background: bg.mode === "custom" && bg.colors.length ? { kind: bg.colors.length > 1 ? "gradient" : "solid", colors: [...bg.colors], angle: bg.angle } : derivedBackground(b.colors.primary, bg.angle),
    font: b.font || DEFAULT_FONT,
  };
}

export function fontFiles(family: string, b: BrandKit | null | undefined): FontFiles | null {
  return b?.customFonts.find((f) => f.family === family) ?? BUILTIN_FONTS.find((f) => f.family === family) ?? null;
}

export interface WatermarkPlan {
  /** Image path as given in the brand kit (relative to the bundle unless absolute). */
  path: string;
  /** Integer output px. */
  x: number;
  y: number;
  w: number;
  h: number;
  opacity: number;
}

/** Where the watermark goes on a W x H output: whole pixels, inside the safe margin of its corner. */
export function watermarkRect(logo: BrandLogo, W: number, H: number): WatermarkPlan | null {
  if (!logo.path || !logo.watermark || !(logo.opacity > 0)) return null;
  const m = Math.round(logo.margin * Math.min(W, H));
  const w = Math.max(2, Math.min(W - 2 * m, Math.round(logo.size * W)));
  const h = Math.max(2, Math.min(H - 2 * m, Math.round(w / Math.max(0.05, logo.aspect))));
  let x = logo.corner.endsWith("left") ? m : W - m - w;
  let y = logo.corner.startsWith("top") ? m : H - m - h;
  if (logo.position && Number.isFinite(logo.position.x) && Number.isFinite(logo.position.y)) {
    x = Math.round(Math.min(W - w, Math.max(0, logo.position.x * W - w / 2)));
    y = Math.round(Math.min(H - h, Math.max(0, logo.position.y * H - h / 2)));
  }
  return { path: logo.path, x, y, w, h, opacity: Math.round(logo.opacity * 10000) / 10000 };
}

/** Text colour that reads on a background: white on dark, near-black on light. */
export function readableOn(bgColors: string[]): string {
  const mid = bgColors.length ? bgColors[Math.floor(bgColors.length / 2)]! : "#000000";
  return luminance(mid) > 0.45 ? "#111318" : "#ffffff";
}

const CORNERS: Corner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

export function validateBrand(b: BrandKit): string[] {
  const errs: string[] = [];
  if (!b || typeof b !== "object") return ["brand must be an object"];
  if (typeof b.enabled !== "boolean") errs.push("brand.enabled must be true or false");
  if (!HEX.test(b.colors?.primary ?? "") || !HEX.test(b.colors?.accent ?? "")) errs.push("brand colours must be #rrggbb");
  const bg = b.colors?.background;
  if (!bg || !["derived", "custom"].includes(bg.mode) || !Array.isArray(bg.colors) || bg.colors.some((c) => !HEX.test(c)) || !Number.isFinite(bg.angle))
    errs.push("brand.colors.background must be {mode: derived | custom, colors: #rrggbb[], angle}");
  if (!["primary", "accent"].includes(b.captionHighlight)) errs.push("brand.captionHighlight must be primary or accent");
  if (typeof b.font !== "string" || !b.font) errs.push("brand.font must be a font family");
  else if (!fontFiles(b.font, b)) errs.push(`brand.font ${b.font} is neither a built-in font nor one of brand.customFonts`);
  if (!Array.isArray(b.customFonts) || b.customFonts.some((f) => !f || typeof f.family !== "string" || typeof f.regular !== "string" || typeof f.bold !== "string"))
    errs.push("brand.customFonts must be [{family, regular, bold}]");
  const l = b.logo;
  if (!l || (l.path !== null && typeof l.path !== "string")) errs.push("brand.logo.path must be a path or null");
  else {
    if (!CORNERS.includes(l.corner)) errs.push(`brand.logo.corner must be one of ${CORNERS.join(", ")}`);
    if (!(l.size > 0 && l.size <= 0.5)) errs.push("brand.logo.size must be within (0, 0.5]");
    if (!(l.opacity >= 0 && l.opacity <= 1)) errs.push("brand.logo.opacity must be within 0..1");
    if (!(l.margin >= 0 && l.margin <= 0.25)) errs.push("brand.logo.margin must be within 0..0.25");
    if (!(l.aspect > 0)) errs.push("brand.logo.aspect must be > 0");
  }
  for (const k of ["intro", "outro"] as const) {
    const c = b[k];
    if (!c || typeof c.enabled !== "boolean" || typeof c.title !== "string" || typeof c.subtitle !== "string" || !(c.durationMs > 0 && c.durationMs <= 20000))
      errs.push(`brand.${k} must be {enabled, title, subtitle, durationMs within (0, 20000]}`);
  }
  return errs;
}

