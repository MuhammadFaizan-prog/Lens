/**
 * Style presets (demand #9): a named, versioned bundle of look, zoom, cursor, webcam, captions,
 * audio cleanup and annotation styles, applied to a project in one step, in whole or by section.
 * Stored and shared as `.lenspreset` JSON (format "lens-preset", schema version 2). Lens's own
 * design (clean room, see docs/Presets.md); the built-in presets are original.
 *
 * Applying a section writes that slice of the project from the preset, filling anything the
 * preset leaves out with the built-in default, so the same preset always gives the same result.
 * Colours travel in the Look section's palette (theme slots), never as literals on captions or
 * annotations, so a brand kit still overrides them (precedence: palette.ts).
 */
import { defaultAnnotationStyle, type AnnotationKind, type AnnotationStyle } from "./annotations.js";
import { BUILTIN_PALETTE, HEX, isColorToken, isColorValue, type Palette } from "./palette.js";
import { defaultProject, resolveProject, zoomPreset, ProjectValidationError, type CaptionStyle, type ProjectConfig } from "./project.js";
import { PRESET_SECTIONS, validatePalette, type PresetSection } from "./themeSettings.js";

export { PRESET_SECTIONS, type PresetSection };

export const PRESET_FORMAT = "lens-preset";
export const PRESET_VERSION = 2;
export const PRESET_EXTENSION = ".lenspreset";

type Camera = ProjectConfig["camera"];
export type WebcamStyle = Pick<Camera, "corner" | "size" | "shape" | "mirror" | "zoomedSize" | "transitionMs" | "hideDuringSilence">;
const WEBCAM_KEYS = ["corner", "size", "shape", "mirror", "zoomedSize", "transitionMs", "hideDuringSilence"] as const;

export interface PresetSections {
  look?: {
    /** Output aspect ratio, e.g. "9:16". */
    aspect?: string;
    /** "fill": crop in and follow the action when the output aspect differs from the screen's. */
    fit?: "fit" | "fill";
    /** An image or hidden backdrop (Windows bug #20); solid / gradient backdrops live in the palette. */
    backdrop?: { kind: "image" | "hidden"; imagePath?: string; fit?: "cover" | "contain"; blur?: number };
    /** Theme palette: primary, accent, caption highlight, backdrop, font. */
    palette?: Partial<Palette>;
    background?: { blur?: number };
    frame?: Partial<Omit<ProjectConfig["frame"], "shadow">> & { shadow?: Partial<ProjectConfig["frame"]["shadow"]> };
    motionBlur?: Partial<ProjectConfig["motionBlur"]>;
  };
  zoom?: Partial<Omit<ProjectConfig["zoom"], "segments">>;
  cursor?: Partial<ProjectConfig["cursor"]>;
  webcam?: Partial<WebcamStyle>;
  captions?: Partial<Omit<ProjectConfig["captions"], "style">> & { style?: Partial<CaptionStyle> };
  audio?: { noiseReduction?: Partial<ProjectConfig["audio"]["noiseReduction"]>; loudness?: Partial<ProjectConfig["audio"]["loudness"]> };
  annotations?: { styles: Partial<Record<AnnotationKind, Partial<AnnotationStyle>>> };
}

export interface Preset {
  format: typeof PRESET_FORMAT;
  /** Schema version of this file (2). Older versions are migrated on import. */
  version: number;
  id: string;
  name: string;
  description: string;
  /** Bumped each time the preset is saved over (the preset's own version). */
  revision: number;
  /** Built-in presets ship with Lens and cannot be renamed or deleted (duplicate them instead). */
  builtIn?: boolean;
  sections: PresetSections;
}

export const SECTION_LABELS: Record<PresetSection, string> = {
  look: "Look",
  zoom: "Zoom",
  cursor: "Cursor",
  webcam: "Webcam",
  captions: "Captions",
  audio: "Audio cleanup",
  annotations: "Annotation styles",
};

// ------------------------------------------------------------------------------ helpers

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function merge<T>(base: T, patch: unknown): T {
  if (!isObj(patch) || !isObj(base)) return patch === undefined ? base : (patch as T);
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) out[k] = k in out ? merge(out[k], v) : v;
  return out as T;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function slugify(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "preset";
}

