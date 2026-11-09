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
    screen: j.screen,
    camera: j.camera,
  };
}

export function buildPlan(b: Pick<Bundle, "meta" | "events" | "transcript">, project: ProjectConfig): RenderPlan {
  return buildRenderPlan({ meta: b.meta, events: b.events, project, words: b.transcript?.words ?? [], pauses: b.transcript?.pauses });
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
