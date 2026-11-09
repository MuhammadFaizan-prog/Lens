#!/usr/bin/env node
/**
 * lens-subtitles: SRT / WebVTT for a translated caption track on the recording clock (no edits).
 * Used by lens-translate; the editor and lens-plan --srt/--vtt write them on the output clock.
 *
 *   lens-subtitles --track es.track.json [--words transcript.json] [--project project.json] [--srt es.srt] [--vtt es.vtt]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolveProject } from "./project.js";
import { captionBlocks, parseTranscript, subtitleCues, toSrt, toVtt } from "./transcript.js";
import { trackWords, type CaptionTrack } from "./translation.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): number {
  const trackPath = arg("track");
  if (!trackPath) {
    console.error("usage: lens-subtitles --track t.json [--words transcript.json] [--project project.json] [--srt out.srt] [--vtt out.vtt]");
    return 2;
  }
  const track = JSON.parse(readFileSync(trackPath, "utf8")) as CaptionTrack;
  const wp = arg("words");
  const words = wp ? parseTranscript(JSON.parse(readFileSync(wp, "utf8"))).words : null;
  const pp = arg("project");
  const project = resolveProject(pp ? JSON.parse(readFileSync(pp, "utf8")) : {});
  const c = project.captions;
  const blocks = captionBlocks(trackWords(track, words), c.maxWordsPerBlock, c.maxBlockMs, c.style.maxCharsPerLine);
  const cues = subtitleCues(blocks, c.style.maxWordsPerLine, c.style.maxCharsPerLine);
  const srt = arg("srt");
  if (srt) writeFileSync(srt, toSrt(cues));
  const vtt = arg("vtt");
  if (vtt) writeFileSync(vtt, toVtt(cues, track.language));
  console.log(`lens-subtitles: ${track.language} ${cues.length} cues`);
  return 0;
}

process.exit(main());
