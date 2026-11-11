/**
 * One recording -> several cuts (demand #15, docs/MultiAspect.md): a project can carry export targets
 * (16:9, 9:16, 1:1, 4:5, ...), each with its own framing (Fit / Fill / Follow / Custom) and, for
 * Custom, its own crop window keyframes. The editor previews and edits one target at a time (the
 * active one, mirrored in project.output so every framing control keeps working) and exports all
 * enabled targets in one batch.
 *
 * Keyframed framing: output.framingKeys [{srcMs, rect}] (source px, recording clock) animate the
 * Custom window over time (smoothstep between keys, held before the first / after the last). Each
 * frame's window becomes a screen rect covering the canvas, the same per-frame layout the Follow
 * framing already draws, so the preview renderer, the in-app export and the Python reference all
 * draw it without changes. No keys = the static framingRect, exactly as before.
 */
import type { Rect } from "./types.js";
import type { ProjectConfig } from "./project.js";
import { customWindow, FRAMING_MODES, type FramingMode } from "./framing.js";

export interface FramingKey {
  /** Source (recording) time in ms. */
  srcMs: number;
  /** Custom window in source px (same space as crop); its aspect is locked to the canvas. */
  rect: Rect;
}

export interface ExportTarget {
  id: string;
  /** "16:9", "9:16", "1:1", "4:5" or any w:h. */
  aspect: string;
  framing: FramingMode;
  framingRect?: Rect | null;
  framingKeys?: FramingKey[];
  /** Exported by "Export all formats". */
  enabled: boolean;
}

export interface ExportTargets {
  /** The target shown in the editor; its framing lives in project.output while it is active. */
  active: string;
  items: ExportTarget[];
}

/** The four social shapes offered by "Several sizes". */
export const TARGET_ASPECTS = ["16:9", "9:16", "1:1", "4:5"] as const;

export const targetIdOf = (aspect: string) => `t${aspect.replace(":", "x")}`;
/** File-name label: "9:16" -> "9x16". */
export const targetLabel = (aspect: string) => aspect.replace(":", "x");

const ease = (u: number) => u * u * (3 - 2 * u);

/** The keyed window at source time `srcMs` (unlocked; customWindow locks it to the canvas). */
export function framingKeyRect(keys: FramingKey[], srcMs: number): Rect | null {
  if (!keys.length) return null;
  const ks = [...keys].sort((a, b) => a.srcMs - b.srcMs);
  if (srcMs <= ks[0]!.srcMs) return ks[0]!.rect;
  const last = ks[ks.length - 1]!;
  if (srcMs >= last.srcMs) return last.rect;
  let i = 0;
  while (i < ks.length - 2 && ks[i + 1]!.srcMs <= srcMs) i++;
  const a = ks[i]!, b = ks[i + 1]!;
  const u = ease((srcMs - a.srcMs) / Math.max(1e-6, b.srcMs - a.srcMs));
  const l = (p: number, q: number) => p + (q - p) * u;
  return { x: l(a.rect.x, b.rect.x), y: l(a.rect.y, b.rect.y), w: l(a.rect.w, b.rect.w), h: l(a.rect.h, b.rect.h) };
}

/** True when the output's framing is Custom with crop keyframes. */
export function hasFramingKeys(output: Pick<ProjectConfig["output"], "framing" | "framingKeys">): boolean {
  return output.framing === "custom" && Array.isArray(output.framingKeys) && output.framingKeys.length > 0;
}

/** The Custom window at `srcMs`, made valid for `crop` and the canvas aspect (whole px). */
export function framingWindowAt(crop: Rect, aspect: number, output: Pick<ProjectConfig["output"], "framing" | "framingRect" | "framingKeys">, srcMs: number): Rect {
  const r = hasFramingKeys(output) ? framingKeyRect(output.framingKeys!, srcMs) : output.framingRect;
  return customWindow(crop, aspect, r);
}

/**
 * Screen rect (output px) that shows source window `win` (cropped-source px) edge to edge, through
 * the camera view [x0, x0 + vw] x [y0, y0 + vh] (a zoom magnifies about the window's centre), clamped
 * so no backdrop shows.
 */