const COLOR_FIELDS = ["color", "fill", "textColor"] as const;

// ------------------------------------------------------------------------------ apply

/**
 * Apply `preset` to a project. `sections` limits it to those sections (default: every section the
 * preset has); unchecked sections keep the project's own values exactly. Pure: returns a new
 * project (the editor commits it as one undo step).
 */
export function applyPreset(project: ProjectConfig, preset: Preset, sections: PresetSection[] = PRESET_SECTIONS): ProjectConfig {
  const d = defaultProject();
  const s = preset.sections;
  const want = new Set(sections.filter((k) => s[k] !== undefined));
  let p: ProjectConfig = clone(project);
  if (want.has("look") && s.look) {
    const L = s.look;
    const palette = clone(L.palette ?? {});
    const bg = palette.background ?? BUILTIN_PALETTE.background;
    p.output = { ...p.output, aspect: L.aspect ?? d.output.aspect };
    if (L.fit) p.output.fit = L.fit;
    else delete p.output.fit;
    p.background = { ...p.background, kind: bg.kind, colors: [...bg.colors], angle: bg.angle, blur: L.background?.blur ?? 0, inherit: true };
    delete p.background.imagePath;
    delete p.background.fit;
    delete p.background.stops; // the palette's gradient is evenly spaced
    if (L.backdrop) {
      p.background = { ...p.background, kind: L.backdrop.kind, inherit: false, blur: L.backdrop.blur ?? p.background.blur };
      if (L.backdrop.imagePath) p.background.imagePath = L.backdrop.imagePath;
      if (L.backdrop.fit) p.background.fit = L.backdrop.fit;
    }
    p.frame = merge(d.frame, L.frame);
    p.motionBlur = merge(d.motionBlur, L.motionBlur);
    p.theme = { ...p.theme, palette };
  }
  if (want.has("zoom") && s.zoom) {
    const z = merge({ ...d.zoom, segments: undefined as unknown }, s.zoom) as ProjectConfig["zoom"];
    p.zoom = { ...z, segments: p.zoom.segments };
  }
  if (want.has("cursor") && s.cursor) p.cursor = merge(d.cursor, s.cursor);
  if (want.has("webcam") && s.webcam) {
    const w = merge(pickWebcam(d.camera), s.webcam);
    p.camera = { ...p.camera, ...w };
    delete p.camera.position; // the preset places the webcam
  }
  if (want.has("captions") && s.captions) {
    const c = merge(d.captions, s.captions);
    // colours come from the palette so the brand kit can still override them
    if (!isColorToken(c.style.highlightColor)) c.style.highlightColor = "@highlight";
    // hand-written cues and word corrections are content, not style: they stay
    delete c.cues;
    delete c.wordEdits;
    p.captions = { ...c, ...(p.captions.cues ? { cues: p.captions.cues } : {}), ...(p.captions.wordEdits ? { wordEdits: p.captions.wordEdits } : {}) };
  }
  if (want.has("audio") && s.audio) {
    p.audio = { ...p.audio, noiseReduction: merge(d.audio.noiseReduction, s.audio.noiseReduction), loudness: merge(d.audio.loudness, s.audio.loudness) };
  }
  if (want.has("annotations") && s.annotations) {
    const styles = clone(s.annotations.styles ?? {});
    p.theme = { ...p.theme, annotationStyles: styles };
    p.annotations = p.annotations.map((a) => {
      const st = styles[a.kind];
      if (!st) return a;
      return { ...a, style: restyle(a.style, st, defaultAnnotationStyle(a.kind, a.anchor)) };
    });
  }
  p.theme = {
    ...p.theme,
    preset: { id: preset.id, name: preset.name, revision: preset.revision, sections: PRESET_SECTIONS.filter((k) => want.has(k)) },
  };
  return p;
}

/**
 * New style for an existing annotation: the preset's fields win, except colours the user set on
 * the item by hand (a literal that differs from the kind's built-in default), which stay.
 */
