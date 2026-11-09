import { useRef, useState } from "react";
import { maxZoomsPerMinute, projectPalette, springFromSettle, DEFAULT_MASK_STRENGTH } from "@lens/engine";
import type { CaptionSegment, MaskKind, ProjectConfig, ZoomPresetName } from "@lens/engine";
import { store, useEditor, TRANSLATE_LANGUAGES } from "../state/store";
import { timecode, unfreezeAutoZooms, updateBlock } from "../state/timelineOps";
import { ColorInput, Section, Segmented, Select, Slider, Toggle } from "./Controls";
import { createBlock, deleteSelection } from "./Timeline";
import { Icon } from "./Icon";
import { AnnotationCard, SlideCard } from "./AnnotationInspector";
import { BackgroundPicker } from "./BackgroundPicker";

type Tab = "look" | "zoom" | "cursor" | "camera" | "captions" | "audio";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "look", label: "Look" },
  { id: "zoom", label: "Zoom" },
  { id: "cursor", label: "Cursor" },
  { id: "camera", label: "Webcam" },
  { id: "captions", label: "Captions" },
  { id: "audio", label: "Audio" },
];

/** Original Lens backdrops. */
const BACKDROPS: Array<{ name: string; kind: "gradient" | "solid"; colors: string[] }> = [
  { name: "Tidepool", kind: "gradient", colors: ["#0f2027", "#2c5364", "#7ab8a6"] },
  { name: "Ember", kind: "gradient", colors: ["#3b0d2e", "#c2410c", "#fbbf24"] },
  { name: "Orchid", kind: "gradient", colors: ["#2e1065", "#7e22ce", "#f0abfc"] },
  { name: "Meadow", kind: "gradient", colors: ["#052e16", "#15803d", "#bef264"] },
  { name: "Graphite", kind: "solid", colors: ["#1d2027"] },
  { name: "Paper", kind: "solid", colors: ["#e8e4dc"] },
];

const pct = (v: number) => `${Math.round(v * 100)}%`;
const px = (v: number) => `${Math.round(v)} px`;
const sec = (v: number) => `${(v / 1000).toFixed(1)} s`;

/** Settle time (ms) of a critically damped spring, inverse of springFromSettle. */
function settleOf(p: ProjectConfig["zoom"]["spring"]): number {
  return Math.round((6.638 / Math.sqrt(p.stiffness / p.mass)) * 1000);
}

