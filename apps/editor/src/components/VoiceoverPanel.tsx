/**
 * Audio tab > Voiceover (demand #17, docs/Voiceover.md): import narration files, record a take per
 * transcript line (or at the playhead) with the recording's own sound muted while you speak, and edit
 * the selected clip: start, trim, gain, mute, silence the original under it, remove.
 */
import { NO_CLIPS } from "./VoiceoverLane";
import { clipLengthMs } from "@lens/engine";
import { store, useEditor } from "../state/store";
import { timecode } from "../state/timelineOps";
import { Section, Slider, Toggle } from "./Controls";
import { pickVoiceFiles } from "./VoiceoverLane";

const s2 = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

export function VoiceoverSection() {
  const clips = useEditor((s) => s.project.voiceover?.clips ?? NO_CLIPS);
  const selId = useEditor((s) => s.voiceSel);
  const rec = useEditor((s) => s.voiceRec);
  const words = useEditor((s) => s.bundle?.transcript?.words);
  const fps = useEditor((s) => s.plan?.output.fps ?? 30);
  const lines = words?.length ? store.voiceLines() : [];
  const c = clips.find((x) => x.id === selId) ?? null;
  const set = (label: string, patch: Parameters<typeof store.setVoiceClip>[2], live = false) => c && store.setVoiceClip(c.id, label, patch, live);

  return (
    <Section title="Voiceover" aside={<span className="stat" data-testid="vo-count">{clips.length ? `${clips.length} clip${clips.length > 1 ? "s" : ""}` : "none"}</span>}>
      <div className="vo-row">
        <button className="chip-btn" data-testid="vo-import" disabled={!!rec} onClick={() => pickVoiceFiles()} title="Import audio files at the playhead (WAV, MP3, M4A, OGG, Opus, WebM, FLAC)">
          Import audio…
        </button>
        {rec ? (
          <button className="chip-btn rec on" data-testid="vo-stop" onClick={() => void store.stopVoiceRecording()}>
            ■ Stop recording
          </button>
        ) : (
          <button className="chip-btn rec" data-testid="vo-record-playhead" onClick={() => void store.startVoiceRecording(null)} title="Record from the microphone, starting at the playhead; the video plays with its own sound muted">
            ● Record at playhead
          </button>
        )}
      </div>
      {lines.length > 0 ? (
        <>
          <p className="note">Record a take for each line: the video plays from the line with its own sound muted. A new take replaces that line's previous one.</p>
          <div className="vo-lines" data-testid="vo-lines">
            {lines.map((l) => {
              const done = clips.some((x) => x.line?.startMs === l.startMs);
              const recording = rec?.line === l.index;
              return (
                <div key={l.index} className={`vo-line ${done ? "done" : ""} ${recording ? "rec" : ""}`} data-testid={`vo-line-${l.index}`}>
                  <span className="vo-time">{timecode(l.startMs, fps)}</span>
                  <span className="vo-text" title={l.text}>{l.text}</span>
                  {recording ? (
                    <button className="chip-btn rec on" data-testid={`vo-line-stop-${l.index}`} onClick={() => void store.stopVoiceRecording()}>■</button>
                  ) : (
                    <button className="chip-btn rec" disabled={!!rec} data-testid={`vo-line-record-${l.index}`} title={done ? "Record again (replaces the take)" : "Record this line"} onClick={() => void store.startVoiceRecording(l.index)}>
                      {done ? "↻" : "●"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <p className="note">No transcript: record at the playhead or import files. Transcribe on the Transcript tab to record line by line.</p>
      )}
      {clips.length > 0 && (
        <div data-testid="vo-clips">
          {clips.map((x) => (
            <div key={x.id} className={`vo-clip ${x.id === selId ? "on" : ""}`} data-testid={`vo-clip-${x.id}`} onClick={() => { store.selectVoice(x.id); store.seekSource(x.srcMs); }}>
              <span className="dot" />
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.name}</span>
              <span className="vo-time">{timecode(x.srcMs, fps)} · {s2(clipLengthMs(x))}{x.muted ? " · muted" : ""}</span>
            </div>
          ))}
        </div>
      )}
      {c && (
        <div data-testid="vo-selected">
          <Slider label="Start" value={c.srcMs} min={0} max={Math.max(c.srcMs, store.get().bundle?.meta.durationMs ?? 0)} step={10} format={(v) => timecode(v, fps)} testId="vo-start" onChange={(v) => set("Voiceover start", { srcMs: v }, true)} />
          <Slider label="Trim start" value={c.trimStartMs} min={0} max={Math.max(0, c.trimEndMs - 10)} step={10} format={s2} testId="vo-trim-start" defaultValue={0} onChange={(v) => set("Trim voiceover", { trimStartMs: v }, true)} />
          <Slider label="Trim end" value={c.trimEndMs} min={c.trimStartMs + 10} max={c.fileMs} step={10} format={s2} testId="vo-trim-end" defaultValue={c.fileMs} onChange={(v) => set("Trim voiceover", { trimEndMs: v }, true)} />
          <Slider label="Gain" value={c.gainDb} min={-40} max={12} step={0.5} format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`} testId="vo-gain" defaultValue={0} onChange={(v) => set("Voiceover gain", { gainDb: v }, true)} />
          <Toggle label="Mute clip" value={!!c.muted} testId="vo-mute" onChange={(v) => set(v ? "Mute voiceover" : "Unmute voiceover", { muted: v })} />
          <div className="vo-row">
            <button className="chip-btn" data-testid="vo-mute-original" title="Add a volume-0 segment on the Audio lane over this clip, so the recorded sound does not play under the narration" onClick={() => store.muteOriginalUnder(c.id)}>
              Mute original under it
            </button>
            <button className="chip-btn danger" data-testid="vo-remove" onClick={() => store.removeVoiceClip(c.id)}>
              Remove
            </button>
          </div>
          <p className="note">Clips play at normal speed from their start, after cuts; the export mixes them after noise reduction and loudness, at this gain.</p>
        </div>
      )}
    </Section>
  );
}
