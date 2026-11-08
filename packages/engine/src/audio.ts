import type { ProjectConfig } from "./project.js";
import type { TimelinePiece } from "./timeline.js";
import { sourceToOutput } from "./timeline.js";
import type { SegmentOverride } from "./types.js";

/**
 * Audio side of the render plan (AUD-04/06, EDT-05, CUR-08). The audio follows exactly the same
 * edit timeline as the video: each piece is a source range played at a rate (atempo) and a gain
 * (per-segment volume). Cut source ranges simply have no piece. Output sample positions are
 * derived from outStart/outEnd, so pieces tile the output with no drift.
 */
export interface AudioPiece {
  srcStart: number;
  srcEnd: number;
  rate: number;
  outStart: number;
  outEnd: number;
  gain: number;
}

export interface AudioPlan {
  sampleRate: number;
  durationMs: number;
  tracks: Array<{ id: string; kind: "mic" | "system"; path: string; offsetMs: number; volume: number }>;
  pieces: AudioPiece[];
  clickSound: { enabled: boolean; volume: number; times: number[] };
  noiseReduction: ProjectConfig["audio"]["noiseReduction"];
  loudness: ProjectConfig["audio"]["loudness"];
}

/** Gain multiplier from overrides at source time t (later overrides win). */
export function volumeAt(overrides: SegmentOverride[], tMs: number): number {
  let g = 1;
  for (const o of overrides) if (o.volume !== undefined && tMs >= o.startMs && tMs < o.endMs) g = o.volume;
  return g;
}

/** Split timeline pieces at override boundaries so each piece has one gain. */
export function audioPieces(timeline: TimelinePiece[], overrides: SegmentOverride[]): AudioPiece[] {
  const bounds = new Set<number>();
  for (const o of overrides) {
    if (o.volume === undefined) continue;
    bounds.add(o.startMs);
    bounds.add(o.endMs);
  }
  const out: AudioPiece[] = [];
  for (const p of timeline) {
    const cuts = [p.srcStart, ...[...bounds].filter((b) => b > p.srcStart && b < p.srcEnd).sort((a, b) => a - b), p.srcEnd];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const a = cuts[i]!;
      const b = cuts[i + 1]!;
      out.push({
        srcStart: a,
        srcEnd: b,
        rate: p.rate,
        outStart: p.outStart + (a - p.srcStart) / p.rate,
        outEnd: p.outStart + (b - p.srcStart) / p.rate,
        gain: volumeAt(overrides, (a + b) / 2),
      });
    }
  }
  return out;
}

/** Output times of click sounds: each mouse-down that survives the edit (CUR-08). */
export function clickSoundTimes(timeline: TimelinePiece[], clickSrcTimes: number[]): number[] {
  const out: number[] = [];
  for (const t of clickSrcTimes) {
    const o = sourceToOutput(timeline, t);
    if (o !== null) out.push(Math.round(o * 100) / 100);
  }
  return out.sort((a, b) => a - b);
}

export function buildAudioPlan(
  project: ProjectConfig,
  timeline: TimelinePiece[],
  durationMs: number,
  clickSrcTimes: number[],
): AudioPlan | null {
  const tracks = project.audio.tracks
    .filter((t) => !t.muted && t.volume > 0)
    .map((t) => ({ id: t.id, kind: t.kind, path: t.path, offsetMs: t.offsetMs, volume: t.volume }));
  const clicksOn = project.cursor.clickSound && project.cursor.clickSoundVolume > 0;
  if (tracks.length === 0 && !clicksOn) return null;
  return {
    sampleRate: project.audio.sampleRate,
    durationMs,
    tracks,
    pieces: audioPieces(timeline, project.overrides),
    clickSound: { enabled: clicksOn, volume: project.cursor.clickSoundVolume, times: clicksOn ? clickSoundTimes(timeline, clickSrcTimes) : [] },
    noiseReduction: project.audio.noiseReduction,
    loudness: project.audio.loudness,
  };
}
