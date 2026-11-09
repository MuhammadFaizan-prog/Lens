/** A recording bundle as served by the dev server, and the render plan built from it in the browser. */
import { buildRenderPlan, parseEventLog, parseTranscript, resolveProject } from "@lens/engine";
import type { InputEvent, ProjectConfig, RecordingMeta, RenderPlan, Transcript } from "@lens/engine";
import { CAPTION_FONT } from "../render/renderer";

export interface TrackInfo {
  width: number;
  height: number;
  fps: number;
  frames: number;
}

export interface Bundle {
  dir: string;
  name: string;
  /** The bundle had no project.json (a new recording). */
  isNew: boolean;
  meta: RecordingMeta;
  events: InputEvent[];
  project: ProjectConfig;
  transcript: Transcript | null;
  /** A microphone track exists (in-app speech-to-text can run). */
  hasMic?: boolean;
  /** Fresh desktop recording with a mic: transcribe it once when the editor opens (Windows #5). */
  autoTranscribe?: boolean;
  /** Measured silences on the mic track, recording clock (Cleanup pauses without a transcript, Windows #17). */
  silences?: Array<{ startMs: number; endMs: number }>;
  screen: TrackInfo;
  camera: TrackInfo | null;
}

export async function fetchBundle(dir?: string): Promise<Bundle> {
  const r = await fetch(`/api/bundle${dir ? `?dir=${encodeURIComponent(dir)}` : ""}`);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? `bundle: ${r.status}`);
  return {
    dir: j.dir,
    name: j.name,
    isNew: !!j.isNew,
    meta: j.meta,
    events: parseEventLog(j.events),
    project: resolveProject(j.project),
    transcript: j.transcript ? parseTranscript(j.transcript) : null,
    hasMic: !!j.hasMic,
    autoTranscribe: !!j.autoTranscribe,
    silences: Array.isArray(j.silences) ? j.silences : [],
    screen: j.screen,
    camera: j.camera,
  };
}

/** Pauses Cleanup may shorten: the transcript's measured pauses, else the mic's measured silences. */
export function planPauses(b: Pick<Bundle, "transcript" | "silences">): Array<{ startMs: number; endMs: number }> | undefined {
  return b.transcript?.pauses ?? (b.silences?.length ? b.silences : undefined);
}

export function buildPlan(b: Pick<Bundle, "meta" | "events" | "transcript" | "silences">, project: ProjectConfig): RenderPlan {
  return buildRenderPlan({ meta: b.meta, events: b.events, project, words: b.transcript?.words ?? [], pauses: planPauses(b) });
}

let fontReady: Promise<void> | null = null;
/** The caption / shortcut font the reference compositor uses (DejaVu Sans Bold), from the dev server. */
export function loadCaptionFont(): Promise<void> {
  if (!fontReady) {
    fontReady = (async () => {
      try {
        const f = new FontFace(CAPTION_FONT, "url(/api/font/caption.ttf)", { weight: "bold" });
        await f.load();
        document.fonts.add(f);
        // regular weight for annotation text that is not bold (DejaVu Sans)
        const r = new FontFace(CAPTION_FONT, "url(/api/font/caption-regular.ttf)", { weight: "normal" });
        await r.load();
        document.fonts.add(r);
      } catch {
        // fall back to the CSS stack; captions still render
      }
    })();
  }
  return fontReady;
}
