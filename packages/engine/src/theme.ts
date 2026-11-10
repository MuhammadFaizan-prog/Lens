/**
 * Theme resolution (demand #9): turn a project's slot references into literal values for one
 * render, and add the brand kit's watermark, fonts and intro / outro cards.
 *
 *   built-in default < preset (project.theme.palette) < brand kit (project.brand) < per-item override
 *
 * buildRenderPlan calls applyTheme first, so everything downstream (and both renderers) only ever
 * sees literal colours and font family names.
 */
import { themedStyle, type Annotation, type TextSlide } from "./annotations.js";
import { brandPalette, fontFiles, readableOn, watermarkRect, type WatermarkPlan } from "./brand.js";
import { DEFAULT_FONT, resolveColor, resolveFont, resolvePalette, type FontFiles, type Palette } from "./palette.js";
import type { ProjectConfig } from "./project.js";

export interface ThemeResult {
  /** The project with every theme reference resolved (and brand cards added to slides). */
  project: ProjectConfig;
  palette: Palette;
  /** Fonts the render needs (family -> files), default font excluded. */
  fonts: FontFiles[];
  /** Watermark rect for an output of the given size, or null. */
  watermark: WatermarkPlan | null;
}

/** The resolved palette of a project: built-in < preset < brand. */
export function projectPalette(p: ProjectConfig): Palette {
  return resolvePalette({ preset: p.theme?.palette ?? null, brand: brandPalette(p.brand) });
}

export const BRAND_INTRO_ID = "brand-intro";
export const BRAND_OUTRO_ID = "brand-outro";

/** The brand kit's intro / outro cards as text slides (theme backdrop, brand font, logo, primary accent bar). */
export function brandSlides(p: ProjectConfig, durationMs: number, pal: Palette = projectPalette(p)): TextSlide[] {
  const b = p.brand;
  if (!b?.enabled) return [];
  const text = readableOn(pal.background.colors);
  const logo = b.logo.path ? { path: b.logo.path, aspect: b.logo.aspect } : null;
  const out: TextSlide[] = [];
  const card = (id: string, atMs: number, c: typeof b.intro): TextSlide => ({
    id, atMs, durationMs: c.durationMs, title: c.title || b.name, subtitle: c.subtitle, background: pal.background.colors[0] ?? "#000000", textColor: text,
    accent: "@primary", fadeMs: 300, titleSize: 84, subtitleSize: 38, font: "@font", fill: "theme", logo: c.logo ? logo : null,
  });
  if (b.intro.enabled) out.push(card(BRAND_INTRO_ID, 0, b.intro));
  if (b.outro.enabled) out.push(card(BRAND_OUTRO_ID, durationMs, b.outro));
  return out;
}

export function applyTheme(p: ProjectConfig, durationMs: number, out?: { width: number; height: number }): ThemeResult {
  const pal = projectPalette(p);
  const used = new Set<string>();
  const font = (v: string | undefined) => {
    const f = resolveFont(v, pal);
    used.add(f);
    return f;
  };
  const background = p.background.inherit
    ? (({ stops: _s, ...b }) => ({ ...b, kind: pal.background.kind, colors: [...pal.background.colors], angle: pal.background.angle }))(p.background)
    : p.background;
  const cs = p.captions.style;
  const captions = {
    ...p.captions,
    // the default font is left out so plans without a theme stay byte-identical
    style: { ...cs, highlightColor: resolveColor(cs.highlightColor, pal), textColor: resolveColor(cs.textColor, pal), font: ((f) => (f === DEFAULT_FONT ? undefined : f))(font(cs.font)),
      ...(cs.stroke ? { stroke: { ...cs.stroke, color: resolveColor(cs.stroke.color, pal) } } : {}),
      // second-batch colour fields take theme slots too; absent ones stay absent (old plans unchanged)
      ...(cs.accent !== undefined ? { accent: resolveColor(cs.accent, pal) } : {}),
      ...(cs.line2Color !== undefined ? { line2Color: resolveColor(cs.line2Color, pal) } : {}),
      ...(cs.gradient ? { gradient: { ...cs.gradient, from: resolveColor(cs.gradient.from, pal), to: resolveColor(cs.gradient.to, pal) } } : {}),
      ...(cs.glow ? { glow: { ...cs.glow, color: resolveColor(cs.glow.color, pal) } } : {}),
      ...(cs.shadow ? { shadow: { ...cs.shadow, color: resolveColor(cs.shadow.color, pal) } } : {}) },
  };
  const annotations: Annotation[] = p.annotations.map((a) => {
    const st = themedStyle(a.style, pal);
    used.add(st.font ?? DEFAULT_FONT);
    return { ...a, style: st };
  });
  const cards = brandSlides(p, durationMs, pal);
  const intro = cards.filter((c) => c.atMs === 0);
  const outro = cards.filter((c) => c.atMs !== 0);
  const slides: TextSlide[] = [...intro, ...p.slides, ...outro].map((s) => ({
    ...s,
    background: resolveColor(s.background, pal),
    textColor: resolveColor(s.textColor, pal),
    accent: s.accent === null ? null : resolveColor(s.accent, pal),
    font: font(s.font),
  }));
  const fonts: FontFiles[] = [];
  for (const f of used) {
    if (f === DEFAULT_FONT) continue;
    const files = fontFiles(f, p.brand, p.customFonts);
    if (files) fonts.push(files);
  }
  const project: ProjectConfig = { ...p, background, captions, annotations, slides };
  const watermark = p.brand?.enabled && out ? watermarkRect(p.brand.logo, out.width, out.height) : null;
  return { project, palette: pal, fonts, watermark };
}
