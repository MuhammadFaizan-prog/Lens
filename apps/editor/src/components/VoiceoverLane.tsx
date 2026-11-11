/**
 * Voiceover lane (demand #17, docs/Voiceover.md): the project's voiceover clips on the timeline's
 * source-time axis. A clip starts at its anchor (srcMs) and is drawn as long as it plays (it plays at
 * normal speed whatever the Speed lane says, so under a speed range its block reads in output length).
 * Drag a clip to move it, drag an edge to trim it (the left edge keeps the audio where it was, like a
 * trim in any editor), click to select it: its controls are on the Audio tab. While a take records, a
 * red block grows from where it started.
 */
import { useEffect, useState } from "react";
import { clipLengthMs, updateVoiceClip, type VoiceClip } from "@lens/engine";
import { playheadSrc, store, useEditor } from "../state/store";

interface Props {
  xOf: (ms: number) => number;
  msOf: (x: number) => number;
  laneX: (clientX: number) => number;
}

export function VoiceoverLane({ xOf, msOf, laneX }: Props) {
  const clips = useEditor((s) => s.project.voiceover?.clips ?? []);
  const sel = useEditor((s) => s.voiceSel);
  const rec = useEditor((s) => s.voiceRec);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!rec) return;
    const t = setInterval(() => tick((n) => n + 1), 100);
    return () => clearInterval(t);
  }, [rec]);

  const down = (e: React.PointerEvent, c: VoiceClip, mode: "move" | "start" | "end") => {
    e.stopPropagation();
    if (e.button !== 0) return;
    store.selectVoice(c.id);
    const x0 = laneX(e.clientX);
    let moved = false;
    const patch = (dx: number): Partial<VoiceClip> => {
      const d = Math.round(msOf(dx));
      if (mode === "move") return { srcMs: Math.max(0, c.srcMs + d) };
      if (mode === "end") return { trimEndMs: c.trimEndMs + d };
      // left edge: trim the head, the rest of the audio stays put
      const ts = Math.max(0, Math.min(c.trimEndMs - 10, c.trimStartMs + d));
      return { trimStartMs: ts, srcMs: Math.max(0, c.srcMs + (ts - c.trimStartMs)) };
    };
    const move = (ev: PointerEvent) => {
      const dx = laneX(ev.clientX) - x0;
      if (!moved && Math.abs(dx) < 3) return;
      if (!moved) store.beginGesture();
      moved = true;
      store.preview((p) => ({ ...p, voiceover: updateVoiceClip(p.voiceover, c.id, patch(dx)) }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (moved) store.endGesture(mode === "move" ? "Move voiceover" : "Trim voiceover");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const recLine = rec && rec.line !== null ? store.voiceLines()[rec.line] : null;
  return (
    <>
      {clips.map((c) => {
        const len = clipLengthMs(c);
        return (
          <div
            key={c.id}
            className={`block block-voiceover ${sel === c.id ? "selected" : ""} ${c.muted ? "muted" : ""}`}
            style={{ left: xOf(c.srcMs), width: Math.max(6, xOf(c.srcMs + len) - xOf(c.srcMs)) }}
            onPointerDown={(e) => down(e, c, "move")}
            onDoubleClick={(e) => e.stopPropagation()}
            data-testid={`block-voiceover-${c.id}`}
            data-start={Math.round(c.srcMs)}
            data-end={Math.round(c.srcMs + len)}
            title={`${c.name} · ${(len / 1000).toFixed(2)} s · ${c.gainDb > 0 ? "+" : ""}${c.gainDb} dB${c.muted ? " · muted" : ""}`}
          >
            <span className="handle l" onPointerDown={(e) => down(e, c, "start")} />
            <span className="block-label">{c.line ? "🎙 " : "♪ "}{c.name}</span>
            <span className="handle r" onPointerDown={(e) => down(e, c, "end")} />
          </div>
        );
      })}
      {rec && (
        <div
          className="block block-voiceover recording"
          data-testid="voiceover-recording"
          style={{ left: xOf(rec.srcMs), width: Math.max(6, xOf(rec.srcMs + (Date.now() - rec.startedAt)) - xOf(rec.srcMs)) }}
          title={recLine ? `Recording line ${recLine.index + 1}` : "Recording"}
        >
          <span className="block-label">● REC{recLine ? ` · line ${recLine.index + 1}` : ""}</span>
        </div>
      )}
      {!clips.length && !rec && <span className="lane-hint">Narrate: + imports audio · record per line on the Audio tab</span>}
    </>
  );
}

/** Hidden file picker for the lane's "+" and the Audio tab's Import button. */
export function pickVoiceFiles(atMs = playheadSrc()): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "audio/*,.wav,.mp3,.m4a,.aac,.ogg,.opus,.webm,.flac";
  input.multiple = true;
  input.onchange = () => {
    const files = [...(input.files ?? [])];
    if (files.length) void store.importVoiceFiles(files, atMs);
  };
  input.click();
}
