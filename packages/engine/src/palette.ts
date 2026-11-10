/**
 * Theme palette (demand #9): the named colour / font slots that captions, annotations, text slides
 * and the background inherit from. Lens's own design (clean room, see docs/Presets.md).
 *
 * A themed field holds either a literal value ("#ff5a36", "Inter") or a slot reference ("@primary",
 * "@font"). A reference resolves through the layers, highest first:
 *
 *   per-item override (a literal on the item itself)
 *   > brand kit (project.brand, when enabled)
 *   > preset (project.theme.palette, written when a preset's Look section is applied)
 *   > built-in default (BUILTIN_PALETTE below)
 *
 * The built-in palette reproduces the pre-#9 defaults exactly, so a project without a preset or a
 * brand kit renders the same pixels as before (Rules.md 4: defaults unchanged).
 *
 * This file imports only fontCatalog.ts (which has no imports), so annotations.ts, project.ts and theme.ts can all use it.
 */

export type ColorSlot = "primary" | "accent" | "highlight";
export type FontSlot = "font";
export type Slot = ColorSlot | FontSlot | "background";

export interface PaletteBackground {
  kind: "solid" | "gradient";
  colors: string[];
  angle: number;
}

export interface Palette {
  /** Main brand colour: annotation strokes / fills, step badges, lower-third bars, slide accents. */
  primary: string;
  /** Second colour: text-slide accents of brand intro / outro, highlights the brand asks for. */
  accent: string;
  /** Caption word highlight. */
  highlight: string;
  /** The backdrop behind the recording. */
  background: PaletteBackground;
  /** Font family of captions, annotation text and text slides. */
  font: string;
}

export const DEFAULT_FONT = "DejaVu Sans";

export const BUILTIN_PALETTE: Palette = {
  primary: "#ff5a36",
  accent: "#ffd23f",
  highlight: "#ffd23f",
  background: { kind: "gradient", colors: ["#3a1c71", "#d76d77", "#ffaf7b"], angle: 135 },
  font: DEFAULT_FONT,
};

export const HEX = /^#[0-9a-fA-F]{6}$/;
export const COLOR_TOKEN = /^@(primary|accent|highlight)$/;
export const FONT_TOKEN = "@font";

export function isColorToken(v: unknown): v is `@${ColorSlot}` {
  return typeof v === "string" && COLOR_TOKEN.test(v);
}

/** A literal #rrggbb or a colour slot reference. */
export function isColorValue(v: unknown): boolean {
  return typeof v === "string" && (HEX.test(v) || COLOR_TOKEN.test(v));
}

/** Resolve a colour value against a palette: "@primary" -> palette.primary, literals unchanged. */
export function resolveColor(v: string, pal: Palette = BUILTIN_PALETTE): string {
  if (typeof v === "string" && v.startsWith("@")) {
    const slot = v.slice(1) as ColorSlot;
    return pal[slot] ?? v;
  }
  return v;
}

export function resolveFont(v: string | undefined, pal: Palette = BUILTIN_PALETTE): string {
  if (!v || v === FONT_TOKEN) return pal.font;
  return v;
}

export interface PaletteLayers {
  /** Built-in defaults (BUILTIN_PALETTE unless a test passes its own). */
  defaults?: Palette;
  /** The applied preset's palette (project.theme.palette). */
  preset?: Partial<Palette> | null;
  /** The brand kit's palette (brandPalette(project.brand)), null when no brand kit is enabled. */
  brand?: Partial<Palette> | null;
}

/** Merge the palette layers: built-in default < preset < brand. */
export function resolvePalette(layers: PaletteLayers): Palette {
  const out: Palette = { ...(layers.defaults ?? BUILTIN_PALETTE) };
  for (const layer of [layers.preset, layers.brand]) {
    if (!layer) continue;
    for (const k of Object.keys(layer) as Array<keyof Palette>) {
      const v = layer[k];
      if (v === undefined || v === null) continue;
      (out as unknown as Record<string, unknown>)[k] = k === "background" ? { ...(v as PaletteBackground), colors: [...(v as PaletteBackground).colors] } : v;
    }
  }
  return out;
}