function SelectionCard() {
  const sel = useEditor((s) => s.selection);
  const project = useEditor((s) => s.project);
  const fps = useEditor((s) => s.plan?.output.fps ?? 30);
  if (!sel) return null;
  if (sel.track === "annotation") {
    const a = project.annotations[sel.index];
    return a ? <AnnotationCard a={a} /> : null;
  }
  if (sel.track === "slide") {
    const s = project.slides[sel.index];
    return s ? <SlideCard index={sel.index} s={s} /> : null;
  }
  const tweak = (label: string, patch: Record<string, unknown>) => store.tweak(label, (p) => updateBlock(p, sel.track, sel.index, patch));
  let body: React.ReactNode = null;
  let range: { startMs: number; endMs: number } | undefined;
  if (sel.track === "zoom") {
    const z = project.zoom.segments[sel.index];
    if (!z) return null;
    range = z;
    const meta = store.get().bundle?.meta;
    body = (
      <>
        <Slider label="Scale" value={z.scale} min={1} max={project.zoom.maxScale} step={0.05} format={(v) => `${v.toFixed(2)}×`} testId="sel-zoom-scale" onChange={(v) => tweak("Zoom scale", { scale: v })} />
        <Segmented
          label="Target"
          value={z.focus === "follow" ? "follow" : "fixed"}
          testId="sel-zoom-mode"
          options={[{ value: "follow", label: "Follow cursor" }, { value: "fixed", label: "Fixed point" }]}
          onChange={(v) => store.edit(v === "follow" ? "Zoom follows cursor" : "Zoom fixed point", (q) => updateBlock(q, "zoom", sel.index, { focus: v === "follow" ? "follow" : { x: Math.round((meta?.width ?? 1920) / 2), y: Math.round((meta?.height ?? 1080) / 2) } }))}
        />
        <p className="note">{z.focus === "follow" ? "Follows the cursor. Drag the rectangle on the preview to pin it to a point." : `Fixed on ${Math.round(z.focus.x)}, ${Math.round(z.focus.y)} px. Drag the rectangle to move it, its corners to change the zoom.`}</p>
      </>
    );
  } else if (sel.track === "speed") {
    const s = project.edits.speed[sel.index];
    if (!s) return null;
    range = s;
    body = <Slider label="Rate" value={s.rate} min={0.25} max={8} step={0.25} format={(v) => `${v}×`} testId="sel-speed-rate" onChange={(v) => tweak("Speed rate", { rate: v })} />;
  } else if (sel.track === "mask") {
    const m = project.masks[sel.index];
    if (!m) return null;
    range = m;
    const strength = m.strength ?? DEFAULT_MASK_STRENGTH[m.kind];
    const sr = m.kind === "spotlight" ? { min: 0.1, max: 0.95, step: 0.05, f: pct } : m.kind === "blur" ? { min: 2, max: 40, step: 1, f: px } : { min: 4, max: 48, step: 1, f: px };
    body = (
      <>
        <Segmented<MaskKind>
          label="Kind"
          value={m.kind}
          options={[{ value: "blur", label: "Blur" }, { value: "pixelate", label: "Pixelate" }, { value: "spotlight", label: "Spotlight" }]}
          onChange={(k) => store.edit("Mask kind", (p) => updateBlock(p, "mask", sel.index, { kind: k, strength: DEFAULT_MASK_STRENGTH[k] }))}
        />
        <Slider label={m.kind === "spotlight" ? "Dim" : m.kind === "blur" ? "Blur" : "Block"} value={strength} min={sr.min} max={sr.max} step={sr.step} format={sr.f} onChange={(v) => tweak("Mask strength", { strength: v })} />
        <Slider label="Feather" value={m.feather} min={0} max={40} step={1} format={px} onChange={(v) => tweak("Mask feather", { feather: v })} />
        {m.keys?.length ? (
          <p className="note" data-testid="sel-mask-tracked">Tracked: follows the content ({m.keys.length} keys){m.privacyId ? `, from privacy item ${m.privacyId}` : ""}.</p>
        ) : (
          <>
          <Slider label="X" value={m.rect.x} min={0} max={(store.get().bundle?.meta.width ?? 1920) - 10} step={2} format={px} onChange={(v) => tweak("Mask position", { rect: { ...m.rect, x: v } })} />
          <Slider label="Y" value={m.rect.y} min={0} max={(store.get().bundle?.meta.height ?? 1080) - 10} step={2} format={px} onChange={(v) => tweak("Mask position", { rect: { ...m.rect, y: v } })} />
          <Slider label="Width" value={m.rect.w} min={10} max={store.get().bundle?.meta.width ?? 1920} step={2} format={px} onChange={(v) => tweak("Mask size", { rect: { ...m.rect, w: v } })} />
          <Slider label="Height" value={m.rect.h} min={10} max={store.get().bundle?.meta.height ?? 1080} step={2} format={px} onChange={(v) => tweak("Mask size", { rect: { ...m.rect, h: v } })} />
          </>
        )}
      </>
    );
  } else if (sel.track === "caption") {
    const c = (project.captions.cues ?? [])[sel.index];
    if (!c) return null;
    range = c;
    const playSrc = store.get().plan?.frames[store.get().frame]?.src;
    body = (
      <>
        <textarea className="cue-text" data-testid="sel-cue-text" defaultValue={c.text} key={c.id + c.text} rows={2}
          onKeyDown={(e) => e.stopPropagation()}
          onBlur={(e) => { const t = e.target.value.replace(/\s+/g, " ").trim(); if (t !== c.text) store.updateCue(c.id, { text: t }); }} />
        <div className="cue-actions">
          <button className="chip-btn" data-testid="sel-cue-split" title="Split at the playhead" onClick={() => store.splitCueAt(c.id, playSrc)}>Split</button>
          <button className="chip-btn" data-testid="sel-cue-merge" title="Merge with the next caption" onClick={() => store.mergeCueWithNext(c.id)}>Merge next</button>
        </div>
      </>
    );
  } else if (sel.track === "volume") {
    const o = project.overrides.filter((x) => x.volume !== undefined)[sel.index];
    if (!o) return null;
    range = o;
    body = <Slider label="Volume" value={o.volume ?? 1} min={0} max={2} step={0.05} format={pct} testId="sel-volume" onChange={(v) => tweak("Segment volume", { volume: v })} />;
  } else {
    const c = project.edits.cuts[sel.index];
    if (!c) return null;
    range = c;
  }
  return (
    <div className="selection-card" data-testid="selection-card">
      <div className="sel-head">
        <span className={`dot dot-${sel.track}`} />
        <b>{({ cut: "Cut", zoom: "Zoom block", speed: "Speed range", mask: "Mask", caption: "Caption", volume: "Volume segment" } as Record<string, string>)[sel.track] ?? sel.track}</b>
        {range && (
          <span className="sel-time">
            {timecode(range.startMs, fps)} – {timecode(range.endMs, fps)}
          </span>
        )}
        <button className="icon-btn danger" title="Delete (Del)" aria-label="Delete selection" data-testid="delete-selection" onClick={() => deleteSelection()}>
          <Icon name="trash" />
        </button>
      </div>
      {body}
    </div>
  );
}

