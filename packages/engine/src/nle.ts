/**
 * NLE hand-off (demand #11): the edit as an editor's project file, so a Lens recording can be finished
 * in Final Cut Pro, DaVinci Resolve or Premiere.
 *
 * - FCPXML 1.9: one asset-clip per kept source range (cut points exactly as the plan's), a gap per text
 *   slide, a timeMap on sped-up ranges, a marker per zoom (scale and focus in the name), and the
 *   transparent overlay (cursor, clicks, annotations) as a connected clip on lane 1 over the whole edit.
 * - CMX3600 EDL: one event per kept range (source in / out, record in / out), M2 speed lines, zooms as
 *   `* LOC:` locators (Resolve reads them as markers) and comments.
 *
 * Every time is quantised to whole output frames (the plan's fps), the same frames the video holds.
 * Both need a plan built with `editPieces` (plan.pieces).
 */
import type { RenderPlan } from "./plan.js";

export interface NleClip {
  /** Kept source range (ms). */
  srcStart: number;
  srcEnd: number;
  /** Where it sits on the output clock (ms). */
  outStart: number;
  outEnd: number;
  rate: number;
  /** Whole output frames: record in / out, and the source in point at the output rate. */
  recIn: number;
  recOut: number;
  srcIn: number;
  srcOut: number;
}

export interface NleZoom {
  /** On the output clock (ms) and in whole output frames. */
  outStart: number;
  outEnd: number;
  recIn: number;
  recOut: number;
  /** The clip it falls in, and where in that clip's source (frames at the output rate). */
  clip: number;
  srcIn: number;
  scale: number;
  focus: [number, number] | "follow";
}

const fr = (ms: number, fps: number) => Math.round((ms * fps) / 1000 + 1e-9);

/** Kept source ranges of a plan built with editPieces, in output frames. */
export function nleClips(plan: RenderPlan): NleClip[] {
  if (!plan.pieces) throw new Error("plan has no edit pieces (build it with editPieces: true)");
  const fps = plan.output.fps;
  return plan.pieces
    .filter((p) => p.outEnd - p.outStart > 0.5)
    .map((p) => {
      const recIn = fr(p.outStart, fps);
      const recOut = Math.max(recIn + 1, fr(p.outEnd, fps));
      const srcIn = fr(p.srcStart, fps);
      return { ...p, recIn, recOut, srcIn, srcOut: Math.max(srcIn + 1, fr(p.srcEnd, fps)) };
    });
}

/** Zoom segments (scale > 1) cut to the kept ranges and moved onto the output clock. */
export function nleZooms(plan: RenderPlan, clips = nleClips(plan)): NleZoom[] {
  const fps = plan.output.fps;
  const out: NleZoom[] = [];
  for (const z of plan.zoomSegments) {
    if (!(z.scale > 1)) continue;
    clips.forEach((c, i) => {
      const a = Math.max(z.startMs, c.srcStart);
      const b = Math.min(z.endMs, c.srcEnd);
      if (b - a < 1) return;
      const o0 = c.outStart + (a - c.srcStart) / c.rate;
      const o1 = c.outStart + (b - c.srcStart) / c.rate;
      const recIn = fr(o0, fps);
      out.push({ outStart: o0, outEnd: o1, recIn, recOut: Math.max(recIn + 1, fr(o1, fps)), clip: i, srcIn: fr(a, fps), scale: z.scale,
        focus: z.focus === "follow" ? "follow" : [Math.round(z.focus.x), Math.round(z.focus.y)] });
    });
  }
  return out.sort((x, y) => x.recIn - y.recIn);
}