export function restyle(cur: AnnotationStyle, preset: Partial<AnnotationStyle>, builtin: AnnotationStyle): AnnotationStyle {
  const out: AnnotationStyle = { ...cur, ...preset, shadow: { ...cur.shadow, ...(preset.shadow ?? {}) } };
  for (const f of COLOR_FIELDS) {
    const v = cur[f];
    const own = typeof v === "string" && !v.startsWith("@") && v !== builtin[f];
    if (own) (out as unknown as Record<string, unknown>)[f] = v;
  }
  return out;
}

function pickWebcam(c: Camera): WebcamStyle {
  const o: Record<string, unknown> = {};
  for (const k of WEBCAM_KEYS) o[k] = c[k];
  return o as unknown as WebcamStyle;
}

/** The style for a new annotation of `kind`: built-in default, then the preset's annotation styles. */
export function themedNewStyle(project: ProjectConfig, kind: AnnotationKind, base: AnnotationStyle): AnnotationStyle {
  const st = project.theme.annotationStyles[kind];
  return st ? { ...base, ...st, shadow: { ...base.shadow, ...(st.shadow ?? {}) } } : base;
}

// ------------------------------------------------------------------------------ save current project

/** Capture the project's current look, zoom, cursor, webcam, captions, audio cleanup and annotation styles as a preset. */
export function presetFromProject(project: ProjectConfig, name: string, opts: { id?: string; description?: string; revision?: number } = {}): Preset {
  const p = clone(project);
  const palette: Partial<Palette> = { ...clone(BUILTIN_PALETTE), ...clone(p.theme.palette) };
  if (!p.background.inherit && (p.background.kind === "solid" || p.background.kind === "gradient")) {
    palette.background = { kind: p.background.kind, colors: [...p.background.colors], angle: p.background.angle };
  }
  const hc = p.captions.style.highlightColor;
  if (!hc.startsWith("@")) palette.highlight = hc;
  const { segments: _seg, ...zoom } = p.zoom;
  void _seg;
  const style = { ...p.captions.style, highlightColor: "@highlight" };
  return {
    format: PRESET_FORMAT,
    version: PRESET_VERSION,
    id: opts.id ?? slugify(name),
    name,
    description: opts.description ?? "",
    revision: opts.revision ?? 1,
    sections: {
      look: { aspect: p.output.aspect, ...(p.output.fit === "fill" ? { fit: "fill" as const } : {}),
        ...(p.background.kind === "image" || p.background.kind === "hidden"
          ? { backdrop: { kind: p.background.kind, ...(p.background.imagePath ? { imagePath: p.background.imagePath } : {}), ...(p.background.fit ? { fit: p.background.fit } : {}), blur: p.background.blur } }
          : {}),
        palette, background: { blur: p.background.blur }, frame: p.frame, motionBlur: p.motionBlur },
      zoom,
      cursor: p.cursor,
      webcam: pickWebcam(p.camera),
      captions: (({ cues: _c, wordEdits: _w, ...rest }) => ({ ...rest, style }))(p.captions),
      audio: { noiseReduction: p.audio.noiseReduction, loudness: p.audio.loudness },
      annotations: { styles: clone(p.theme.annotationStyles) },
    },
  };
}

// ------------------------------------------------------------------------------ file format

export function serializePreset(p: Preset): string {
  const { builtIn: _b, ...rest } = p;
  void _b;
  return JSON.stringify(rest, null, 2) + "\n";
}

export class PresetError extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join("; "));
  }
}

/** Parse a .lenspreset file: JSON, then migrate older versions, then validate. Throws PresetError. */
export function parsePreset(text: string): Preset {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new PresetError([`not JSON: ${e instanceof Error ? e.message : String(e)}`]);
  }
  const { preset, errors } = validatePreset(raw);
  if (!preset) throw new PresetError(errors);
  return preset;
}

/**
 * Schema validation (after migrating older versions). Returns the preset when valid, plus every
 * error found: wrong format / version, unknown sections or fields, wrong value types, and value
 * ranges (checked by applying the preset to a default project and validating that).
 */
