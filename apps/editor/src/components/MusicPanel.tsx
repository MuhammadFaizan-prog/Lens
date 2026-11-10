/**
 * Music bed with automatic ducking (demand #23), on the Audio tab: add a built-in bed (made by Lens,
 * CC0) or import a file, then its level under the speech, the duck (depth, attack, hold, release),
 * fades and loop. A small graph draws the music's gain over the whole video from the plan's own
 * envelopes, with the speech it ducks under shaded, so what you see is what the preview plays and
 * the export mixes.
 */
import { useRef, useState } from "react";
import { BUILTIN_BEDS, defaultMusic, keyAt } from "@lens/engine";
import type { MusicPlan } from "@lens/engine";
import { store, useEditor } from "../state/store";
import { Section, Select, Slider, Toggle } from "./Controls";

const D = defaultMusic();
const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 2 : 0)} s` : `${Math.round(v)} ms`);
const dB = (v: number) => `${v > 0 ? "+" : ""}${v} dB`;

export function MusicSection() {
  const music = useEditor((s) => s.project.audio.music);
  const mp = useEditor((s) => s.plan?.audio?.music);
  const durationMs = useEditor((s) => (s.plan ? (s.plan.frames.length * 1000) / s.plan.output.fps : 0));
  const hasMic = useEditor((s) => !!s.bundle?.hasMic || (s.project.audio.tracks.length > 0));
  const silencesPending = useEditor((s) => !!s.bundle?.silencesPending);
  const [bed, setBed] = useState(BUILTIN_BEDS[0]!.id);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const pick = (
    <input ref={file} type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac,.opus" hidden data-testid="music-import-input"
      onChange={async (e) => {
        const f = e.target.files?.[0];
        if (f) {
          setBusy(true);
          await store.importMusic(f);
          setBusy(false);
        }
        if (file.current) file.current.value = "";
      }} />
  );
  if (!music) {
    return (
      <Section title="Music">
        <p className="note">A music bed under the whole video that ducks automatically while you talk.</p>
        <Select label="Built-in" value={bed} testId="music-builtin" options={BUILTIN_BEDS.map((b) => ({ value: b.id, label: `${b.name} (${b.mood})` }))} onChange={setBed} />
        <div className="music-row">
          <button className="btn" data-testid="music-add-builtin" disabled={busy} onClick={async () => { setBusy(true); await store.addBuiltinMusic(bed); setBusy(false); }}>Add built-in music</button>
          <button className="btn ghost" data-testid="music-import" disabled={busy} onClick={() => file.current?.click()}>Import music…</button>
          {pick}
        </div>
        <p className="note">Built-in beds are made by Lens and free to use anywhere (CC0). Imported music must be yours to use.</p>
      </Section>
    );
  }
  const set = (label: string, patch: Partial<typeof music>, live = false) => store.editMusic(label, (m) => ({ ...m, ...patch }), live);
  const setDuck = (label: string, patch: Partial<typeof music.duck>, live = false) => store.editMusic(label, (m) => ({ ...m, duck: { ...m.duck, ...patch } }), live);
  const speechN = mp?.speech.length ?? 0;
  return (
    <Section title="Music" aside={<span className="stat" data-testid="music-name" title={music.path}>{music.name || music.path.split("/").pop()}</span>}>
      <Toggle label="Music on" value={music.enabled} testId="music-on" onChange={(v) => set(v ? "Music on" : "Music off", { enabled: v })} />
      <Slider defaultValue={D.volumeDb} label="Volume (vs speech)" value={music.volumeDb} min={-40} max={0} step={1} format={dB} testId="music-volume" onChange={(v) => set("Music volume", { volumeDb: v }, true)} />
      <Toggle label="Duck under speech" value={music.duck.enabled} testId="music-duck" onChange={(v) => setDuck(v ? "Duck on" : "Duck off", { enabled: v })} />
      <Slider defaultValue={D.duck.depthDb} label="Duck depth" value={music.duck.depthDb} min={0} max={30} step={1} format={(v) => `-${v} dB`} testId="music-depth" disabled={!music.duck.enabled} onChange={(v) => setDuck("Duck depth", { depthDb: v }, true)} />
      <Slider defaultValue={D.duck.attackMs} label="Attack" value={music.duck.attackMs} min={0} max={1000} step={10} format={ms} testId="music-attack" disabled={!music.duck.enabled} onChange={(v) => setDuck("Duck attack", { attackMs: v }, true)} />
      <Slider defaultValue={D.duck.releaseMs} label="Release" value={music.duck.releaseMs} min={50} max={3000} step={50} format={ms} testId="music-release" disabled={!music.duck.enabled} onChange={(v) => setDuck("Duck release", { releaseMs: v }, true)} />
      <Slider defaultValue={D.duck.holdMs} label="Hold" value={music.duck.holdMs} min={0} max={1000} step={10} format={ms} testId="music-hold" disabled={!music.duck.enabled} onChange={(v) => setDuck("Duck hold", { holdMs: v }, true)} />
      <Slider defaultValue={D.fadeInMs} label="Fade in" value={music.fadeInMs} min={0} max={5000} step={100} format={ms} testId="music-fadein" onChange={(v) => set("Music fade in", { fadeInMs: v }, true)} />
      <Slider defaultValue={D.fadeOutMs} label="Fade out" value={music.fadeOutMs} min={0} max={5000} step={100} format={ms} testId="music-fadeout" onChange={(v) => set("Music fade out", { fadeOutMs: v }, true)} />
      <Toggle label="Loop" value={music.loop} testId="music-loop" onChange={(v) => set(v ? "Loop music" : "Don't loop music", { loop: v })} />
      {mp && durationMs > 0 && <MusicGraph m={mp} durationMs={durationMs} />}
      <p className="note" data-testid="music-status">
        {!music.duck.enabled ? "Ducking is off: the music stays at its level."
          : speechN ? `Ducks under ${speechN} stretch${speechN === 1 ? "" : "es"} of speech.`
          : !hasMic ? "No microphone track: nothing to duck under."
          : silencesPending ? "Finding the speech in the mic track…"
          : "No speech found in the mic track."}
      </p>
      <div className="music-row">
        <Select label="Replace with" value={bed} testId="music-builtin" options={BUILTIN_BEDS.map((b) => ({ value: b.id, label: b.name }))} onChange={setBed} />
        <button className="btn ghost" data-testid="music-add-builtin" disabled={busy} onClick={async () => { setBusy(true); await store.addBuiltinMusic(bed); setBusy(false); }}>Use</button>
      </div>
      <div className="music-row">
        <button className="btn ghost" data-testid="music-import" disabled={busy} onClick={() => file.current?.click()}>Replace with file…</button>
        <button className="btn ghost" data-testid="music-remove" onClick={() => store.removeMusic()}>Remove music</button>
        {pick}
      </div>
      {music.source.startsWith("builtin:") && <p className="note">Built-in bed made by Lens: free to use anywhere (CC0).</p>}
    </Section>
  );
}

/** The music's gain (duck x fade, dB) over the video, speech shaded; drawn from the plan's keys. */
function MusicGraph({ m, durationMs }: { m: MusicPlan; durationMs: number }) {
  const W = 260, H = 44, floor = -36;
  const y = (g: number) => {
    const d = g > 0 ? Math.max(floor, 20 * Math.log10(g)) : floor;
    return 2 + ((H - 4) * -d) / -floor;
  };
  const N = 130;
  const pts = Array.from({ length: N + 1 }, (_, i) => {
    const t = (i / N) * durationMs;
    return `${((i / N) * W).toFixed(1)},${y(keyAt(m.duck, t) * keyAt(m.fade, t)).toFixed(1)}`;
  }).join(" ");
  return (
    <svg className="music-graph" data-testid="music-graph" viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Music level over the video">
      <rect x={0} y={0} width={W} height={H} fill="rgba(255,255,255,0.04)" rx={4} />
      {m.speech.map((s, i) => (
        <rect key={i} data-testid="music-graph-speech" x={(s.startMs / durationMs) * W} y={0} width={Math.max(1, ((s.endMs - s.startMs) / durationMs) * W)} height={H} fill="rgba(120,170,255,0.18)" />
      ))}
      <polyline points={pts} fill="none" stroke="#f0b35a" strokeWidth={1.5} />
    </svg>
  );
}
