import { ui, useUi } from "../state/uiLayout";
import { useEffect, useRef, useState } from "react";
import { PlanRenderer } from "../render/renderer";
import { makeCanvas } from "../render/canvas";
import { store, useEditor } from "../state/store";
import { timecode } from "../state/timelineOps";
import { drawPlanFrame } from "./Preview";
import { Icon } from "./Icon";

const THUMB_W = 208;

/** Frame-accurate scrubber with live-rendered hover thumbnails. */
function Scrubber() {
  const frames = useEditor((s) => s.plan?.frames.length ?? 1);
  const frame = useEditor((s) => s.frame);
  const fps = useEditor((s) => s.plan?.output.fps ?? 30);
  const aspect = useEditor((s) => (s.plan ? s.plan.output.height / s.plan.output.width : 9 / 16));
  const revision = useEditor((s) => s.revision);
  const bar = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ x: number; frame: number } | null>(null);
  const renderer = useRef(new PlanRenderer());
  const full = useRef<OffscreenCanvas | HTMLCanvasElement | null>(null);
  const pending = useRef(0);

  const frameAtX = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    const u = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return { frame: Math.round(u * (frames - 1)), x: u * r.width };
  };

  useEffect(() => {
    if (!hover || !thumb.current) return;
    const plan = store.get().plan;
    if (!plan) return;
    const job = ++pending.current;
    const t = setTimeout(async () => {
      if (!full.current || full.current.width !== plan.output.width || full.current.height !== plan.output.height) full.current = makeCanvas(plan.output.width, plan.output.height);
      const g = full.current.getContext("2d") as OffscreenCanvasRenderingContext2D;
      await drawPlanFrame(renderer.current, g, plan, hover.frame);
      if (job !== pending.current || !thumb.current) return;
      const tg = thumb.current.getContext("2d")!;
      tg.imageSmoothingQuality = "high";
      tg.drawImage(full.current as CanvasImageSource, 0, 0, thumb.current.width, thumb.current.height);
      thumb.current.dataset.frame = String(hover.frame);
    }, 16);
    return () => clearTimeout(t);
  }, [hover, revision]);

  const onDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    const wasPlaying = store.get().playing;
    store.pause();
    store.seek(frameAtX(e.clientX).frame);
    const move = (ev: PointerEvent) => {
      const h = frameAtX(ev.clientX);
      store.seek(h.frame);
      setHover(h);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (wasPlaying) store.play(1);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const pct = frames > 1 ? (frame / (frames - 1)) * 100 : 0;
  const width = bar.current?.getBoundingClientRect().width ?? 1;
  return (
    <div
      className="scrubber"
      ref={bar}
      data-testid="scrubber"
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={frames - 1}
      aria-valuenow={frame}
      onPointerDown={onDown}
      onPointerMove={(e) => setHover(frameAtX(e.clientX))}
      onPointerLeave={() => setHover(null)}
    >
      <div className="scrubber-track">
        <div className="scrubber-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="scrubber-head" style={{ left: `${pct}%` }} />
      {hover && (
        <div className="thumb" style={{ left: Math.max(THUMB_W / 2, Math.min(width - THUMB_W / 2, hover.x)) }} data-testid="hover-thumb">
          <canvas ref={thumb} width={THUMB_W} height={Math.round(THUMB_W * aspect)} />
          <span>{timecode((hover.frame * 1000) / fps, fps)}</span>
        </div>
      )}
    </div>
  );
}

export function Transport() {
  const playing = useEditor((s) => s.playing);
  const rate = useEditor((s) => s.rate);
  const loop = useEditor((s) => s.loop);
  const frame = useEditor((s) => s.frame);
  const plan = useEditor((s) => s.plan);
  const fps = plan?.output.fps ?? 30;
  const n = plan?.frames.length ?? 1;
  const fs = useUi((s) => s.fullscreen);
  const zoom = useUi((s) => s.previewZoom);
  return (
    <div className="transport">
      <div className="transport-row">
        <div className="transport-buttons">
          <button className="icon-btn" title="Previous frame (←)" aria-label="Previous frame" onClick={() => store.step(-1)}>
            <Icon name="prev" />
          </button>
          <button className="play-btn" title="Play / pause (Space)" aria-label={playing ? "Pause" : "Play"} data-testid="play" onClick={() => store.toggle()}>
            <Icon name={playing ? "pause" : "play"} />
          </button>
          <button className="icon-btn" title="Next frame (→)" aria-label="Next frame" onClick={() => store.step(1)}>
            <Icon name="next" />
          </button>
        </div>
        <div className="timecode" data-testid="timecode">
          <span className="tc-now">{timecode((frame * 1000) / fps, fps)}</span>
          <span className="tc-sep">/</span>
          <span className="tc-dur">{timecode((n * 1000) / fps, fps)}</span>
        </div>
        <div className="frame-count" data-testid="frame-count">
          frame <b>{frame}</b> of {n - 1}
        </div>
        {playing && Math.abs(rate) !== 1 && <div className="rate-chip">{rate > 0 ? "▶" : "◀"} {Math.abs(rate)}×</div>}
        <div className="spacer" />
        <button className={`chip-btn ${loop ? "on" : ""}`} aria-pressed={loop} data-testid="loop" title="Loop playback" onClick={() => store.setLoop(!loop)}>
          <Icon name="loop" /> Loop
        </button>
        <div className="kbd-hint">J K L · ← → · Space · F</div>
        <div className="segmented preview-zoom" role="radiogroup" aria-label="Preview size">
          {(["fit", "100"] as const).map((z) => (
            <button key={z} role="radio" aria-checked={zoom === z} className={zoom === z ? "on" : ""} data-testid={`preview-zoom-${z}`} title={z === "fit" ? "Fit the preview to the stage" : "Actual pixels (100%)"} onClick={() => ui.setPreviewZoom(z)}>
              {z === "fit" ? "Fit" : "100%"}
            </button>
          ))}
        </div>
        <button className={`icon-btn fs-btn ${fs ? "on" : ""}`} aria-pressed={fs} aria-label={fs ? "Exit fullscreen" : "Fullscreen"} title={fs ? "Exit fullscreen (F / Esc)" : "Fullscreen preview (F)"} data-testid="fullscreen" onClick={() => ui.toggleFullscreen()}>
          {fs ? "⤡" : "⤢"}
        </button>
      </div>
      <Scrubber />
    </div>
  );
}