export function validatePreset(raw: unknown): { preset: Preset | null; errors: string[] } {
  const errs: string[] = [];
  if (!isObj(raw)) return { preset: null, errors: ["a preset must be a JSON object"] };
  if (raw.format !== PRESET_FORMAT) errs.push(`format must be "${PRESET_FORMAT}"`);
  let p: Record<string, unknown> = raw;
  if (raw.format === PRESET_FORMAT && raw.version === 1) p = migratePresetV1(raw) as unknown as Record<string, unknown>;
  else if (typeof raw.version !== "number" || !Number.isInteger(raw.version)) errs.push("version must be a whole number");
  else if (raw.version > PRESET_VERSION) errs.push(`version ${raw.version} is newer than this Lens understands (${PRESET_VERSION})`);
  else if (raw.version !== PRESET_VERSION) errs.push(`version ${raw.version} is not supported`);
  for (const k of Object.keys(p)) if (!["format", "version", "id", "name", "description", "revision", "builtIn", "sections"].includes(k)) errs.push(`unknown field ${k}`);
  if (typeof p.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(p.id)) errs.push("id must be lowercase letters, digits and dashes");
  if (typeof p.name !== "string" || !p.name.trim() || p.name.length > 80) errs.push("name must be 1-80 characters");
  if (typeof p.description !== "string") errs.push("description must be a string");
  if (!(Number.isInteger(p.revision) && (p.revision as number) >= 1)) errs.push("revision must be a whole number >= 1");
  if (!isObj(p.sections)) {
    errs.push("sections must be an object");
    return { preset: null, errors: errs };
  }
  const sec = p.sections;
  for (const k of Object.keys(sec)) if (!(PRESET_SECTIONS as string[]).includes(k)) errs.push(`unknown section ${k}`);
  const T = templates();
  for (const k of PRESET_SECTIONS) if (sec[k] !== undefined) checkShape(sec[k], T[k], `sections.${k}`, errs);
  const look = sec.look as PresetSections["look"];
  if (look?.palette && isObj(look.palette)) errs.push(...validatePalette(look.palette, "sections.look.palette"));
  if (look?.aspect !== undefined && !/^\d+:\d+$/.test(String(look.aspect))) errs.push("sections.look.aspect must look like 16:9");
  if (look?.fit !== undefined && look.fit !== "fit" && look.fit !== "fill") errs.push("sections.look.fit must be fit or fill");
  const cap = sec.captions as PresetSections["captions"];
  const hc = cap?.style?.highlightColor;
  if (hc !== undefined && !isColorToken(hc)) errs.push("sections.captions.style.highlightColor must be a theme slot (put the colour in look.palette.highlight)");
  for (const f of ["textColor"] as const) {
    const v = cap?.style?.[f];
    if (v !== undefined && !isColorValue(v)) errs.push(`sections.captions.style.${f} must be #rrggbb`);
  }
  if (cap?.style?.background?.color !== undefined && !HEX.test(String(cap.style.background.color))) errs.push("sections.captions.style.background.color must be #rrggbb");
  const ann = sec.annotations as PresetSections["annotations"];
  if (ann?.styles && isObj(ann.styles))
    for (const [kind, st] of Object.entries(ann.styles))
      for (const f of COLOR_FIELDS) {
        const v = (st as Partial<AnnotationStyle>)?.[f];
        if (v !== undefined && v !== null && !isColorValue(v)) errs.push(`sections.annotations.styles.${kind}.${f} must be #rrggbb or a theme slot`);
      }
  if (!errs.length) {
    try {
      resolveProject(applyPreset(defaultProject(), p as unknown as Preset));
    } catch (e) {
      errs.push(e instanceof ProjectValidationError ? `values out of range: ${e.message}` : String(e));
    }
  }
  return errs.length ? { preset: null, errors: errs } : { preset: p as unknown as Preset, errors: [] };
}

type Template = unknown;

