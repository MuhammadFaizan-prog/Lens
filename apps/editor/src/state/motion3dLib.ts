/**
 * The user's saved 3D motion templates ("Save as template"), kept per user in localStorage next to
 * the style preset library (presetLibrary.ts); shown after the built-ins in the template grid.
 */
import { MOTION3D_TEMPLATES, validateMotion3d, segmentFromTemplate, type Motion3DTemplate } from "@lens/engine";

const KEY = "lens.motion3d.templates.v1";

function store(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

function valid(t: Motion3DTemplate): boolean {
  return !!t && typeof t.id === "string" && typeof t.name === "string" && t.durationMs > 0 && validateMotion3d([segmentFromTemplate(t, 0, "check")]).length === 0;
}

export function userMotion3dTemplates(): Motion3DTemplate[] {
  const s = store();
  if (!s) return [];
  try {
    const raw = JSON.parse(s.getItem(KEY) ?? "[]") as Motion3DTemplate[];
    // skip damaged entries rather than lose the library
    return Array.isArray(raw) ? raw.filter(valid).map((t) => ({ ...t, user: true })) : [];
  } catch {
    return [];
  }
}

export function allMotion3dTemplates(): Motion3DTemplate[] {
  return [...MOTION3D_TEMPLATES, ...userMotion3dTemplates()];
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "template";
}

/** Store a template (id made unique against built-ins and saved ones). Returns what was stored. */
export function saveMotion3dTemplate(t: Motion3DTemplate): Motion3DTemplate {
  const list = userMotion3dTemplates();
  const taken = new Set([...MOTION3D_TEMPLATES, ...list].map((x) => x.id));
  let id = slug(t.id || t.name);
  for (let n = 2; taken.has(id); n++) id = `${slug(t.id || t.name)}-${n}`;
  const q: Motion3DTemplate = { ...t, id, user: true };
  store()?.setItem(KEY, JSON.stringify([...list, q]));
  return q;
}

export function deleteMotion3dTemplate(id: string): void {
  store()?.setItem(KEY, JSON.stringify(userMotion3dTemplates().filter((t) => t.id !== id)));
}

/** A template by id; "user:<id>" (as segments record it) and bare ids both work. */
export function findMotion3dTemplate(id: string): Motion3DTemplate | undefined {
  const bare = id.startsWith("user:") ? id.slice(5) : id;
  return allMotion3dTemplates().find((t) => t.id === bare && (!id.startsWith("user:") || t.user));
}