/**
 * The whole precedence chain for one themed field: built-in default < preset < brand < per-item
 * override. `item` is the value stored on the item: a literal wins outright, a slot reference (or
 * nothing) falls through to the palette layers.
 */
export function resolveThemed<K extends ColorSlot | FontSlot>(slot: K, layers: PaletteLayers & { item?: string | null }): string {
  const item = layers.item;
  if (item && !item.startsWith("@")) return item;
  const ref = (item && item.startsWith("@") ? item.slice(1) : slot) as ColorSlot | FontSlot;
  return resolvePalette(layers)[ref];
}

// ------------------------------------------------------------------------------ colour helpers

export function hexToRgb(h: string): [number, number, number] {
  const s = h.replace("#", "");
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Mix two #rrggbb colours: u = 0 -> a, 1 -> b. */
export function mixHex(a: string, b: string, u: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return rgbToHex(r1 + (r2 - r1) * u, g1 + (g2 - g1) * u, b1 + (b2 - b1) * u);
}

/** Relative luminance (sRGB, 0..1) for picking readable text on a colour. */
export function luminance(h: string): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = hexToRgb(h);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// ------------------------------------------------------------------------------ fonts

import { catalogFiles, EXTRA_FONTS } from "./fontCatalog.js";

export interface FontFiles {
  family: string;
  /** "builtin:<file>" (Lens's assets/fonts, OFL), "system:<file>" (the OS font the defaults use), or a path relative to the bundle. */
  regular: string;
  bold: string;
}

/**
 * Fonts Lens ships, all under the SIL Open Font License 1.1 (licence texts next to the files in
 * assets/fonts). DejaVu Sans is the pre-#9 default the renderers already use
 * from the system.
 */
export const BUILTIN_FONTS: FontFiles[] = [
  { family: DEFAULT_FONT, regular: "system:DejaVuSans.ttf", bold: "system:DejaVuSans-Bold.ttf" },
  { family: "Inter", regular: "builtin:Inter-Regular.ttf", bold: "builtin:Inter-Bold.ttf" },
  { family: "JetBrains Mono", regular: "builtin:JetBrainsMono-Regular.ttf", bold: "builtin:JetBrainsMono-Bold.ttf" },
  // caption fonts (Windows request "diff diff fonts for the captions"): google/fonts, OFL 1.1, see assets/fonts/fetch_fonts.py
  { family: "Poppins", regular: "builtin:Poppins-Regular.ttf", bold: "builtin:Poppins-Bold.ttf" },
  { family: "Montserrat", regular: "builtin:Montserrat-Regular.ttf", bold: "builtin:Montserrat-Bold.ttf" },
  { family: "Roboto", regular: "builtin:Roboto-Regular.ttf", bold: "builtin:Roboto-Bold.ttf" },
  { family: "Open Sans", regular: "builtin:OpenSans-Regular.ttf", bold: "builtin:OpenSans-Bold.ttf" },
  { family: "Oswald", regular: "builtin:Oswald-Regular.ttf", bold: "builtin:Oswald-Bold.ttf" },
  // single-weight display faces: "bold" is the same file, so neither renderer synthesises a fake bold
  { family: "Bebas Neue", regular: "builtin:BebasNeue-Regular.ttf", bold: "builtin:BebasNeue-Regular.ttf" },
  { family: "DM Serif Display", regular: "builtin:DMSerifDisplay-Regular.ttf", bold: "builtin:DMSerifDisplay-Regular.ttf" },
  { family: "Caveat", regular: "builtin:Caveat-Regular.ttf", bold: "builtin:Caveat-Bold.ttf" },
  // second batch (Windows v0.1.3 "add more styles n fonts"): OFL / Apache, fetched at build time, see fontCatalog.ts
  ...EXTRA_FONTS.map((f) => {
    const files = catalogFiles(f);
    return { family: f.family, regular: `builtin:${files.regular}`, bold: `builtin:${files.bold}` };
  }),
];
