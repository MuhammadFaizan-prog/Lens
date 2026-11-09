/**
 * Steps export (demand #7): one recording -> an interactive click-through demo and a step-by-step
 * guide, built from the same accepted step labels (demand #4) as the video's step badges.
 *
 * Clean-room, Lens's own design (docs/InteractiveDemo.md). The engine decides which steps there are,
 * where each hotspot sits in source px, and how the still frames are rendered (a derived project:
 * the video's look, crop, masks and brand, with no camera motion, cursor, captions, edits or step
 * badges). The compositor renders the stills and writes the demo / guide files
 * (compositor/lens_compositor/stepsexport.py).
 */
import type { Rect } from "./types.js";
import type { ProjectConfig } from "./project.js";
import type { StepDraft } from "./annotations.js";

/** A per-step change made in the hotspot editor; the step's label and the video stay as they are. */
export interface DemoHotspot {
  stepId: string;
  /** Hotspot position in source px (the click point when absent). */
  x?: number;
  y?: number;
  /** Tooltip text (the step label when absent). */
  tooltip?: string;
}

export interface DemoSettings {
  /** Title of the demo and guide ("" = the brand name when a brand kit is on, else "Interactive demo"). */
  title: string;
  /** One line under the guide title and on the demo's first tooltip ("" = none). */
  description: string;
  /** The last slide of the demo (and the end of the guide). */
  cta: { enabled: boolean; title: string; text: string; buttonLabel: string; url: string };
  /** Each still is the frame this long before the click (the UI before the press). */
  leadMs: number;
  /** none = the whole screen in its frame (default); video = the video's own zoom at that moment. */
  zoom: "none" | "video";
  /** Widest still in the demo, px (stills are rendered at the output size, then scaled down). */
  maxWidth: number;
  /** JPEG quality of the stills, 50..100. */
  quality: number;
  hotspots: DemoHotspot[];
  guide: {
    /** Guide screenshots are this much closer than the whole frame (crop around the click). */
    zoom: number;
    /** Highlight box around the clicked control: padding in source px. */
    boxPadding: number;
  };
}

export function defaultDemo(): DemoSettings {
  return {
    title: "",
    description: "",
    cta: { enabled: true, title: "You're all set", text: "", buttonLabel: "Get started", url: "" },
    leadMs: 80,
    zoom: "none",
    maxWidth: 1600,
    quality: 90,
    hotspots: [],
    guide: { zoom: 2, boxPadding: 6 },
  };
}

