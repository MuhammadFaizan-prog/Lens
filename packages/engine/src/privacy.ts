/**
 * Automatic privacy redaction (demand #3): review state for what the on-device scanner
 * (`redact/lens-redact`) found, and the masks an accepted detection becomes.
 *
 * The scan lives in the project as `privacy.detections`. Each detection is one review item (one
 * secret, possibly seen several times) with one or more tracks; a track is a time range with a key
 * rect per frame where the box moved. Accepting a detection adds one tracked mask per track to
 * `project.masks` (tagged with `privacyId`), so the Masks lane, the preview, the plan and the export
 * all use the ordinary mask path. Dismissing or un-reviewing removes those masks again.
 */
import type { MaskKind, MaskKey, MaskRegion, Rect } from "./types.js";
import type { ProjectConfig } from "./project.js";

export type PrivacyType = "email" | "phone" | "card" | "api_key" | "token" | "jwt" | "ip" | "notification";
export type PrivacyState = "pending" | "accepted" | "dismissed";

export const PRIVACY_TYPES: PrivacyType[] = ["email", "phone", "card", "api_key", "token", "jwt", "ip", "notification"];

export const PRIVACY_LABELS: Record<PrivacyType, string> = {
  email: "Emails",
  phone: "Phone numbers",
  card: "Card numbers",
  api_key: "API keys",
  token: "Tokens",
  jwt: "JWTs",
  ip: "IP addresses",
  notification: "Notifications",
};

export interface PrivacyTrack {
  startMs: number;
  endMs: number;
  keys: MaskKey[];
}

export interface PrivacyDetection {
  id: string;
  type: PrivacyType;
  /** Redacted label for the review list ("sk-proj-•••J0pD"); the secret itself is never stored. */
  preview: string;
  confidence: number;
  state: PrivacyState;
  /** Thumbnail file name inside the bundle's .lens-cache/privacy/ folder. */
  thumb?: string | null;
  firstMs: number;
  tracks: PrivacyTrack[];
}

export interface PrivacySettings {
  detections: PrivacyDetection[];
  /** How accepted detections are hidden. */
  maskKind: Extract<MaskKind, "blur" | "pixelate">;
  /** Blur sigma / pixel block in source px; null = the mask kind's default. */
  strength: number | null;
  /** When the last scan ran (ISO time), or null. */
  scannedAt: string | null;
}

export function defaultPrivacy(): PrivacySettings {
  return { detections: [], maskKind: "blur", strength: null, scannedAt: null };
}

function boundsOf(keys: MaskKey[]): Rect {
  const r = keys[0]!.rect;
  return { ...r };
}

/** The masks one accepted detection draws: one tracked mask per track, no fade (a fade would show
 * the secret for its first and last frames), a small feather inside the scanner's padding. */
export function privacyMasks(d: PrivacyDetection, settings: Pick<PrivacySettings, "maskKind" | "strength">): MaskRegion[] {
  return d.tracks
    .filter((t) => t.keys.length && t.endMs > t.startMs)
    .map((t, i) => ({
      id: `${d.id}-${i + 1}`,
      kind: settings.maskKind,
      rect: boundsOf(t.keys),
      keys: t.keys.map((k) => ({ tMs: k.tMs, rect: { ...k.rect } })),
      startMs: t.startMs,
      endMs: t.endMs,
      feather: 2,
      fadeMs: 0,
      ...(settings.strength != null ? { strength: settings.strength } : {}),
      privacyId: d.id,
    }));
}

/**
 * Set the review state of detections (all of them when ids is null). Accepted ones get their masks
 * in project.masks (replacing any they had); dismissed / pending ones lose them.
 */
export function reviewPrivacy(p: ProjectConfig, ids: string[] | null, state: PrivacyState): ProjectConfig {
  const pick = ids ? new Set(ids) : null;
  const touched = new Set<string>();
  const detections = p.privacy.detections.map((d) => {
    if (pick && !pick.has(d.id)) return d;
    touched.add(d.id);
    return d.state === state ? d : { ...d, state };
  });
  let masks = p.masks.filter((m) => !(m.privacyId && touched.has(m.privacyId)));
  if (state === "accepted") {
    for (const d of detections) if (touched.has(d.id)) masks = [...masks, ...privacyMasks(d, p.privacy)];
    masks = [...masks].sort((a, b) => a.startMs - b.startMs);
  }
  return { ...p, masks, privacy: { ...p.privacy, detections } };
}