function LookTab({ p }: { p: ProjectConfig }) {
  const t = (label: string, fn: (q: ProjectConfig) => ProjectConfig) => store.tweak(label, fn);
  // the backdrop as drawn: the theme's (preset palette < brand kit) while it inherits
  const pal = projectPalette(p);
  const bgNow = p.background.inherit ? { ...p.background, kind: pal.background.kind, colors: pal.background.colors, angle: pal.background.angle } : p.background;
  const own = (q: ProjectConfig): ProjectConfig["background"] => (q.background.inherit ? { ...q.background, ...{ kind: pal.background.kind, colors: [...pal.background.colors], angle: pal.background.angle }, inherit: false } : q.background);
  const themeCss = pal.background.colors.length > 1 ? `linear-gradient(135deg, ${pal.background.colors.join(", ")})` : pal.background.colors[0];
  return (
    <>
      <BackgroundPicker p={p} />
      <Section title="Frame">
        <Slider label="Padding" value={p.frame.padding} min={0} max={0.25} step={0.005} format={pct} testId="padding" onChange={(v) => t("Padding", (q) => ({ ...q, frame: { ...q.frame, padding: v } }))} />
        <Slider label="Radius" value={p.frame.radius} min={0} max={60} step={1} format={px} testId="radius" onChange={(v) => t("Corner radius", (q) => ({ ...q, frame: { ...q.frame, radius: v } }))} />
        <Slider label="Shadow" value={p.frame.shadow.opacity} min={0} max={1} step={0.01} format={pct} testId="shadow" onChange={(v) => t("Shadow", (q) => ({ ...q, frame: { ...q.frame, shadow: { ...q.frame.shadow, opacity: v } } }))} />
        <Slider label="Softness" value={p.frame.shadow.blur} min={0} max={120} step={1} format={px} onChange={(v) => t("Shadow softness", (q) => ({ ...q, frame: { ...q.frame, shadow: { ...q.frame.shadow, blur: v } } }))} />
        <Slider label="Lift" value={p.frame.shadow.offsetY} min={0} max={60} step={1} format={px} onChange={(v) => t("Shadow offset", (q) => ({ ...q, frame: { ...q.frame, shadow: { ...q.frame.shadow, offsetY: v } } }))} />
      </Section>
      <Section title="Output">
        <Segmented label="Aspect" value={p.output.aspect} testId="aspect" options={["16:9", "1:1", "4:5", "9:16"].map((a) => ({ value: a, label: a }))} onChange={(v) => store.edit(`Aspect ${v}`, (q) => ({ ...q, output: { ...q.output, aspect: v } }))} />
        <Segmented label="Screen" value={p.output.fit ?? "fit"} testId="output-fit" options={[{ value: "fit", label: "Fit" }, { value: "fill", label: "Fill & follow" }]}
          onChange={(v) => store.edit(v === "fill" ? "Fill frame and follow" : "Fit whole screen", (q) => ({ ...q, output: { ...q.output, fit: v as "fit" | "fill" } }))} />
        {p.output.aspect !== "16:9" && <p className="note">Fill crops in to the frame and pans with the cursor or a fixed zoom target; Fit shows the whole screen.</p>}
      </Section>
    </>
  );
}

