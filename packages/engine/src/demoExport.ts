/**
 * Input for the steps exporter (compositor/export_steps.py, demand #7): the still-frame plan and a
 * manifest of steps, brand and call to action. Pure (no file system): the CLI and the editor's dev
 * server both call it, write the two JSON files and start the exporter.
 */
import { brandPalette, fontFiles, readableOn } from "./brand.js";
import { defaultDemo, demoStillFrames, demoStillProject, demoSteps, demoTitle, type DemoStep } from "./demo.js";
import { BUILTIN_FONTS, resolvePalette, type FontFiles } from "./palette.js";
import { buildRenderPlan, type RenderPlan } from "./plan.js";
import type { ProjectConfig } from "./project.js";
import type { InputEvent, RecordingMeta } from "./types.js";

export type StepsExportKind = "demo" | "guide";

export interface StepsManifest {
  version: 1;
  title: string;
  description: string;
  cta: ProjectConfig["demo"]["cta"];
  brand: {
    enabled: boolean;
    name: string;
    primary: string;
    accent: string;
    /** Backdrop of the demo page and the CTA slide (the video's theme backdrop). */
    background: { kind: "solid" | "gradient"; colors: string[]; angle: number };
    /** Text colour readable on the backdrop. */
    text: string;
    font: string;
    /** Font files for the family ("builtin:" / "system:" / bundle-relative), null = system UI font. */
    fontFiles: FontFiles | null;
    /** Logo (bundle-relative path) when the brand kit is on and has one. */
    logo: { path: string; aspect: number } | null;
  };
  still: { maxWidth: number; quality: number; zoom: "none" | "video" };
  guide: { zoom: number; boxPadding: number };
  source: { width: number; height: number };
  /** In click order; frame = index into plan.frames of the step's still. */
  steps: Array<DemoStep & { frame: number }>;
}

export interface StepsExportInput {
  plan: RenderPlan;
  manifest: StepsManifest;
}

export class DemoExportError extends Error {}

export function stepsExportInput({ meta, events, project, words }: { meta: RecordingMeta; events: InputEvent[]; project: ProjectConfig; words?: { text: string; startMs: number; endMs: number; confidence?: number }[] }): StepsExportInput {
  const steps = demoSteps(project);
  if (!steps.length) throw new DemoExportError("no accepted steps: generate step labels and accept the ones to show (lens steps generate / accept)");
  const demo = project.demo ?? defaultDemo();
  const still = demoStillProject(project);
  const full = buildRenderPlan({ meta, events, project: still, words: words as never, onlyFrames: [] });
  const want = demoStillFrames(steps, full.output.fps, full.output.frames);
  const unique = [...new Set(want)].sort((a, b) => a - b);
  const plan = buildRenderPlan({ meta, events, project: still, words: words as never, onlyFrames: unique });
  const pal = resolvePalette({ preset: project.theme?.palette ?? null, brand: brandPalette(project.brand) });
  const b = project.brand;
  const bg = plan.style.background;
  const background = { kind: bg.kind === "solid" ? ("solid" as const) : ("gradient" as const), colors: bg.kind === "image" ? [...pal.background.colors] : [...bg.colors], angle: bg.angle ?? 135 };
  const files = fontFiles(pal.font, b) ?? BUILTIN_FONTS.find((f) => f.family === pal.font) ?? null;
  return {
    plan,
    manifest: {
      version: 1,
      title: demoTitle(project),
      description: demo.description,
      cta: { ...demo.cta },
      brand: {
        enabled: !!b?.enabled,
        name: b?.enabled ? b.name : "",
        primary: pal.primary,
        accent: pal.accent,
        background,
        text: readableOn(background.colors),
        font: pal.font,
        fontFiles: files,
        logo: b?.enabled && b.logo.path ? { path: b.logo.path, aspect: b.logo.aspect } : null,
      },
      still: { maxWidth: demo.maxWidth, quality: demo.quality, zoom: demo.zoom },
      guide: { ...demo.guide },
      source: { width: meta.width, height: meta.height },
      steps: steps.map((s, i) => ({ ...s, frame: unique.indexOf(want[i]!) })),
    },
  };
}