function templates(): Record<PresetSection, Template> {
  const d = defaultProject();
  const style = { ...defaultAnnotationStyle("rect"), font: "" };
  const { segments: _s, ...zoom } = d.zoom;
  void _s;
  return {
    look: { aspect: "", fit: "", backdrop: { kind: "", imagePath: "", fit: "", blur: 0 }, palette: { primary: "", accent: "", highlight: "", background: { kind: "", colors: [], angle: 0 }, font: "" }, background: { blur: 0 }, frame: d.frame, motionBlur: d.motionBlur },
    zoom,
    cursor: d.cursor,
    webcam: pickWebcam(d.camera),
    captions: { ...d.captions, style: { ...d.captions.style, font: "" } },
    audio: { noiseReduction: d.audio.noiseReduction, loudness: d.audio.loudness },
    annotations: { styles: { text: style, arrow: style, rect: style, ellipse: style, badge: style, callout: style } },
  };
}

const NULLABLE = new Set(["fill"]);

/** Unknown keys and wrong value types against a template built from the defaults. */
function checkShape(v: unknown, t: Template, path: string, errs: string[]): void {
  if (isObj(t)) {
    if (!isObj(v)) {
      errs.push(`${path} must be an object`);
      return;
    }
    for (const [k, x] of Object.entries(v)) {
      if (!(k in t)) {
        errs.push(`${path}.${k} is not a known field`);
        continue;
      }
      const tk = (t as Record<string, unknown>)[k];
      if (x === null && (tk === null || NULLABLE.has(k))) continue;
      checkShape(x, tk, `${path}.${k}`, errs);
    }
    return;
  }
  if (Array.isArray(t)) {
    if (!Array.isArray(v)) errs.push(`${path} must be a list`);
    return;
  }
  if (t === null) return;
  if (typeof v !== typeof t) errs.push(`${path} must be a ${typeof t}`);
  else if (typeof v === "number" && !Number.isFinite(v)) errs.push(`${path} must be a finite number`);
}

// ------------------------------------------------------------------------------ migration

/**
 * Version 1 (the flat 0.x draft format): {format, version: 1, name, accentColor?, look: {background,
 * padding, radius, shadow, motionBlur: bool, aspect}, zoom: {preset, auto}, cursor: {size,
 * clickEffect, smoothing: bool}, captions: {enabled, fontSize, position, highlightColor}}.
 * Version 2 groups everything into sections and moves colours into the palette.
 */
export interface PresetV1 {
  format: typeof PRESET_FORMAT;
  version: 1;
  name: string;
  accentColor?: string;
  look?: { background?: { kind: "solid" | "gradient"; colors: string[]; angle?: number }; padding?: number; radius?: number; shadow?: Partial<ProjectConfig["frame"]["shadow"]>; motionBlur?: boolean; aspect?: string };
  zoom?: { preset?: "calm" | "default" | "punchy"; auto?: boolean };
  cursor?: { size?: number; clickEffect?: ProjectConfig["cursor"]["clickEffect"]; smoothing?: boolean };
  captions?: { enabled?: boolean; fontSize?: number; position?: CaptionStyle["position"]; highlightColor?: string };
}

export function migratePresetV1(v1: Record<string, unknown>): Preset {
  const o = v1 as unknown as PresetV1;
  const s: PresetSections = {};
  const palette: Partial<Palette> = {};
  if (typeof o.accentColor === "string") palette.primary = o.accentColor;
  if (o.look) {
    const L = o.look;
    if (L.background) palette.background = { kind: L.background.kind, colors: [...L.background.colors], angle: L.background.angle ?? 135 };
    s.look = {
      ...(L.aspect ? { aspect: L.aspect } : {}),
      palette,
      frame: { ...(L.padding !== undefined ? { padding: L.padding } : {}), ...(L.radius !== undefined ? { radius: L.radius } : {}), ...(L.shadow ? { shadow: L.shadow } : {}) },
      ...(L.motionBlur !== undefined ? { motionBlur: { enabled: L.motionBlur } } : {}),
    };
  }
  if (o.captions?.highlightColor) {
    palette.highlight = o.captions.highlightColor;
    if (!s.look) s.look = { palette };
  } else if (!s.look && Object.keys(palette).length) s.look = { palette };
  if (o.zoom) s.zoom = { ...(o.zoom.preset ? zoomPreset(o.zoom.preset) : {}), ...(o.zoom.auto !== undefined ? { auto: o.zoom.auto } : {}) };
  if (o.cursor) {
    const c = o.cursor;
    const d = defaultProject().cursor;
    s.cursor = { ...(c.size !== undefined ? { size: c.size } : {}), ...(c.clickEffect ? { clickEffect: c.clickEffect } : {}), ...(c.smoothing !== undefined ? { smoothing: { ...d.smoothing, enabled: c.smoothing } } : {}) };
  }
  if (o.captions) {
    const c = o.captions;
    s.captions = { ...(c.enabled !== undefined ? { enabled: c.enabled } : {}), style: { ...(c.fontSize !== undefined ? { fontSize: c.fontSize } : {}), ...(c.position ? { position: c.position } : {}) } };
  }
  return { format: PRESET_FORMAT, version: PRESET_VERSION, id: slugify(String(o.name ?? "preset")), name: String(o.name ?? "Preset"), description: "", revision: 1, sections: s };
}

