#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { parseEventLog } from "./events.js";
import { buildRenderPlan } from "./plan.js";
import { resolveProject, ProjectValidationError } from "./project.js";
import { applyPrivacyScan, privacyCounts, reviewPrivacy } from "./privacy.js";
import { applyStepDrafts, reviewSteps } from "./annotations.js";
import { parseTranscript, toSrt, toVtt, TranscriptError } from "./transcript.js";
import type { RecordingMeta } from "./types.js";
import { applyPreset, parsePreset, PresetError, PRESET_SECTIONS, type PresetSection } from "./presets.js";

const USAGE = `lens-plan --meta meta.json --events events.jsonl [--project project.json] [--words transcript.json]
          [--privacy-scan privacy.json [--accept-privacy]] [--step-labels steps.json [--accept-steps]]
          [--preset look.lenspreset [--preset-sections look,zoom,...]] [--captions-language es|source]
          [--srt captions.srt] [--vtt captions.vtt] [--project-out project.json] --out plan.json

Builds a render plan (per-frame camera, cursor, clicks, layout, overlays) from a cursorless
recording's metadata and its input-event log. The compositor renders the plan to video.
--words (alias --transcript) takes lens-transcribe output or a bare array of {text, startMs, endMs}.
--privacy-scan merges a lens-redact scan into project.privacy (review states of items found again are
kept); --accept-privacy accepts every detection, so each becomes a tracked mask. --step-labels merges
auto step-label drafts (lens-redact steps output); --accept-steps accepts them all as numbered badges. --project-out
writes the resulting project. --preset applies a .lenspreset (all sections, or only --preset-sections:
${PRESET_SECTIONS.join(", ")}) before planning. A warning is printed while detections are still pending review.
--captions-language picks the caption track (a translation in project.translations, or "source");
--srt / --vtt write the captions in that language on the output clock (cuts, speed, slides applied).`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): number {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const metaPath = arg("meta");
  const eventsPath = arg("events");
  const outPath = arg("out");
  if (!metaPath || !eventsPath || !outPath) {
    console.error(USAGE);
    return 2;
  }
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as RecordingMeta;
    const events = parseEventLog(readFileSync(eventsPath, "utf8"));
    const projectPath = arg("project");
    let project = resolveProject(projectPath ? JSON.parse(readFileSync(projectPath, "utf8")) : {});
    const presetPath = arg("preset");
    if (presetPath) {
      const secs = arg("preset-sections");
      const want = secs ? (secs.split(",").map((x) => x.trim()) as PresetSection[]) : PRESET_SECTIONS;
      for (const s of want) if (!PRESET_SECTIONS.includes(s)) throw new Error(`unknown preset section ${s} (${PRESET_SECTIONS.join(", ")})`);
      project = resolveProject(applyPreset(project, parsePreset(readFileSync(presetPath, "utf8")), want));
    }
    const scanPath = arg("privacy-scan");
    if (scanPath) project = applyPrivacyScan(project, JSON.parse(readFileSync(scanPath, "utf8")), new Date().toISOString());
    if (process.argv.includes("--accept-privacy")) project = reviewPrivacy(project, null, "accepted");
    const stepsPath = arg("step-labels");
    if (stepsPath) project = applyStepDrafts(project, JSON.parse(readFileSync(stepsPath, "utf8")).drafts, new Date().toISOString());
    if (process.argv.includes("--accept-steps")) project = reviewSteps(project, null, "accepted");
    const capLang = arg("captions-language");
    if (capLang) project = resolveProject({ ...project, translations: { ...project.translations, language: capLang === "source" ? null : capLang } });
    const projectOut = arg("project-out");
    if (projectOut) writeFileSync(projectOut, JSON.stringify(project, null, 1));
    const pc = privacyCounts(project);
    if (pc.pending) console.error(`warning: ${pc.pending} privacy detection${pc.pending > 1 ? "s" : ""} not reviewed (still visible in the export)`);
    const wordsPath = arg("words") ?? arg("transcript");
    const transcript = wordsPath ? parseTranscript(JSON.parse(readFileSync(wordsPath, "utf8"))) : null;
    const plan = buildRenderPlan({ meta, events, project, words: transcript?.words ?? [], pauses: transcript?.pauses });
    writeFileSync(outPath, JSON.stringify(plan));
    const srt = arg("srt");
    if (srt) writeFileSync(srt, toSrt(plan.subtitles));
    const vtt = arg("vtt");
    if (vtt) writeFileSync(vtt, toVtt(plan.subtitles, project.translations.language ?? transcript?.language ?? undefined));
    const cleaned = plan.cleanupCuts.length ? `, ${plan.cleanupCuts.length} cleanup cuts` : "";
    console.log(`plan: ${plan.output.frames} frames ${plan.output.width}x${plan.output.height}@${plan.output.fps}, ${plan.zoomSegments.length} zoom segments${cleaned} -> ${outPath}`);
    return 0;
  } catch (e) {
    if (e instanceof ProjectValidationError) console.error(`invalid project: ${e.message}`);
    else if (e instanceof PresetError) console.error(`invalid preset: ${e.message}`);
    else if (e instanceof TranscriptError) console.error(`invalid transcript: ${e.message}`);
    else console.error(e instanceof Error ? e.message : e);
    return 1;
  }
}

process.exit(main());