export function windowScreenRect(out: { width: number; height: number }, src: { width: number; height: number }, win: Rect, view: { x0: number; vw: number; y0: number; vh: number }): Rect {
  const k = out.width / win.w;
  const w = src.width * k;
  const h = src.height * k;
  const cx = win.x + win.w / 2;
  const cy = win.y + win.h / 2;
  const x = Math.min(0, Math.max(out.width - w, out.width / 2 - (cx - view.x0) * (w / view.vw)));
  const y = Math.min(0, Math.max(out.height - h, out.height / 2 - (cy - view.y0) * (h / view.vh)));
  return { x, y, w, h };
}

// ------------------------------------------------------------------ targets

const framingOf = (o: ProjectConfig["output"]): FramingMode => (o.framing && (FRAMING_MODES as readonly string[]).includes(o.framing) ? o.framing : o.fit === "fill" ? "follow" : "fit");

/** The active target as the project's output currently has it. */
export function targetFromOutput(id: string, output: ProjectConfig["output"], enabled = true): ExportTarget {
  return {
    id,
    aspect: output.aspect,
    framing: framingOf(output),
    framingRect: output.framingRect ?? null,
    ...(output.framingKeys?.length ? { framingKeys: output.framingKeys.map((k) => ({ srcMs: k.srcMs, rect: { ...k.rect } })) } : {}),
    enabled,
  };
}

/** project.output with a target's aspect and framing (custom canvas size cleared). */
export function outputWithTarget(output: ProjectConfig["output"], t: ExportTarget): ProjectConfig["output"] {
  const o: ProjectConfig["output"] = { ...output, aspect: t.aspect, size: null, framing: t.framing, fit: t.framing === "follow" ? "fill" : "fit", framingRect: t.framingRect ?? null };
  if (t.framingKeys?.length) o.framingKeys = t.framingKeys.map((k) => ({ srcMs: k.srcMs, rect: { ...k.rect } }));
  else delete o.framingKeys;
  return o;
}

/** The targets with the active one refreshed from project.output (what is on screen is what is saved). */
export function syncedTargets(p: ProjectConfig): ExportTargets | null {
  const et = p.exportTargets;
  if (!et || !et.items.length) return null;
  return { ...et, items: et.items.map((t) => (t.id === et.active ? targetFromOutput(t.id, p.output, t.enabled) : t)) };
}

/**
 * Turn on several sizes: one target per shape in TARGET_ASPECTS. The current aspect (or, when it is
 * none of them, the current output as an extra first target) keeps its framing and is active; the
 * other shapes start on Follow (fill the frame, pan with the cursor / zoom target).
 */
export function enableTargets(p: ProjectConfig): ProjectConfig {
  if (p.exportTargets?.items.length) return p;
  const cur = p.output.aspect;
  const items: ExportTarget[] = [];
  const known = (TARGET_ASPECTS as readonly string[]).includes(cur);
  if (!known) items.push(targetFromOutput(targetIdOf(cur === "auto" ? "auto" : cur), p.output));
  for (const a of TARGET_ASPECTS) items.push(a === cur ? targetFromOutput(targetIdOf(a), p.output) : { id: targetIdOf(a), aspect: a, framing: "follow", framingRect: null, enabled: true });
  return { ...p, exportTargets: { active: known ? targetIdOf(cur) : items[0]!.id, items } };
}

/** Show another target: the active one's framing is saved from output, the new one's loaded into it. */
export function switchTarget(p: ProjectConfig, id: string): ProjectConfig {
  const et = syncedTargets(p);
  if (!et) return p;
  const t = et.items.find((x) => x.id === id);
  if (!t || id === et.active) return p;
  const sameShape = t.aspect === p.output.aspect;
  return { ...p, output: outputWithTarget(p.output, t), ...(sameShape ? {} : { card: null }), exportTargets: { ...et, active: id } };
}

/** Change one target (framing, enabled); the active one is changed through output too. */
export function updateTarget(p: ProjectConfig, id: string, patch: Partial<Omit<ExportTarget, "id">>): ProjectConfig {
  const et = syncedTargets(p);
  if (!et) return p;
  const items = et.items.map((t) => (t.id === id ? { ...t, ...patch } : t));
  const next = { ...p, exportTargets: { ...et, items } };
  if (id !== et.active) return next;
  const t = items.find((x) => x.id === id)!;
  return { ...next, output: outputWithTarget(p.output, t), ...(t.aspect === p.output.aspect ? {} : { card: null }) };
}

