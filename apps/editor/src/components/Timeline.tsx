import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { captionBlocks, captionWords } from "@lens/engine";
import { store, useEditor } from "../state/store";
import {
  addBlock,
  blocksOf,
  createRange,
  deleteBlock,
  freeSpan,
  MIN_BLOCK_MS,
  moveRange,
  normalizeCuts,
  resizeRange,
  timecode,
  updateBlock,
  type Range,
  type TrackKind,
} from "../state/timelineOps";
import { Icon } from "./Icon";

const LABEL_W = 112;
const SNAP_PX = 8;
const DEFAULT_LEN: Record<TrackKind, number> = { zoom: 2000, cut: 800, speed: 1500, mask: 2000 };
const TRACKS: Array<{ kind: TrackKind | "caption" | "audio" | "takes"; label: string }> = [
  { kind: "zoom", label: "Zoom" },
  { kind: "cut", label: "Cuts" },
  { kind: "takes", label: "Alt takes" },
  { kind: "speed", label: "Speed" },
  { kind: "mask", label: "Masks" },
  { kind: "caption", label: "Captions" },
  { kind: "audio", label: "Audio" },
];

interface DragState {
  track: TrackKind;
  index: number;
  mode: "move" | "start" | "end";
  x0: number;
  r0: Range;
  lo: number;
  hi: number;
  moved: boolean;
}

/** Ruler label in seconds: 0:05, 0:05.5 */
function rulerLabel(s: number): string {
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const whole = Math.floor(rest + 1e-9);
  const frac = rest - whole;
  return `${m}:${String(whole).padStart(2, "0")}${frac > 1e-6 ? (frac.toFixed(2).replace(/0+$/, "").slice(1)) : ""}`;
}

function niceStep(pxPerSec: number): number {
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  return steps.find((s) => s * pxPerSec >= 70) ?? 600;
}

