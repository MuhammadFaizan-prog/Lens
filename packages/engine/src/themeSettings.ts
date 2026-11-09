/**
 * project.theme: which style preset was applied, and the layer it left behind (palette and
 * annotation styles). See presets.ts for presets themselves and palette.ts for the precedence.
 */
import type { AnnotationKind, AnnotationStyle } from "./annotations.js";
import { isColorValue, HEX, type Palette } from "./palette.js";

export type PresetSection = "look" | "zoom" | "cursor" | "webcam" | "captions" | "audio" | "annotations";
export const PRESET_SECTIONS: PresetSection[] = ["look", "zoom", "cursor", "webcam", "captions", "audio", "annotations"];

export interface ThemeSettings {
  /** The last preset applied (null = none): id, name, revision and the sections that were applied. */
  preset: { id: string; name: string; revision: number; sections: PresetSection[] } | null;
  /** Preset palette layer (between the built-in palette and the brand kit). */
  palette: Partial<Palette>;
  /** Preset annotation styles per kind: new items start from these. */
  annotationStyles: Partial<Record<AnnotationKind, Partial<AnnotationStyle>>>;
}

export function defaultTheme(): ThemeSettings {
  return { preset: null, palette: {}, annotationStyles: {} };
}

const KINDS = ["text", "arrow", "rect", "ellipse", "badge", "callout"];

/** Errors in a palette layer (every field optional). */
export function validatePalette(p: Partial<Palette>, where = "palette"): string[] {
  const errs: string[] = [];
  if (!p || typeof p !== "object" || Array.isArray(p)) return [`${where} must be an object`];
  for (const k of Object.keys(p)) if (!["primary", "accent", "highlight", "background", "font"].includes(k)) errs.push(`${where}.${k} is not a palette slot`);
  for (const k of ["primary", "accent", "highlight"] as const) if (p[k] !== undefined && !HEX.test(String(p[k]))) errs.push(`${where}.${k} must be #rrggbb`);
  if (p.font !== undefined && (typeof p.font !== "string" || !p.font)) errs.push(`${where}.font must be a font family`);
  const bg = p.background;
  if (bg !== undefined) {
    if (!bg || !["solid", "gradient"].includes(bg.kind) || !Array.isArray(bg.colors) || !bg.colors.length || bg.colors.some((c) => !HEX.test(c)) || !Number.isFinite(bg.angle))
      errs.push(`${where}.background must be {kind: solid | gradient, colors: #rrggbb[], angle}`);
    else if (bg.kind === "gradient" && bg.colors.length < 2) errs.push(`${where}.background gradient needs two or more colours`);
  }
  return errs;
}

export function validateTheme(t: ThemeSettings): string[] {
  const errs: string[] = [];
  if (!t || typeof t !== "object") return ["theme must be an object"];
  if (t.preset !== null && (typeof t.preset?.id !== "string" || typeof t.preset.name !== "string" || !Array.isArray(t.preset.sections))) errs.push("theme.preset must be null or {id, name, revision, sections}");
  errs.push(...validatePalette(t.palette, "theme.palette"));
  if (!t.annotationStyles || typeof t.annotationStyles !== "object") errs.push("theme.annotationStyles must be an object");
  else
    for (const [k, st] of Object.entries(t.annotationStyles)) {
      if (!KINDS.includes(k)) errs.push(`theme.annotationStyles.${k} is not an annotation kind`);
      for (const f of ["color", "fill", "textColor"] as const) {
        const v = (st as Partial<AnnotationStyle>)?.[f];
        if (v !== undefined && v !== null && !isColorValue(v)) errs.push(`theme.annotationStyles.${k}.${f} must be #rrggbb or a theme slot`);
      }
    }
  return errs;
}