/** Back to one size: the active target stays as the project's output. */
export function disableTargets(p: ProjectConfig): ProjectConfig {
  if (!p.exportTargets) return p;
  const { exportTargets: _drop, ...rest } = p;
  return rest as ProjectConfig;
}

/** The project as one target exports it (the active target: the project as it is). */
export function projectForTarget(p: ProjectConfig, id: string): ProjectConfig {
  const et = syncedTargets(p);
  if (!et) return p;
  if (id === et.active) return { ...p, exportTargets: et };
  const t = et.items.find((x) => x.id === id);
  if (!t) throw new Error(`no export target ${id}`);
  return { ...p, output: outputWithTarget(p.output, t), ...(t.aspect === p.output.aspect ? {} : { card: null }), exportTargets: { ...et, active: id } };
}

/** The enabled targets, in list order. */
export function enabledTargets(p: ProjectConfig): ExportTarget[] {
  return syncedTargets(p)?.items.filter((t) => t.enabled) ?? [];
}

// ------------------------------------------------------------------ keys

/** Add (or replace, within half a frame) a Custom framing key at `srcMs` with window `rect`. */
export function setFramingKey(p: ProjectConfig, srcMs: number, rect: Rect, toleranceMs = 17): ProjectConfig {
  const keys = (p.output.framingKeys ?? []).filter((k) => Math.abs(k.srcMs - srcMs) > toleranceMs);
  keys.push({ srcMs: Math.round(srcMs), rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) } });
  keys.sort((a, b) => a.srcMs - b.srcMs);
  return { ...p, output: { ...p.output, framing: "custom", fit: "fit", framingKeys: keys, framingRect: p.output.framingRect ?? { ...rect } }, card: null };
}

export function removeFramingKey(p: ProjectConfig, srcMs: number): ProjectConfig {
  const keys = (p.output.framingKeys ?? []).filter((k) => k.srcMs !== srcMs);
  const output = { ...p.output };
  if (keys.length) output.framingKeys = keys;
  else delete output.framingKeys;
  return { ...p, output };
}

// ------------------------------------------------------------------ validation

const okRect = (r: unknown): r is Rect => !!r && typeof r === "object" && ["x", "y", "w", "h"].every((k) => Number.isFinite((r as Record<string, number>)[k])) && (r as Rect).w > 0 && (r as Rect).h > 0;
const okAspect = (a: unknown) => a === "auto" || (typeof a === "string" && /^\d+:\d+$/.test(a) && a.split(":").every((v) => Number(v) > 0));

export function validateFramingKeys(keys: unknown, where = "output.framingKeys"): string[] {
  if (keys === undefined) return [];
  if (!Array.isArray(keys)) return [`${where} must be a list`];
  for (const k of keys as unknown[]) {
    const o = k as Record<string, unknown>;
    if (!o || !Number.isFinite(o.srcMs) || (o.srcMs as number) < 0 || !okRect(o.rect)) return [`${where} must be [{srcMs >= 0, rect {x, y, w, h}}]`];
  }
  return [];
}

export function validateExportTargets(et: unknown): string[] {
  if (et === undefined || et === null) return [];
  const o = et as Record<string, unknown>;
  if (typeof o !== "object" || !Array.isArray(o.items) || typeof o.active !== "string") return ["exportTargets must be {active, items: [...]}"];
  const errs: string[] = [];
  const ids = new Set<string>();
  for (const it of o.items as unknown[]) {
    const t = it as Record<string, unknown>;
    if (!t || typeof t.id !== "string" || ids.has(t.id) || !okAspect(t.aspect) || !(FRAMING_MODES as readonly string[]).includes(t.framing as string) || typeof t.enabled !== "boolean" || (t.framingRect != null && !okRect(t.framingRect))) {
      errs.push("exportTargets.items[] must be {id (unique), aspect w:h, framing fit|fill|follow|custom, enabled, framingRect?}");
      break;
    }
    ids.add(t.id);
    errs.push(...validateFramingKeys(t.framingKeys, `exportTargets.items[${t.id}].framingKeys`));
  }
  if (!errs.length && (o.items as unknown[]).length && !ids.has(o.active)) errs.push(`exportTargets.active ${o.active} is not a target id`);
  return errs;
}
