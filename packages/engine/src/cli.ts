#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { parseEventLog } from "./events.js";
import { buildRenderPlan } from "./plan.js";
import { resolveProject, ProjectValidationError } from "./project.js";
import type { RecordingMeta, Word } from "./types.js";

const USAGE = `lens-plan --meta meta.json --events events.jsonl [--project project.json] [--words words.json] --out plan.json

Builds a render plan (per-frame camera, cursor, clicks, layout, overlays) from a cursorless
recording's metadata and its input-event log. The compositor renders the plan to video.`;

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
    const project = resolveProject(projectPath ? JSON.parse(readFileSync(projectPath, "utf8")) : {});
    const wordsPath = arg("words");
    const words = wordsPath ? (JSON.parse(readFileSync(wordsPath, "utf8")) as Word[]) : [];
    const plan = buildRenderPlan({ meta, events, project, words });
    writeFileSync(outPath, JSON.stringify(plan));
    console.log(`plan: ${plan.output.frames} frames ${plan.output.width}x${plan.output.height}@${plan.output.fps}, ${plan.zoomSegments.length} zoom segments -> ${outPath}`);
    return 0;
  } catch (e) {
    if (e instanceof ProjectValidationError) console.error(`invalid project: ${e.message}`);
    else console.error(e instanceof Error ? e.message : e);
    return 1;
  }
}

process.exit(main());