function ZoomTab({ p }: { p: ProjectConfig }) {
  const segs = useEditor((s) => s.plan?.zoomSegments);
  const durationMs = useEditor((s) => s.bundle?.meta.durationMs ?? 1);
  const t = (label: string, fn: (z: ProjectConfig["zoom"]) => Partial<ProjectConfig["zoom"]>) => store.tweak(label, (q) => ({ ...q, zoom: { ...q.zoom, ...fn(q.zoom), preset: "custom" } }));
  const n = segs?.length ?? 0;
  const perMin = segs ? maxZoomsPerMinute(segs) : 0;
  return (
    <>
      <Section title="Auto zoom" aside={<span className="stat" data-testid="zoom-stats">{n} zoom{n === 1 ? "" : "s"} · {durationMs >= 60000 ? `${perMin}/min peak` : `${perMin} in ${Math.round(durationMs / 1000)} s`}</span>}>
        <Toggle label="Zoom on clicks & typing" value={p.zoom.auto} testId="auto-zoom" onChange={(v) => store.edit(v ? "Auto zoom on" : "Auto zoom off", (q) => (v ? unfreezeAutoZooms(q) : { ...q, zoom: { ...q.zoom, auto: false, segments: q.zoom.segments.filter((s) => !s.auto) } }))} />
        <Segmented<ZoomPresetName | "custom">
          label="Intensity"
          stacked
          value={p.zoom.preset}
          testId="zoom-preset"
          options={[
            { value: "calm", label: "Calm", hint: "Slower springs, smaller zooms, budget on" },
            { value: "default", label: "Default", hint: "Engine defaults" },
            { value: "punchy", label: "Punchy", hint: "Fast springs, bigger zooms" },
            ...(p.zoom.preset === "custom" ? [{ value: "custom" as const, label: "Custom" }] : []),
          ]}
          onChange={(v) => v !== "custom" && store.applyPreset(v)}
        />
        <Slider label="Depth" value={p.zoom.defaultScale} min={p.zoom.minScale} max={p.zoom.maxScale} step={0.05} format={(v) => `${v.toFixed(2)}×`} testId="zoom-depth" onChange={(v) => t("Zoom depth", () => ({ defaultScale: v }))} />
        <Slider label="Settle" value={settleOf(p.zoom.spring)} min={300} max={2400} step={50} format={sec} testId="zoom-settle" onChange={(v) => t("Zoom speed", () => ({ spring: springFromSettle(v, 1) }))} />
        <Slider label="Hold" value={p.zoom.holdMs} min={300} max={4000} step={100} format={sec} onChange={(v) => t("Zoom hold", () => ({ holdMs: v }))} />
        <Slider label="Pan later" value={p.zoom.followDeadzone} min={0.1} max={0.9} step={0.05} format={pct} onChange={(v) => t("Follow deadzone", () => ({ followDeadzone: v }))} />
      </Section>
      <Section title="Zoom budget" aside={<span className="stat">calm camera</span>}>
        <Toggle label="Limit how often it zooms" value={p.zoom.budget.enabled} testId="budget" onChange={(v) => store.edit(v ? "Zoom budget on" : "Zoom budget off", (q) => ({ ...q, zoom: { ...q.zoom, budget: { ...q.zoom.budget, enabled: v }, preset: "custom" } }))} />
        <Slider label="Max / minute" value={p.zoom.budget.maxPerMinute} min={1} max={12} step={1} testId="budget-max" onChange={(v) => t("Zoom budget", (z) => ({ budget: { ...z.budget, maxPerMinute: v } }))} />
        <Slider label="Min hold" value={p.zoom.budget.minHoldMs} min={500} max={6000} step={100} format={sec} testId="budget-hold" onChange={(v) => t("Zoom min hold", (z) => ({ budget: { ...z.budget, minHoldMs: v } }))} />
      </Section>
    </>
  );
}

function CursorTab({ p }: { p: ProjectConfig }) {
  const t = (label: string, fn: (c: ProjectConfig["cursor"]) => Partial<ProjectConfig["cursor"]>) => store.tweak(label, (q) => ({ ...q, cursor: { ...q.cursor, ...fn(q.cursor) } }));
  return (
    <>
      <Section title="Cursor">
        <Toggle label="Show cursor" value={p.cursor.visible} onChange={(v) => store.edit("Cursor visibility", (q) => ({ ...q, cursor: { ...q.cursor, visible: v } }))} />
        <Slider label="Size" value={p.cursor.size} min={0.5} max={4} step={0.1} format={(v) => `${v.toFixed(1)}×`} testId="cursor-size" onChange={(v) => t("Cursor size", () => ({ size: v }))} />
        <Toggle label="Smooth movement" value={p.cursor.smoothing.enabled} testId="cursor-smoothing" onChange={(v) => store.edit("Cursor smoothing", (q) => ({ ...q, cursor: { ...q.cursor, smoothing: { ...q.cursor.smoothing, enabled: v } } }))} />
        <Slider label="Smoothing" value={settleOf(p.cursor.smoothing.spring)} min={60} max={800} step={10} format={(v) => `${v} ms`} testId="cursor-smooth-ms" onChange={(v) => t("Cursor smoothing", (c) => ({ smoothing: { ...c.smoothing, spring: springFromSettle(v, 1) } }))} />
        <Toggle label="Hide when idle" value={p.cursor.hideWhenIdle} onChange={(v) => store.edit("Idle hide", (q) => ({ ...q, cursor: { ...q.cursor, hideWhenIdle: v } }))} />
        <Select label="Click effect" value={p.cursor.clickEffect} options={[{ value: "ripple", label: "Ripple" }, { value: "circle", label: "Pulse" }, { value: "highlight", label: "Glow" }, { value: "none", label: "None" }]} onChange={(v) => store.edit("Click effect", (q) => ({ ...q, cursor: { ...q.cursor, clickEffect: v } }))} />
      </Section>
      <Section title="Motion blur">
        <Toggle label="Motion blur" value={p.motionBlur.enabled} testId="motion-blur" onChange={(v) => store.edit("Motion blur", (q) => ({ ...q, motionBlur: { ...q.motionBlur, enabled: v } }))} />
        <Slider label="Shutter" value={p.motionBlur.strength} min={0.05} max={1} step={0.05} format={pct} onChange={(v) => store.tweak("Motion blur", (q) => ({ ...q, motionBlur: { ...q.motionBlur, strength: v } }))} />
      </Section>
    </>
  );
}