// ------------------------------------------------------------------------------ built-in presets

/**
 * Lens's built-in presets. Original designs (design choices, not measurements); each is a full
 * set of the seven sections. Returned fresh on each call.
 */
export function builtinPresets(): Preset[] {
  const mk = (id: string, name: string, description: string, sections: PresetSections): Preset => ({ format: PRESET_FORMAT, version: PRESET_VERSION, id, name, description, revision: 1, builtIn: true, sections });
  const z = (n: "calm" | "default" | "punchy") => ({ auto: true, ...zoomPreset(n) });
  return [
    mk("clean-product-demo", "Clean Product Demo", "Airy light backdrop, soft shadow, standard zoom. For landing pages and launch videos.", {
      look: {
        aspect: "16:9",
        palette: { primary: "#3d63f5", accent: "#7fd1ff", highlight: "#9fc2ff", background: { kind: "gradient", colors: ["#f1f4fa", "#d9e1f1", "#bccbe8"], angle: 160 }, font: "Inter" },
        background: { blur: 0 },
        frame: { padding: 0.075, radius: 18, shadow: { opacity: 0.26, blur: 60, offsetY: 22, angle: 90 } },
        motionBlur: { enabled: true, strength: 0.3 },
      },
      zoom: z("default"),
      cursor: { size: 1.4, clickEffect: "ripple", hideWhenIdle: true },
      webcam: { corner: "bottom-right", size: 0.22, shape: "circle", zoomedSize: 0.7 },
      captions: { enabled: false, style: { fontSize: 40, background: { enabled: true, color: "#0e1424", opacity: 0.72 }, position: "bottom", maxWordsPerLine: 6 } },
      audio: { noiseReduction: { enabled: true, amountDb: 10 }, loudness: { enabled: true, targetLufs: -16 } },
      annotations: { styles: { rect: { strokeWidth: 4, radius: 12 }, ellipse: { strokeWidth: 4 }, arrow: { strokeWidth: 5 }, callout: { fill: "#0e1424", radius: 16 } } },
    }),
    mk("tutorial", "Tutorial", "Calm camera, big cursor with a click highlight and sound, captions on. For walkthroughs people follow along with.", {
      look: {
        aspect: "16:9",
        palette: { primary: "#ff7a1a", accent: "#ffd23f", highlight: "#ffd23f", background: { kind: "gradient", colors: ["#16233f", "#2b4a78", "#5a86b8"], angle: 135 }, font: "Inter" },
        frame: { padding: 0.06, radius: 14 },
        motionBlur: { enabled: true, strength: 0.25 },
      },
      zoom: z("calm"),
      cursor: { size: 1.9, clickEffect: "highlight", clickSound: true, clickSoundVolume: 0.45, hideWhenIdle: false },
      webcam: { corner: "bottom-left", size: 0.26, shape: "rounded", zoomedSize: 0.8 },
      captions: { enabled: true, wordHighlight: true, style: { fontSize: 48, maxWordsPerLine: 6, background: { enabled: true, color: "#000000", opacity: 0.7 } } },
      audio: { noiseReduction: { enabled: true, amountDb: 12 }, loudness: { enabled: true, targetLufs: -16 } },
      annotations: { styles: { badge: { fontSize: 24 }, text: { fontSize: 28 }, arrow: { strokeWidth: 6 } } },
    }),
    mk("social-vertical", "Social Vertical 9:16", "Vertical 9:16, punchy zooms, large three-word captions in the upper-lower third. For Reels, Shorts and TikTok.", {
      look: {
        aspect: "9:16",
        fit: "fill",
        palette: { primary: "#ff3d7f", accent: "#ffe14d", highlight: "#ffe14d", background: { kind: "gradient", colors: ["#13002c", "#5b0f7a", "#ff3d7f"], angle: 160 }, font: "Inter" },
        frame: { padding: 0.05, radius: 22, shadow: { opacity: 0.5, blur: 56, offsetY: 20, angle: 90 } },
        motionBlur: { enabled: true, strength: 0.4 },
      },
      zoom: z("punchy"),
      cursor: { size: 2, clickEffect: "ripple" },
      webcam: { corner: "top-right", size: 0.3, shape: "circle", zoomedSize: 0.75 },
      captions: { enabled: true, maxWordsPerBlock: 4, style: { fontSize: 64, position: "custom", y: 0.76, maxWordsPerLine: 3, background: { enabled: true, color: "#000000", opacity: 0.55 } } },
      audio: { noiseReduction: { enabled: true, amountDb: 12 }, loudness: { enabled: true, targetLufs: -14 } },
      annotations: { styles: { text: { fontSize: 36 }, badge: { fontSize: 28 } } },
    }),
    mk("dark-dev", "Dark Dev", "Near-black backdrop, mint accents, monospaced text, tighter corners. For developer tools and terminal demos.", {
      look: {
        aspect: "16:9",
        palette: { primary: "#2ee6a6", accent: "#7aa2ff", highlight: "#2ee6a6", background: { kind: "gradient", colors: ["#07090d", "#0f1622", "#17283c"], angle: 150 }, font: "JetBrains Mono" },
        frame: { padding: 0.06, radius: 10, shadow: { opacity: 0.6, blur: 70, offsetY: 24, angle: 90 } },
        motionBlur: { enabled: true, strength: 0.35 },
      },
      zoom: z("default"),
      cursor: { size: 1.3, clickEffect: "circle" },
      webcam: { corner: "bottom-right", size: 0.2, shape: "rounded", zoomedSize: 0.7 },
      captions: { enabled: false, style: { fontSize: 40, textColor: "#d7e0ea", background: { enabled: true, color: "#06080c", opacity: 0.82 } } },
      audio: { noiseReduction: { enabled: true, amountDb: 12 }, loudness: { enabled: true, targetLufs: -16 } },
      annotations: { styles: { rect: { strokeWidth: 3, radius: 6 }, ellipse: { strokeWidth: 3 }, arrow: { strokeWidth: 4 }, callout: { fill: "#0b1119", radius: 8 }, text: { fill: "#0b1119", radius: 6 } } },
    }),
    mk("minimal", "Minimal", "Warm off-white, small padding, quiet shadow, no click effects or motion blur, calm zooms. Lets the product speak.", {
      look: {
        aspect: "16:9",
        palette: { primary: "#1a1a1a", accent: "#8a8a8a", highlight: "#ffffff", background: { kind: "solid", colors: ["#f2f1ee"], angle: 0 }, font: "Inter" },
        frame: { padding: 0.045, radius: 8, shadow: { opacity: 0.16, blur: 36, offsetY: 10, angle: 90 } },
        motionBlur: { enabled: false },
      },
      zoom: z("calm"),
      cursor: { size: 1.2, clickEffect: "none" },
      webcam: { corner: "bottom-right", size: 0.18, shape: "circle", zoomedSize: 0.8 },
      captions: { enabled: false, wordHighlight: true, style: { fontSize: 38, textColor: "#a9a9a9", background: { enabled: true, color: "#1a1a1a", opacity: 0.86 } } },
      audio: { noiseReduction: { enabled: false }, loudness: { enabled: true, targetLufs: -16 } },
      annotations: { styles: { rect: { strokeWidth: 3, fillOpacity: 0.06 }, ellipse: { strokeWidth: 3, fillOpacity: 0.06 }, arrow: { strokeWidth: 4 }, badge: { strokeWidth: 0 } } },
    }),
  ];
}