const SAFE_URL = /^(https?:\/\/|mailto:)[^\s"'<>`]+$/i;

export function validateDemo(d: DemoSettings): string[] {
  const errs: string[] = [];
  if (!d || typeof d !== "object") return ["demo must be an object"];
  if (typeof d.title !== "string" || typeof d.description !== "string") errs.push("demo.title and demo.description must be text");
  const c = d.cta;
  if (!c || typeof c.title !== "string" || typeof c.text !== "string" || typeof c.buttonLabel !== "string" || typeof c.url !== "string")
    errs.push("demo.cta needs title, text, buttonLabel and url (text)");
  else if (c.url !== "" && !SAFE_URL.test(c.url)) errs.push("demo.cta.url must be an http(s):// or mailto: link (or empty)");
  if (!(d.leadMs >= 0 && d.leadMs <= 2000)) errs.push("demo.leadMs must be within 0..2000");
  if (!["none", "video"].includes(d.zoom)) errs.push("demo.zoom must be none or video");
  if (!(Number.isInteger(d.maxWidth) && d.maxWidth >= 320 && d.maxWidth <= 3840)) errs.push("demo.maxWidth must be an integer within 320..3840");
  if (!(Number.isInteger(d.quality) && d.quality >= 50 && d.quality <= 100)) errs.push("demo.quality must be an integer within 50..100");
  if (!Array.isArray(d.hotspots)) errs.push("demo.hotspots must be a list");
  else
    for (const h of d.hotspots) {
      if (!h || typeof h.stepId !== "string") errs.push("demo hotspot needs a stepId");
      else {
        if ((h.x !== undefined && !Number.isFinite(h.x)) || (h.y !== undefined && !Number.isFinite(h.y))) errs.push(`demo hotspot ${h.stepId}: x / y must be numbers`);
        if (h.tooltip !== undefined && typeof h.tooltip !== "string") errs.push(`demo hotspot ${h.stepId}: tooltip must be text`);
      }
    }
  if (!d.guide || !(d.guide.zoom >= 1 && d.guide.zoom <= 4)) errs.push("demo.guide.zoom must be within 1..4");
  else if (!(d.guide.boxPadding >= 0 && d.guide.boxPadding <= 100)) errs.push("demo.guide.boxPadding must be within 0..100");
  return errs;
}

/** One step of the demo / guide. */
export interface DemoStep {
  /** 1-based, in click order. */
  n: number;
  stepId: string;
  clickMs: number;
  /** Hotspot in source px (the click, or the hotspot editor's position). */
  x: number;
  y: number;
  /** The click point the step label was read at (source px). */
  clickX: number;
  clickY: number;
  /** Tooltip / guide text. */
  label: string;
  /** The clicked control's box (source px) when the step labeller found one. */
  box: Rect | null;
  /** Source time of the still (clickMs - leadMs, at least 0). */
  stillMs: number;
}

/** The accepted step labels in click order, with the hotspot editor's changes applied. */
export function demoSteps(p: Pick<ProjectConfig, "stepLabels" | "demo">): DemoStep[] {
  const demo = p.demo ?? defaultDemo();
  const acc = p.stepLabels.drafts.filter((d) => d.state === "accepted").sort((a, b) => a.clickMs - b.clickMs || a.id.localeCompare(b.id));
  return acc.map((d: StepDraft, i) => {
    const h = demo.hotspots.find((o) => o.stepId === d.id);
    return {
      n: i + 1,
      stepId: d.id,
      clickMs: d.clickMs,
      x: h?.x ?? d.x,
      y: h?.y ?? d.y,
      clickX: d.x,
      clickY: d.y,
      label: (h?.tooltip ?? d.label).trim() || `Step ${i + 1}`,
      box: d.box ?? null,
      stillMs: Math.max(0, d.clickMs - demo.leadMs),
    };
  });
}

/** The demo's title: its own, else the brand name (brand kit on), else "Interactive demo". */
export function demoTitle(p: Pick<ProjectConfig, "demo" | "brand">): string {
  const t = p.demo?.title?.trim();
  if (t) return t;
  if (p.brand?.enabled && p.brand.name.trim()) return p.brand.name.trim();
  return "Interactive demo";
}

/**
 * The project the stills are rendered from: the video's look (backdrop, padding, radius, shadow,
 * crop, aspect, resolution), its privacy and hand-drawn masks and its non-step annotations and
 * watermark, but no camera motion (unless zoom = video), cursor, click effects, motion blur,
 * captions, webcam, slides, brand cards or edits, so output time equals source time and every
 * still shows the whole screen where the click happens. Step badges are left out: the hotspot and
 * tooltip take their place.
 */
export function demoStillProject(p: ProjectConfig): ProjectConfig {
  const demo = p.demo ?? defaultDemo();
  const keepZoom = demo.zoom === "video";
  return {
    ...p,
    zoom: keepZoom ? p.zoom : { ...p.zoom, auto: false, segments: [] },
    cursor: { ...p.cursor, visible: false, clickEffect: "none", clickSound: false, loopToStart: false },
    motionBlur: { ...p.motionBlur, enabled: false },
    captions: { ...p.captions, enabled: false },
    shortcuts: { ...p.shortcuts, enabled: false },
    camera: { ...p.camera, enabled: false },
    edits: {
      ...p.edits,
      cuts: [],
      speed: [],
      speedUpTyping: { ...p.edits.speedUpTyping, enabled: false },
      cleanup: { ...p.edits.cleanup, enabled: false },
      takes: { ...p.edits.takes, enabled: false },
    },
    annotations: p.annotations.filter((a) => !a.stepId),
    slides: [],
    brand: { ...p.brand, intro: { ...p.brand.intro, enabled: false }, outro: { ...p.brand.outro, enabled: false } },
    audio: { ...p.audio, tracks: [] },
  };
}

/** Output frame of each step's still in the plan of demoStillProject (output time = source time). */
export function demoStillFrames(steps: DemoStep[], fps: number, frames: number): number[] {
  return steps.map((s) => Math.min(Math.max(0, frames - 1), Math.max(0, Math.round((s.stillMs * fps) / 1000))));
}

/**
 * Set the hotspot editor's change for one step (fields left undefined stay as they are, a null field
 * goes back to the click / label, patch null clears the step's change). Returns a new project.
 */
export function setDemoHotspot<P extends Pick<ProjectConfig, "demo" | "stepLabels">>(p: P, stepId: string, patch: { x?: number | null; y?: number | null; tooltip?: string | null } | null): P {
  if (!p.stepLabels.drafts.some((d) => d.id === stepId)) throw new Error(`no step ${stepId}`);
  const demo = p.demo ?? defaultDemo();
  const rest = demo.hotspots.filter((h) => h.stepId !== stepId);
  const prev = demo.hotspots.find((h) => h.stepId === stepId) ?? { stepId };
  let next: DemoHotspot | null = null;
  if (patch) {
    next = { ...prev, stepId };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = v;
    for (const k of ["x", "y", "tooltip"] as const) if (next[k] === undefined || next[k] === null) delete next[k];
    if (next.x === undefined && next.y === undefined && next.tooltip === undefined) next = null;
  }
  const hotspots = next ? [...rest, next] : rest;
  hotspots.sort((a, b) => a.stepId.localeCompare(b.stepId));
  return { ...p, demo: { ...demo, hotspots } };
}