function CameraTab({ p }: { p: ProjectConfig }) {
  const hasCam = useEditor((s) => !!s.bundle?.camera);
  const t = (label: string, fn: (c: ProjectConfig["camera"]) => Partial<ProjectConfig["camera"]>) => store.tweak(label, (q) => ({ ...q, camera: { ...q.camera, ...fn(q.camera) } }));
  return (
    <Section title="Webcam" aside={!hasCam ? <span className="stat">no webcam track</span> : undefined}>
      <Toggle label="Show webcam" value={p.camera.enabled} testId="cam-enabled" onChange={(v) => store.edit(v ? "Webcam on" : "Webcam off", (q) => ({ ...q, camera: { ...q.camera, enabled: v } }))} />
      <Select label="Corner" value={p.camera.corner} options={[{ value: "bottom-right", label: "Bottom right" }, { value: "bottom-left", label: "Bottom left" }, { value: "top-right", label: "Top right" }, { value: "top-left", label: "Top left" }]} onChange={(v) => store.edit("Webcam corner", (q) => ({ ...q, camera: { ...q.camera, corner: v } }))} />
      <Slider label="Size" value={p.camera.size} min={0.12} max={0.45} step={0.01} format={pct} testId="cam-size" onChange={(v) => t("Webcam size", () => ({ size: v }))} />
      <Segmented label="Shape" value={p.camera.shape} options={[{ value: "rounded", label: "Rounded" }, { value: "circle", label: "Circle" }, { value: "square", label: "Square" }]} onChange={(v) => store.edit("Webcam shape", (q) => ({ ...q, camera: { ...q.camera, shape: v } }))} />
      <Toggle label="Mirror" value={p.camera.mirror} onChange={(v) => store.edit("Webcam mirror", (q) => ({ ...q, camera: { ...q.camera, mirror: v } }))} />
      <Slider label="Shrink on zoom" value={p.camera.zoomedSize} min={0.3} max={1} step={0.05} format={pct} testId="cam-shrink" onChange={(v) => t("Webcam shrink", () => ({ zoomedSize: v }))} />
    </Section>
  );
}

function CaptionsTab({ p }: { p: ProjectConfig }) {
  const hasWords = useEditor((s) => (s.bundle?.transcript?.words.length ?? 0) > 0);
  const cs = p.captions.style;
  const t = (label: string, fn: (c: ProjectConfig["captions"]["style"]) => Partial<ProjectConfig["captions"]["style"]>) => store.tweak(label, (q) => ({ ...q, captions: { ...q.captions, style: { ...q.captions.style, ...fn(q.captions.style) } } }));
  return (
    <>
    <Section title="Captions" aside={!hasWords ? <span className="stat">no transcript</span> : undefined}>
      <Toggle label="Burn in captions" value={p.captions.enabled} testId="captions-enabled" onChange={(v) => store.edit(v ? "Captions on" : "Captions off", (q) => ({ ...q, captions: { ...q.captions, enabled: v } }))} />
      <Toggle label="Highlight spoken word" value={p.captions.wordHighlight} testId="word-highlight" onChange={(v) => store.edit("Word highlight", (q) => ({ ...q, captions: { ...q.captions, wordHighlight: v } }))} />
      <Slider label="Size" value={cs.fontSize} min={24} max={84} step={1} format={px} testId="caption-size" onChange={(v) => t("Caption size", () => ({ fontSize: v }))} />
      <Segmented label="Position" value={cs.position === "custom" ? "bottom" : cs.position} options={[{ value: "top", label: "Top" }, { value: "bottom", label: "Bottom" }]} onChange={(v) => store.edit("Caption position", (q) => ({ ...q, captions: { ...q.captions, style: { ...q.captions.style, position: v } } }))} />
      <Slider label="Words / line" value={cs.maxWordsPerLine} min={2} max={10} step={1} onChange={(v) => t("Words per line", () => ({ maxWordsPerLine: v }))} />
      <Slider label="Chars / line" value={cs.maxCharsPerLine} min={0} max={80} step={1} format={(v) => (v ? String(v) : "off")} testId="caption-chars" onChange={(v) => t("Characters per line", () => ({ maxCharsPerLine: v }))} />
      <ColorInput label="Highlight" value={cs.highlightColor} testId="caption-highlight" onChange={(v) => t("Highlight colour", () => ({ highlightColor: v }))}
        onReset={() => store.edit("Highlight follows theme", (q) => ({ ...q, captions: { ...q.captions, style: { ...q.captions.style, highlightColor: "@highlight" } } }))} />
      <ColorInput label="Text" value={cs.textColor} onChange={(v) => t("Caption colour", () => ({ textColor: v }))} />
      <Toggle label="Backing pill" value={cs.background.enabled} onChange={(v) => store.edit("Caption pill", (q) => ({ ...q, captions: { ...q.captions, style: { ...q.captions.style, background: { ...q.captions.style.background, enabled: v } } } }))} />
      <Slider label="Pill opacity" value={cs.background.opacity} min={0} max={1} step={0.02} format={pct} onChange={(v) => t("Pill opacity", (c) => ({ background: { ...c.background, opacity: v } }))} />
    </Section>
    <ManualCaptions p={p} />
    </>
  );
}