export function Timeline() {
  const plan = useEditor((s) => s.plan);
  const project = useEditor((s) => s.project);
  const bundle = useEditor((s) => s.bundle);
  const frame = useEditor((s) => s.frame);
  const selection = useEditor((s) => s.selection);
  const audition = useEditor((s) => s.audition);
  const playing = useEditor((s) => s.playing);
  const duration = bundle?.meta.durationMs ?? 1;
  const scroller = useRef<HTMLDivElement>(null);
  const [laneW, setLaneW] = useState(800);
  const [pxPerSec, setPxPerSec] = useState<number | null>(null);
  const [snapOn, setSnapOn] = useState(true);
  const [guide, setGuide] = useState<number | null>(null);
  const drag = useRef<DragState | null>(null);
  const [, force] = useState(0);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setLaneW(el.clientWidth));
    ro.observe(el);
    setLaneW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  useEffect(() => store.audio.onChange(() => force((n) => n + 1)), []);

  const fitPps = Math.max(10, (laneW - 24) / (duration / 1000));
  const pps = pxPerSec ?? fitPps;
  const innerW = Math.max(laneW, (duration / 1000) * pps + 24);
  const xOf = (ms: number) => (ms / 1000) * pps;
  const msOf = (x: number) => (x / pps) * 1000;
  const playSrc = plan?.frames[frame]?.src ?? 0;

  // keep the playhead in view while playing
  useEffect(() => {
    const el = scroller.current;
    if (!el || !playing) return;
    const x = xOf(playSrc);
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = Math.max(0, x - 80);
  });

  const captionBlockList = useMemo(() => {
    const words = bundle?.transcript?.words ?? [];
    const cl = project.edits.cleanup;
    const cuts = plan?.cuts ?? [];
    const kept = captionWords(words, cl.enabled && cl.removeFillers, cl.fillers).filter((w) => !cuts.some((c) => (w.startMs + w.endMs) / 2 >= c.startMs && (w.startMs + w.endMs) / 2 < c.endMs));
    return captionBlocks(kept, project.captions.maxWordsPerBlock, project.captions.maxBlockMs);
  }, [bundle, plan?.cuts, project.edits.cleanup, project.captions.maxWordsPerBlock, project.captions.maxBlockMs]);

  const snapTargets = (exclude: { track: TrackKind; index: number } | null): number[] => {
    const t: number[] = [0, duration, playSrc];
    for (const k of ["zoom", "cut", "speed", "mask"] as TrackKind[]) {
      blocksOf(store.get().project, k).forEach((b, i) => {
        if (exclude && exclude.track === k && exclude.index === i) return;
        t.push(b.startMs, b.endMs);
      });
    }
    for (const z of store.get().plan?.zoomSegments ?? []) t.push(z.startMs, z.endMs);
    for (const w of bundle?.transcript?.words ?? []) t.push(w.startMs, w.endMs);
    return t;
  };

  const laneX = (clientX: number) => {
    const el = scroller.current!;
    return clientX - el.getBoundingClientRect().left + el.scrollLeft;
  };

  const startDrag = (e: React.PointerEvent, track: TrackKind, index: number, r: Range) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const off = e.clientX - rect.left;
    const mode: DragState["mode"] = off < 7 ? "start" : off > rect.width - 7 ? "end" : "move";
    let idx = index;
    if (track === "zoom") {
      // live auto zooms become editable blocks first (see freezeAutoZooms)
      const seg = store.get().plan!.zoomSegments[index]!;
      idx = store.freezeZoomsFor(seg.startMs, seg.endMs);
      if (idx < 0) return;
    }
    store.select({ track, index: idx });
    const blocks = blocksOf(store.get().project, track);
    const [lo, hi] = track === "cut" ? [0, duration] : freeSpan(blocks, (r.startMs + r.endMs) / 2, duration, idx);
    drag.current = { track, index: idx, mode, x0: e.clientX, r0: { startMs: r.startMs, endMs: r.endMs }, lo, hi, moved: false };
    store.beginGesture();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      if (!d.moved && Math.abs(ev.clientX - d.x0) < 2) return;
      d.moved = true;
      const snapOpts = snapOn && !ev.altKey ? { targets: snapTargets({ track: d.track, index: d.index }), thresholdMs: msOf(SNAP_PX) } : null;
      const delta = msOf(ev.clientX - d.x0);
      const res = d.mode === "move"
        ? moveRange(d.r0, delta, d.lo, d.hi, snapOpts)
        : resizeRange(d.r0, d.mode, (d.mode === "start" ? d.r0.startMs : d.r0.endMs) + delta, MIN_BLOCK_MS[d.track], d.lo, d.hi, snapOpts);
      setGuide(res.snapped);
      store.preview((p) => updateBlock(p, d.track, d.index, { startMs: Math.round(res.startMs), endMs: Math.round(res.endMs) }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const d = drag.current;
      drag.current = null;
      setGuide(null);
      if (!d) return;
      const verb = d.mode === "move" ? "Move" : "Resize";
      store.endGesture(`${verb} ${d.track}`, d.track === "cut" ? normalizeCuts : undefined);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const create = (track: TrackKind, t: number) => {
    const p = store.get().project;
    const r = createRange(blocksOf(p, track), t, DEFAULT_LEN[track], duration, MIN_BLOCK_MS[track]);
    if (!r) {
      store.notify("No room for a block there");
      return;
    }
    const range = { startMs: Math.round(r.startMs), endMs: Math.round(r.endMs) };
    let index = -1;
    store.edit(`Add ${track}`, (q) => {
      const out = addBlock(q, track, range, bundle?.meta.width, bundle?.meta.height);
      index = out.index;
      return track === "cut" ? normalizeCuts(out.project) : out.project;
    });
    if (track !== "cut") store.select({ track, index });
  };

  const scrubLane = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    store.select(null);
    store.pause();
    store.seekSource(msOf(laneX(e.clientX)));
    const move = (ev: PointerEvent) => store.seekSource(msOf(laneX(ev.clientX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const el = scroller.current!;
    const mx = laneX(e.clientX);
    const t = msOf(mx);
    const next = Math.max(fitPps, Math.min(2000, pps * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
    setPxPerSec(next);
    requestAnimationFrame(() => (el.scrollLeft = (t / 1000) * next - (e.clientX - el.getBoundingClientRect().left)));
  };

  const step = niceStep(pps);
  const ticks: number[] = [];
  for (let s = 0; s <= duration / 1000 + 1e-9; s += step) ticks.push(s);
  const fps = plan?.output.fps ?? 30;
  const zoomLevel = Math.round((pps / fitPps) * 100);
  const peaks = store.audio.peaks;

  const block = (track: TrackKind, i: number, r: Range, label: string, extra = "", testId?: string) => {
    const selected = selection?.track === track && selection.index === i && !extra.includes("auto");
    return (
      <div
        key={`${track}-${i}-${r.startMs}`}
        className={`block block-${track} ${selected ? "selected" : ""} ${extra}`}
        style={{ left: xOf(r.startMs), width: Math.max(4, xOf(r.endMs) - xOf(r.startMs)) }}
        onPointerDown={(e) => startDrag(e, track, i, r)}
        onDoubleClick={(e) => e.stopPropagation()}
        data-testid={testId ?? `block-${track}-${i}`}
        data-start={Math.round(r.startMs)}
        data-end={Math.round(r.endMs)}
        title={`${label} · ${timecode(r.startMs, fps)}–${timecode(r.endMs, fps)}`}
      >
        <span className="handle l" />
        <span className="block-label">{label}</span>
        <span className="handle r" />
      </div>
    );
  };

  return (
    <div className="timeline" onWheel={onWheel}>
      <div className="timeline-toolbar">
        <span className="tl-title">Timeline</span>
        <span className="tl-sub">source time · double-click a lane to add · drag to move · edges to trim · Del to remove</span>
        <div className="spacer" />
        <button className={`chip-btn ${snapOn ? "on" : ""}`} aria-pressed={snapOn} onClick={() => setSnapOn(!snapOn)} title="Snap to edges, words and playhead (hold Alt to bypass)">
          <Icon name="magnet" /> Snap
        </button>
        <label className="tl-zoom">
          <span>Zoom</span>
          <input
            type="range"
            min={100}
            max={1600}
            step={10}
            value={Math.min(1600, zoomLevel)}
            aria-label="Timeline zoom"
            data-testid="timeline-zoom"
            onChange={(e) => setPxPerSec((fitPps * Number(e.target.value)) / 100)}
          />
          <span className="num">{zoomLevel}%</span>
        </label>
        <button className="chip-btn" onClick={() => setPxPerSec(null)}>
          Fit
        </button>
      </div>
      <div className="timeline-body">
        <div className="tl-labels" style={{ width: LABEL_W }}>
          <div className="tl-ruler-spacer" />
          {TRACKS.map((t) => (
            <div key={t.kind} className={`tl-label tl-label-${t.kind}`}>
              <span className={`dot dot-${t.kind}`} />
              {t.label}
              {["zoom", "cut", "speed", "mask"].includes(t.kind) && (
                <button className="mini-add" title={`Add ${t.label.toLowerCase()} at playhead`} aria-label={`Add ${t.kind}`} data-testid={`add-${t.kind}`} onClick={() => create(t.kind as TrackKind, playSrc)}>
                  <Icon name="plus" size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="tl-scroll" ref={scroller} data-testid="timeline-scroll">
          <div className="tl-inner" style={{ width: innerW }}>
            <div className="tl-ruler" onPointerDown={scrubLane}>
              {ticks.map((s) => (
                <div key={s} className="tick" style={{ left: xOf(s * 1000) }}>
                  {xOf(s * 1000) < innerW - 44 && <span>{rulerLabel(s)}</span>}
                </div>
              ))}
            </div>
            {plan?.cuts.map((c, i) => (
              <div key={`cut-shade-${i}`} className="cut-shade" style={{ left: xOf(c.startMs), width: xOf(c.endMs) - xOf(c.startMs) }} />
            ))}
            <div className="lane" data-testid="lane-zoom" onPointerDown={scrubLane} onDoubleClick={(e) => create("zoom", msOf(laneX(e.clientX)))}>
              {plan?.zoomSegments.map((z, i) => block("zoom", i, z, `${z.scale.toFixed(1)}×${z.auto ? " auto" : ""}`, z.auto && project.zoom.auto ? "auto" : ""))}
            </div>
            <div className="lane" data-testid="lane-cut" onPointerDown={scrubLane} onDoubleClick={(e) => create("cut", msOf(laneX(e.clientX)))}>
              {(plan?.cleanupCuts ?? []).map((c, i) => (
                <div key={`cl-${i}`} className="block block-cleanup" style={{ left: xOf(c.startMs), width: Math.max(3, xOf(c.endMs) - xOf(c.startMs)) }} title="Cleanup cut (fillers / pauses)" />
              ))}
              {project.edits.cuts.map((c, i) => block("cut", i, c, "cut"))}
            </div>
            <div className={`lane lane-takes ${project.edits.takes.enabled ? "" : "off"}`} data-testid="lane-takes" onPointerDown={scrubLane}>
              {(plan?.takes ?? []).map((g, gi) => (
                <div key={`tg-${g.id}`} className="take-group" style={{ left: xOf(g.startMs), width: Math.max(6, xOf(g.endMs) - xOf(g.startMs)) }} title={`Retake group · ${g.takes.length} takes · ${g.manual ? "marked by you" : `found by ${g.cues.join(", ") || "repeat"}`}`} />
              ))}
              {(plan?.takes ?? []).flatMap((g, gi) =>
                g.takes.map((t, k) => {
                  const isKept = k === g.kept;
                  const auditioning = audition?.group === gi && audition.take === k;
                  return (
                    <div
                      key={`take-${g.id}-${k}`}
                      className={`block block-take ${isKept ? "kept" : "rejected"} ${auditioning ? "auditioning" : ""}`}
                      style={{ left: xOf(t.startMs), width: Math.max(14, xOf(t.endMs) - xOf(t.startMs)) }}
                      data-testid={`take-${gi}-${k}`}
                      data-kept={isKept ? "1" : "0"}
                      title={`Take ${k + 1} of ${g.takes.length}${isKept ? " · kept" : " · click to keep this take"} · score ${t.score.toFixed(2)} · ${timecode(t.startMs, fps)}–${timecode(t.endMs, fps)}`}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        if (e.button !== 0) return;
                        if (!isKept) store.keepTake(gi, k);
                        else store.seekSource(t.startMs);
                      }}
                    >
                      <span className="block-label">{isKept ? "✓ " : ""}Take {k + 1}</span>
                      <button
                        className="take-ab"
                        data-testid={`take-ab-${gi}-${k}`}
                        title={`A/B preview take ${k + 1}`}
                        aria-label={`Preview take ${k + 1}`}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (auditioning) store.endAudition();
                          else store.audition(gi, k);
                        }}
                      >
                        {auditioning ? "■" : "▶"}
                      </button>
                    </div>
                  );
                }),
              )}
              {project.edits.takes.enabled && !(plan?.takes ?? []).length && <span className="lane-hint">No retakes found</span>}
              {!project.edits.takes.enabled && <span className="lane-hint">Takes off · turn on in the transcript panel</span>}
            </div>
            <div className="lane" data-testid="lane-speed" onPointerDown={scrubLane} onDoubleClick={(e) => create("speed", msOf(laneX(e.clientX)))}>
              {project.edits.speed.map((s, i) => block("speed", i, s, `${s.rate}×`))}
            </div>
            <div className="lane" data-testid="lane-mask" onPointerDown={scrubLane} onDoubleClick={(e) => create("mask", msOf(laneX(e.clientX)))}>
              {project.masks.map((m, i) => block("mask", i, m, m.kind))}
            </div>
            <div className={`lane lane-caption ${project.captions.enabled ? "" : "off"}`} onPointerDown={scrubLane}>
              {captionBlockList.map((b, i) => (
                <div
                  key={`cap-${i}`}
                  className="block block-caption"
                  style={{ left: xOf(b.startMs), width: Math.max(4, xOf(b.endMs) - xOf(b.startMs)) }}
                  title={b.text}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    store.seekSource(b.startMs);
                  }}
                >
                  <span className="block-label">{b.text}</span>
                </div>
              ))}
            </div>
            <div className="lane lane-audio" onPointerDown={scrubLane}>
              <Waveform peaks={peaks} peakMs={store.audio.peakMs} width={innerW} pps={pps} offsetMs={project.audio.tracks[0]?.offsetMs ?? 0} muted={project.audio.tracks[0]?.muted ?? false} />
            </div>
            {guide !== null && <div className="snap-guide" style={{ left: xOf(guide) }} />}
            <div className="playhead" style={{ left: xOf(playSrc) }} data-testid="playhead">
              <span className="playhead-cap" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Waveform({ peaks, peakMs, width, pps, offsetMs, muted }: { peaks: Float32Array | null; peakMs: number; width: number; pps: number; offsetMs: number; muted: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const h = 44;
  const w = Math.min(16000, Math.ceil(width));
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const g = c.getContext("2d")!;
    g.clearRect(0, 0, c.width, c.height);
    if (!peaks) return;
    let max = 0.0001;
    for (const v of peaks) if (v > max) max = v;
    g.fillStyle = muted ? "#3a4250" : "#5fd4a4";
    for (let x = 0; x < c.width; x++) {
      const t0 = (x / pps) * 1000 - offsetMs;
      const t1 = ((x + 1) / pps) * 1000 - offsetMs;
      let m = 0;
      for (let k = Math.max(0, Math.floor(t0 / peakMs)); k < Math.min(peaks.length, Math.ceil(t1 / peakMs)); k++) m = Math.max(m, peaks[k]!);
      const a = Math.sqrt(m / max) * (h / 2 - 3);
      g.fillRect(x, h / 2 - a, 1, Math.max(1, a * 2));
    }
  }, [peaks, peakMs, w, pps, offsetMs, muted]);
  return <canvas ref={ref} width={w} height={h} className="waveform" data-testid="waveform" />;
}

export function deleteSelection(): boolean {
  const sel = store.get().selection;
  if (!sel) return false;
  store.edit(`Delete ${sel.track}`, (p) => deleteBlock(p, sel.track, sel.index));
  store.select(null);
  return true;
}