function zoomLabel(z: NleZoom): string {
  return `Zoom ${z.scale.toFixed(2)}x ${z.focus === "follow" ? "follow cursor" : `at ${z.focus[0]},${z.focus[1]}`}`;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** n frames at fps as an FCPXML rational time. */
function t(n: number, fps: number): string {
  return n === 0 ? "0s" : `${n * 100}/${fps * 100}s`;
}

export interface FcpxmlOptions {
  /** Project / event name. */
  name: string;
  /** file:// URL (or path relative to the .fcpxml) of the plain screen recording. */
  screenSrc: string;
  /** Source recording length (ms). */
  screenDurationMs?: number;
  /** file:// URL (or relative path) of the transparent overlay (ProRes 4444 .mov), or omit it. */
  overlaySrc?: string;
}

/** FCPXML 1.9 of the edit: cuts as clips, zooms as markers, the overlay on lane 1. */
export function toFcpxml(plan: RenderPlan, o: FcpxmlOptions): string {
  const fps = plan.output.fps;
  const { width: W, height: H } = plan.output;
  const clips = nleClips(plan);
  const zooms = nleZooms(plan, clips);
  const total = plan.frames.length;
  const srcFrames = fr(o.screenDurationMs ?? plan.source.durationMs, fps);
  const L: string[] = [];
  L.push('<?xml version="1.0" encoding="UTF-8"?>', "<!DOCTYPE fcpxml>", '<fcpxml version="1.9">', "  <resources>");
  L.push(`    <format id="r1" name="FFVideoFormat${H}p${fps}" frameDuration="${t(1, fps)}" width="${W}" height="${H}"/>`);
  L.push(`    <format id="r2" frameDuration="${t(1, fps)}" width="${plan.source.width}" height="${plan.source.height}"/>`);
  L.push(`    <asset id="r3" name="screen" uid="lens-screen" start="0s" duration="${t(srcFrames, fps)}" hasVideo="1" format="r2" src="${esc(o.screenSrc)}"/>`);
  if (o.overlaySrc) L.push(`    <asset id="r4" name="overlay" uid="lens-overlay" start="0s" duration="${t(total, fps)}" hasVideo="1" format="r1" src="${esc(o.overlaySrc)}"/>`);
  L.push("  </resources>", "  <library>", `    <event name="${esc(o.name)}">`, `      <project name="${esc(o.name)}">`);
  L.push(`        <sequence format="r1" duration="${t(total, fps)}" tcStart="0s" tcFormat="NDF">`, "          <spine>");
  let at = 0;
  let overlayDone = false;
  clips.forEach((c, i) => {
    if (c.recIn > at) L.push(`            <gap name="Slide" offset="${t(at, fps)}" duration="${t(c.recIn - at, fps)}" start="0s"/>`);
    const dur = c.recOut - c.recIn;
    L.push(`            <asset-clip name="screen ${i + 1}" ref="r3" offset="${t(c.recIn, fps)}" start="${t(c.srcIn, fps)}" duration="${t(dur, fps)}" format="r2">`);
    if (Math.abs(c.rate - 1) > 1e-6) {
      L.push("              <timeMap>", `                <timept time="0s" value="0s" interp="linear"/>`,
        `                <timept time="${t(dur, fps)}" value="${t(c.srcOut - c.srcIn, fps)}" interp="linear"/>`, "              </timeMap>");
    }
    if (o.overlaySrc && !overlayDone) {
      // connected clip: offset in the parent's own time (its start), covering the whole edit
      overlayDone = true;
      L.push(`              <asset-clip name="overlay" ref="r4" lane="1" offset="${t(c.srcIn, fps)}" start="${t(c.recIn, fps)}" duration="${t(total - c.recIn, fps)}" format="r1"/>`);
    }
    for (const z of zooms.filter((z) => z.clip === i)) {
      const local = Math.round(c.srcIn + (z.recIn - c.recIn) * c.rate);
      L.push(`              <marker start="${t(local, fps)}" duration="${t(Math.max(1, Math.round((z.recOut - z.recIn) * c.rate)), fps)}" value="${esc(zoomLabel(z))}"/>`);
    }
    L.push("            </asset-clip>");
    at = c.recOut;
  });
  if (total > at) L.push(`            <gap name="Slide" offset="${t(at, fps)}" duration="${t(total - at, fps)}" start="0s"/>`);
  L.push("          </spine>", "        </sequence>", "      </project>", "    </event>", "  </library>", "</fcpxml>", "");
  return L.join("\n");
}

/** Frames as an EDL timecode HH:MM:SS:FF (non-drop). */
export function edlTimecode(n: number, fps: number): string {
  const f = n % fps;
  const s = Math.floor(n / fps);
  const p = (v: number) => String(v).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(f)}`;
}

export interface EdlOptions {
  title: string;
  /** Clip name of the screen recording (comment line), e.g. screen.mp4. */
  clipName: string;
  /** Reel name (8 characters at most). */
  reel?: string;
}

/** CMX3600 EDL of the edit: one event per kept range, M2 speed lines, zoom locators. */
export function toEdl(plan: RenderPlan, o: EdlOptions): string {
  const fps = plan.output.fps;
  const clips = nleClips(plan);
  const zooms = nleZooms(plan, clips);
  const reel = (o.reel ?? "SCREEN").toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 8).padEnd(8, " ");
  const L: string[] = [`TITLE: ${o.title.replace(/[\r\n]/g, " ").slice(0, 70)}`, "FCM: NON-DROP FRAME", ""];
  clips.forEach((c, i) => {
    const n = String(i + 1).padStart(3, "0");
    const srcOut = c.srcIn + Math.round((c.recOut - c.recIn) * c.rate);
    L.push(`${n}  ${reel} V     C        ${edlTimecode(c.srcIn, fps)} ${edlTimecode(srcOut, fps)} ${edlTimecode(c.recIn, fps)} ${edlTimecode(c.recOut, fps)}`);
    if (Math.abs(c.rate - 1) > 1e-6) L.push(`M2   ${reel}       ${(fps * c.rate).toFixed(1).padStart(5, "0")}                ${edlTimecode(c.srcIn, fps)}`);
    L.push(`* FROM CLIP NAME: ${o.clipName}`);
    for (const z of zooms.filter((z) => z.clip === i)) {
      L.push(`* LOC: ${edlTimecode(z.recIn, fps)} YELLOW  ${zoomLabel(z).toUpperCase()}`);
      L.push(`* ZOOM ${edlTimecode(z.recIn, fps)} ${edlTimecode(z.recOut, fps)} SCALE ${z.scale.toFixed(2)}`);
    }
    L.push("");
  });
  return L.join("\n");
}