/** Hand-written captions (Windows bug #15): add at the playhead, edit, retime, split, merge, import / export. */
function ManualCaptions({ p }: { p: ProjectConfig }) {
  const fps = useEditor((s) => s.plan?.output.fps ?? 30);
  const sel = useEditor((s) => s.selection);
  const cues = p.captions.cues ?? [];
  const file = useRef<HTMLInputElement>(null);
  const playSrc = () => store.get().plan?.frames[store.get().frame]?.src ?? 0;
  return (
    <Section title="Your captions" aside={<span className="stat">{cues.length}</span>}>
      <div className="cue-actions">
        <button className="btn" data-testid="cue-add" onClick={() => createBlock("caption", playSrc())}>+ Caption at playhead</button>
        <input ref={file} type="file" accept=".srt,.vtt,text/vtt" hidden data-testid="cue-import-input" onChange={async (e) => { const f = e.target.files?.[0]; if (f) store.importSubtitles(await f.text(), cues.length === 0 || confirmReplace()); if (file.current) file.current.value = ""; }} />
        <button className="btn ghost" data-testid="cue-import" onClick={() => file.current?.click()}>Import SRT / VTT</button>
      </div>
      {cues.length === 0 && <p className="note">Works without a transcript: add a caption, type its text, drag its edges on the Captions lane to time it.</p>}
      <ol className="cue-list" data-testid="cue-list">
        {cues.map((c, i) => (
          <li key={c.id} className={sel?.track === "caption" && sel.index === i ? "on" : ""} data-testid={`cue-row-${i}`}>
            <button className="cue-time" title="Select and jump" onClick={() => { store.select({ track: "caption", index: i }); store.seekSource(c.startMs); }}>
              {timecode(c.startMs, fps)}
            </button>
            <input className="cue-input" data-testid={`cue-text-${i}`} defaultValue={c.text} key={c.id + c.text}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              onBlur={(e) => { const t = e.target.value.replace(/\s+/g, " ").trim(); if (t !== c.text) store.updateCue(c.id, { text: t }); }} />
            <button className="mini-reset" title="Delete caption" aria-label="Delete caption" onClick={() => store.deleteCue(c.id)}>×</button>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function confirmReplace(): boolean {
  // Electron has no window.confirm in some builds: default to appending when it is missing
  try {
    return typeof window.confirm === "function" ? window.confirm("Replace your captions with the imported ones? (Cancel appends)") : false;
  } catch {
    return false;
  }
}

function download(name: string, text: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** One translated segment beside its source (demand #8): edit the translation, commit on blur or Enter. */
function SegmentRow({ language, rtl, seg }: { language: string; rtl: boolean; seg: CaptionSegment }) {
  const [text, setText] = useState(seg.text);
  const [prev, setPrev] = useState(seg.text);
  if (prev !== seg.text) {
    setPrev(seg.text);
    setText(seg.text);
  }
  const commit = () => store.editTranslation(language, seg.id, text);
  return (
    <div className="tr-row" data-testid={`tr-seg-${seg.id}`}>
      <button type="button" className="tr-time stat" title="Go to this segment" onClick={() => store.seekSource(seg.startMs + 1)}>
        {(seg.startMs / 1000).toFixed(1)}s
      </button>
      <div className="tr-src" data-testid={`tr-src-${seg.id}`}>{seg.source}</div>
      <textarea
        className="tr-text"
        dir={rtl ? "rtl" : "ltr"}
        lang={language}
        rows={2}
        value={text}
        aria-label={`Translation of: ${seg.source}`}
        data-testid={`tr-text-${seg.id}`}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            commit();
          }
          e.stopPropagation();
        }}
      />
      {seg.edited && <span className="tr-edited stat">edited</span>}
    </div>
  );
}

function LanguagesSection({ p }: { p: ProjectConfig }) {
  const hasWords = useEditor((s) => (s.bundle?.transcript?.words.length ?? 0) > 0);
  const srcLang = useEditor((s) => s.bundle?.transcript?.language || "en");
  const run = useEditor((s) => s.translateRun);
  const unavailable = useEditor((s) => s.bundle?.translateUnavailable ?? null);
  const tr = p.translations;
  const missing = TRANSLATE_LANGUAGES.filter((l) => !tr.tracks.some((t) => t.language === l.code));
  const [pick, setPick] = useState<string>(missing[0]?.code ?? TRANSLATE_LANGUAGES[0]!.code);
  const busy = !!run && ["starting", "running"].includes(run.state);
  const current = tr.language ? tr.tracks.find((t) => t.language === tr.language) : undefined;
  const nameOf = (code: string) => TRANSLATE_LANGUAGES.find((l) => l.code === code);
  const langOptions = [
    { value: "", label: `${srcLang === "en" ? "English" : srcLang} (source)` },
    ...tr.tracks.map((t) => ({ value: t.language, label: `${t.name ?? t.language}${nameOf(t.language) ? ` · ${nameOf(t.language)!.english}` : ""}` })),
  ];
  const pct = run && run.total ? ((run.index + run.done / run.total) / Math.max(1, run.languages)) * 100 : run?.stage === "done" ? 100 : 4;
  return (
    <Section title="Languages" aside={<span className="stat">on-device</span>}>
      <Select label="Caption language" value={tr.language ?? ""} options={langOptions} testId="caption-language" onChange={(v) => store.setCaptionLanguage(v || null)} />
      <div className="ctl tr-translate">
        <span className="ctl-label">Translate to…</span>
        <select value={pick} aria-label="Translate to" data-testid="translate-to" onChange={(e) => setPick(e.target.value)} disabled={busy || !!unavailable}>
          {TRANSLATE_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name} · {l.english}
              {tr.tracks.some((t) => t.language === l.code) ? " (redo)" : ""}
            </option>
          ))}
        </select>
        <button type="button" className="btn primary" data-testid="translate-go" disabled={busy || !hasWords || !!unavailable} title={unavailable ?? undefined} onClick={() => void store.translateCaptions([pick])}>
          {busy ? "Translating…" : "Translate"}
        </button>
      </div>
      {unavailable && (
        <p className="hint" data-testid="translate-unavailable">
          {unavailable}
        </p>
      )}
      {run && run.state !== "done" && (
        <div className="pv-progress" data-testid="translate-progress">
          <div className="progress" role="progressbar" aria-valuenow={Math.round(pct)}><div style={{ width: `${pct}%` }} /></div>
          <span className="stat">
            {run.state === "error" ? `Translation failed: ${run.error}` : run.stage === "download" ? `Downloading the ${run.language} model (once)…` : run.total ? `${nameOf(run.language)?.english ?? run.language}: ${run.done} / ${run.total} segments` : "Loading model…"}
          </span>
        </div>
      )}
      {!hasWords && <p className="note">Translation needs a transcript.</p>}
      {current && (
        <>
          <div className="tr-actions">
            <button type="button" className="btn" data-testid="download-srt" onClick={() => { const f = store.subtitleFile(current.language, "srt"); if (f) download(f.name, f.text); }}>.srt</button>
            <button type="button" className="btn" data-testid="download-vtt" onClick={() => { const f = store.subtitleFile(current.language, "vtt"); if (f) download(f.name, f.text); }}>.vtt</button>
            <button type="button" className="btn ghost" data-testid="remove-translation" onClick={() => store.removeTranslation(current.language)}>Remove {current.name ?? current.language}</button>
          </div>
          <div className="tr-list" data-testid="translation-list">
            <div className="tr-head stat"><span>Source</span><span>{current.name ?? current.language}</span></div>
            {current.segments.map((seg) => (
              <SegmentRow key={seg.id} language={current.language} rtl={current.rtl} seg={seg} />
            ))}
          </div>
          {current.engine && <p className="note">Machine translation by {current.engine.model} ({current.engine.licence}), on this computer. See About for attribution.</p>}
        </>
      )}
      {!current && tr.tracks.length > 0 && (
        <div className="tr-actions">
          <button type="button" className="btn" data-testid="download-srt" onClick={() => { const f = store.subtitleFile(null, "srt"); if (f) download(f.name, f.text); }}>.srt</button>
          <button type="button" className="btn" data-testid="download-vtt" onClick={() => { const f = store.subtitleFile(null, "vtt"); if (f) download(f.name, f.text); }}>.vtt</button>
        </div>
      )}
    </Section>
  );
}

function AudioTab({ p }: { p: ProjectConfig }) {
  const tr = p.audio.tracks[0];
  const cl = p.edits.cleanup;
  const cleanupCuts = useEditor((s) => s.plan?.cleanupCuts ?? []);
  const cleanupN = cleanupCuts.length;
  const cleanupMs = cleanupCuts.reduce((a, c) => a + c.endMs - c.startMs, 0);
  const hasWords = useEditor((s) => (s.bundle?.transcript?.words.length ?? 0) > 0);
  const hasMic = useEditor((s) => !!s.bundle?.hasMic);
  const hasSilences = useEditor((s) => (s.bundle?.silences?.length ?? 0) > 0);
  /** Cleanup is on while either switch is on (one undoable edit; the cuts show on the Cuts lane). */
  const setCleanup = (label: string, sel: { removeFillers: boolean; shortenPauses: boolean }) =>
    store.edit(label, (q) => ({ ...q, edits: { ...q.edits, cleanup: { ...q.edits.cleanup, ...sel, enabled: sel.removeFillers || sel.shortenPauses } } }));
  const setTrack = (label: string, patch: Partial<NonNullable<typeof tr>>, live = false) => {
    const fn = (q: ProjectConfig) => ({ ...q, audio: { ...q.audio, tracks: q.audio.tracks.map((x, i) => (i === 0 ? { ...x, ...patch } : x)) } });
    if (live) store.tweak(label, fn);
    else store.edit(label, fn);
  };
  return (
    <>
      <Section title="Mic track" aside={!tr ? <span className="stat">no audio</span> : undefined}>
        {tr && (
          <>
            <Slider label="Volume" value={tr.volume} min={0} max={2} step={0.05} format={pct} testId="volume" onChange={(v) => setTrack("Volume", { volume: v }, true)} />
            <Toggle label="Mute" value={tr.muted} onChange={(v) => setTrack(v ? "Mute" : "Unmute", { muted: v })} />
          </>
        )}
        <Toggle label="Noise reduction" value={p.audio.noiseReduction.enabled} testId="denoise" onChange={(v) => store.edit("Noise reduction", (q) => ({ ...q, audio: { ...q.audio, noiseReduction: { ...q.audio.noiseReduction, enabled: v } } }))} />
        <Toggle label="Level loudness" value={p.audio.loudness.enabled} testId="loudness" onChange={(v) => store.edit("Loudness", (q) => ({ ...q, audio: { ...q.audio, loudness: { ...q.audio.loudness, enabled: v } } }))} />
        <Slider label="Target" value={p.audio.loudness.targetLufs} min={-24} max={-10} step={1} format={(v) => `${v} LUFS`} onChange={(v) => store.tweak("Loudness target", (q) => ({ ...q, audio: { ...q.audio, loudness: { ...q.audio.loudness, targetLufs: v } } }))} />
        <p className="note">Denoise and loudness are applied in the export; the preview plays the raw track.</p>
      </Section>
      <Section title="Cleanup">
        {/* Windows #17: the two toggles are the switches (each turns cleanup on); pauses come from the mic's
            measured silences, so they work with no transcript; fillers need the transcript's words */}
        <Toggle label="Remove fillers" value={cl.enabled && cl.removeFillers} testId="cleanup-fillers" onChange={(v) => setCleanup("Remove fillers", { removeFillers: v, shortenPauses: cl.enabled && cl.shortenPauses })} />
        <Toggle label="Shorten pauses" value={cl.enabled && cl.shortenPauses} testId="cleanup-pauses" onChange={(v) => setCleanup("Shorten pauses", { shortenPauses: v, removeFillers: cl.enabled && cl.removeFillers })} />
        <Slider label="Longest pause" value={cl.maxPauseMs} min={cl.keepPauseMs + 100} max={3000} step={50} format={sec} testId="cleanup-maxpause" onChange={(v) => store.tweak("Longest pause", (q) => ({ ...q, edits: { ...q.edits, cleanup: { ...q.edits.cleanup, maxPauseMs: v } } }))} />
        {cl.enabled && (
          <p className="note" data-testid="cleanup-summary">
            {cleanupN} cut{cleanupN === 1 ? "" : "s"} on the Cuts lane{cleanupN ? ` (${(cleanupMs / 1000).toFixed(1)} s removed)` : ""}; Ctrl+Z undoes.
            {cl.removeFillers && !hasWords && (hasMic ? " Fillers need a transcript: Transcribe it on the Transcript tab." : " Fillers need a transcript.")}
            {cl.shortenPauses && !hasWords && !hasSilences && " No microphone track to find pauses in."}
          </p>
        )}
      </Section>
    </>
  );
}

export function Inspector() {
  const [tab, setTab] = useState<Tab>("look");
  const p = useEditor((s) => s.project);
  const planMs = useEditor((s) => s.planMs);
  return (
    <aside className="inspector" data-testid="inspector">
      <SelectionCard />
      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} data-testid={`tab-${t.id}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      <div className="insp-scroll">
        {tab === "look" && <LookTab p={p} />}
        {tab === "zoom" && <ZoomTab p={p} />}
        {tab === "cursor" && <CursorTab p={p} />}
        {tab === "camera" && <CameraTab p={p} />}
        {tab === "captions" && (
          <>
            <CaptionsTab p={p} />
            <LanguagesSection p={p} />
          </>
        )}
        {tab === "audio" && <AudioTab p={p} />}
      </div>
      <footer className="insp-foot">plan rebuilt in {planMs.toFixed(1)} ms</footer>
    </aside>
  );
}