/** Change how accepted detections are hidden; their masks are rebuilt. */
export function setPrivacyMaskKind(p: ProjectConfig, maskKind: PrivacySettings["maskKind"], strength: number | null = p.privacy.strength): ProjectConfig {
  const privacy = { ...p.privacy, maskKind, strength };
  const accepted = privacy.detections.filter((d) => d.state === "accepted");
  const ids = new Set(accepted.map((d) => d.id));
  const masks = [...p.masks.filter((m) => !(m.privacyId && ids.has(m.privacyId))), ...accepted.flatMap((d) => privacyMasks(d, privacy))].sort((a, b) => a.startMs - b.startMs);
  return { ...p, masks, privacy };
}

export interface PrivacyCounts {
  total: number;
  pending: number;
  accepted: number;
  dismissed: number;
}

export function privacyCounts(p: Pick<ProjectConfig, "privacy">): PrivacyCounts {
  const c = { total: 0, pending: 0, accepted: 0, dismissed: 0 };
  for (const d of p.privacy.detections) {
    c.total++;
    c[d.state]++;
  }
  return c;
}

function overlaps(a: PrivacyDetection, b: PrivacyDetection): boolean {
  return a.tracks.some((s) => b.tracks.some((t) => s.startMs < t.endMs && t.startMs < s.endMs));
}

/**
 * Replace the project's detections with a new scan. A new detection that is the same item as an
 * old one (same type and preview, overlapping in time) keeps the old review state, so a re-scan
 * does not throw away the review; accepted ones get masks from the new tracks.
 */
export function applyPrivacyScan(p: ProjectConfig, scan: { detections: PrivacyDetection[] }, scannedAt: string | null = null): ProjectConfig {
  const old = p.privacy.detections;
  const detections = scan.detections.map((d) => {
    const prev = old.find((o) => o.type === d.type && o.preview === d.preview && overlaps(o, d));
    return { ...d, state: prev ? prev.state : ("pending" as PrivacyState) };
  });
  const base: ProjectConfig = { ...p, masks: p.masks.filter((m) => !m.privacyId), privacy: { ...p.privacy, detections, scannedAt } };
  const acc = detections.filter((d) => d.state === "accepted").map((d) => d.id);
  return acc.length ? reviewPrivacy(base, acc, "accepted") : base;
}

/** Validation errors for project.privacy (empty when valid). */
export function validatePrivacy(pr: PrivacySettings): string[] {
  const errs: string[] = [];
  if (!["blur", "pixelate"].includes(pr.maskKind)) errs.push(`privacy.maskKind must be blur or pixelate, got ${String(pr.maskKind)}`);
  if (pr.strength != null && !(pr.strength > 0)) errs.push("privacy.strength must be > 0 or null");
  if (!Array.isArray(pr.detections)) return [...errs, "privacy.detections must be a list"];
  const ids = new Set<string>();
  for (const d of pr.detections) {
    if (!d || typeof d.id !== "string") {
      errs.push("privacy detection without an id");
      continue;
    }
    if (ids.has(d.id)) errs.push(`privacy detection ${d.id} is listed twice`);
    ids.add(d.id);
    if (!PRIVACY_TYPES.includes(d.type)) errs.push(`privacy detection ${d.id} has unknown type ${String(d.type)}`);
    if (!["pending", "accepted", "dismissed"].includes(d.state)) errs.push(`privacy detection ${d.id} has unknown state ${String(d.state)}`);
    if (!Array.isArray(d.tracks) || !d.tracks.length) errs.push(`privacy detection ${d.id} has no tracks`);
    else
      for (const t of d.tracks) {
        if (!(t.endMs > t.startMs)) errs.push(`privacy detection ${d.id} has a track that ends before it starts`);
        const e = validateKeys(t.keys);
        if (e) errs.push(`privacy detection ${d.id}: ${e}`);
      }
  }
  return errs;
}

/** Validation of tracked-mask keys: non-empty, sorted by time, finite positive rects. */
export function validateKeys(keys: MaskKey[] | undefined): string | null {
  if (keys === undefined) return null;
  if (!Array.isArray(keys) || !keys.length) return "keys must be a non-empty list";
  let prev = -Infinity;
  for (const k of keys) {
    if (!Number.isFinite(k?.tMs) || k.tMs < prev) return "keys must be sorted by tMs";
    prev = k.tMs;
    const r = k.rect;
    if (!r || !(r.w > 0 && r.h > 0) || ![r.x, r.y, r.w, r.h].every(Number.isFinite)) return "key rect invalid";
  }
  return null;
}
