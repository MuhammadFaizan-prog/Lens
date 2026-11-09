/**
 * The user's preset library (demand #9): the built-in presets plus saved / imported ones, and the
 * default preset for new projects. Kept in localStorage for the browser editor (the Tauri shell
 * will keep the same .lenspreset files in the app's data folder).
 */
import { builtinPresets, parsePreset, PRESET_FORMAT, PRESET_VERSION, serializePreset, slugify, type Preset } from "@lens/engine";

const KEY = "lens.presets.v1";

interface Stored {
  /** User presets as .lenspreset text, so what is stored is exactly what an export writes. */
  user: string[];
  defaultId: string | null;
}

function read(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const j = JSON.parse(raw) as Stored;
      if (Array.isArray(j.user)) return { user: j.user, defaultId: j.defaultId ?? null };
    }
  } catch {
    // unreadable library: start empty
  }
  return { user: [], defaultId: null };
}

function write(s: Stored): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function userPresets(): Preset[] {
  const out: Preset[] = [];
  for (const t of read().user) {
    try {
      out.push(parsePreset(t));
    } catch {
      // skip a damaged entry rather than lose the library
    }
  }
  return out;
}

export function allPresets(): Preset[] {
  return [...builtinPresets(), ...userPresets()];
}

export function defaultPresetId(): string | null {
  return read().defaultId;
}

export function setDefaultPreset(id: string | null): void {
  write({ ...read(), defaultId: id });
}

function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`.slice(0, 64);
  return id;
}

function uniqueName(base: string, taken: Set<string>): string {
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
  return name;
}

/** Add a preset; its id (and name) are made unique against the library. Returns what was stored. */
export function addPreset(p: Preset): Preset {
  const all = allPresets();
  const q: Preset = { ...p, builtIn: undefined, format: PRESET_FORMAT, version: PRESET_VERSION, id: uniqueId(p.id || slugify(p.name), new Set(all.map((x) => x.id))), name: uniqueName(p.name, new Set(all.map((x) => x.name))) };
  delete q.builtIn;
  const s = read();
  write({ ...s, user: [...s.user, serializePreset(q)] });
  return q;
}

/** Replace a user preset in place (same id). */
export function replacePreset(p: Preset): void {
  const s = read();
  const user = userPresets().map((x) => (x.id === p.id ? p : x));
  write({ ...s, user: user.map(serializePreset) });
}

export function renamePreset(id: string, name: string): Preset | null {
  const p = userPresets().find((x) => x.id === id);
  if (!p || !name.trim()) return null;
  const q = { ...p, name: name.trim(), revision: p.revision + 1 };
  replacePreset(q);
  return q;
}

export function duplicatePreset(id: string): Preset | null {
  const p = allPresets().find((x) => x.id === id);
  if (!p) return null;
  return addPreset({ ...p, id: `${p.id}-copy`, name: `${p.name} copy`, revision: 1 });
}

export function deletePreset(id: string): boolean {
  const s = read();
  const user = userPresets();
  if (!user.some((x) => x.id === id)) return false;
  write({ user: user.filter((x) => x.id !== id).map(serializePreset), defaultId: s.defaultId === id ? null : s.defaultId });
  return true;
}

/** Import a .lenspreset file's text (older versions are migrated). Throws PresetError when invalid. */
export function importPresetText(text: string): Preset {
  const p = parsePreset(text);
  // the same file imported twice is the same preset, not a copy
  const same = userPresets().find((x) => x.id === p.id && serializePreset(x) === serializePreset(p));
  return same ?? addPreset(p);
}
