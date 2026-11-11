import { useRef } from "react";
import { defaultAnimations, defaultAnnotationStyle, defaultSlide } from "@lens/engine";

/** Slide defaults (the reset button of each slide slider). */
const DS = defaultSlide("", 0);
import type { Annotation, AnnotationStyle, ArrowHead, InAnimation, OutAnimation, TextSlide } from "@lens/engine";
import { store, useEditor } from "../state/store";
import { timecode } from "../state/timelineOps";
import { ColorInput, Segmented, Select, Slider, Toggle } from "./Controls";
import { Icon } from "./Icon";

const KIND_LABEL: Record<Annotation["kind"], string> = { text: "Text", arrow: "Arrow", rect: "Box", ellipse: "Ellipse", badge: "Step badge", callout: "Callout" };
const IN_OPTS: Array<{ value: InAnimation; label: string }> = [
  { value: "none", label: "None" }, { value: "fade", label: "Fade" }, { value: "pop", label: "Pop" }, { value: "draw", label: "Draw on" }, { value: "typewriter", label: "Typewriter" },
];
const OUT_OPTS: Array<{ value: OutAnimation; label: string }> = [{ value: "none", label: "None" }, { value: "fade", label: "Fade" }, { value: "pop", label: "Pop" }, { value: "draw", label: "Draw off" }];
const px = (v: number) => `${Math.round(v)} px`;
const ms = (v: number) => `${Math.round(v)} ms`;
const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Style inspector for the selected annotation (the store's selection on track "annotation"). */
export function AnnotationCard({ a }: { a: Annotation }) {
  const fps = useEditor((s) => s.plan?.output.fps ?? 30);
  const id = a.id;
  // what each slider's reset button goes back to: this kind's defaults
  const dst = defaultAnnotationStyle(a.kind, a.anchor);
  const dan = defaultAnimations(a.kind);
  const st = (label: string, patch: Partial<AnnotationStyle>, live = true) => store.updateAnnotation(id, (x) => ({ ...x, style: { ...x.style, ...patch } }), live ? "tweak" : "edit", label);
  const set = (label: string, patch: Partial<Annotation>, live = false) => store.updateAnnotation(id, (x) => ({ ...x, ...patch }), live ? "tweak" : "edit", label);
  const hasText = a.kind === "text" || a.kind === "callout" || a.kind === "badge";
  // colours whose default is a theme slot can be put back to follow the preset / brand
  const def = defaultAnnotationStyle(a.kind, a.anchor);
  const reset = (f: "color" | "fill" | "textColor") => {
    const v = def[f];
    return typeof v === "string" && v.startsWith("@") ? () => st("Follow theme colour", { [f]: v }, false) : undefined;
  };
  const hasFill = a.kind !== "arrow";
  return (
    <div className="selection-card ann-card" data-testid="ann-card">
      <div className="sel-head">
        <span className="dot dot-annotation" />
        <b data-testid="ann-card-kind">{KIND_LABEL[a.kind]}</b>
        <span className="sel-time">
          {timecode(a.startMs, fps)} – {timecode(a.endMs, fps)} · {a.anchor === "screen" ? "on screen" : "on frame"}
        </span>
        <button className="icon-btn danger" title="Delete (Del)" aria-label="Delete annotation" data-testid="ann-delete" onClick={() => store.deleteAnnotation(id)}>
          <Icon name="trash" />
        </button>
      </div>
      {hasText && (
        <label className="row ann-text-row">
          <span className="row-label">Text</span>
          <input className="ann-text-input" value={a.text ?? ""} data-testid="ann-text" onChange={(e) => set("Edit text", { text: e.target.value }, true)} />
        </label>
      )}
      <ColorInput label={a.kind === "badge" ? "Ring" : a.kind === "text" ? "Accent" : "Colour"} value={a.style.color} testId="ann-color" onChange={(v) => st("Annotation colour", { color: v })} onReset={reset("color")} />
      {hasFill && (
        <>
          <ColorInput label="Fill" value={a.style.fill ?? "#000000"} testId="ann-fill" onChange={(v) => st("Annotation fill", { fill: v })} onReset={reset("fill")} />
          <Slider defaultValue={dst.fill ? dst.fillOpacity : 0} label="Fill opacity" value={a.style.fill ? a.style.fillOpacity : 0} min={0} max={1} step={0.02} format={pct} onChange={(v) => st("Fill opacity", { fillOpacity: v, fill: a.style.fill ?? "#000000" })} />
        </>
      )}
      <Slider defaultValue={dst.strokeWidth} label="Stroke" value={a.style.strokeWidth} min={0} max={24} step={0.5} format={px} testId="ann-stroke" onChange={(v) => st("Stroke width", { strokeWidth: v })} />
      {hasText && (
        <>
          <Slider defaultValue={dst.fontSize} label="Font size" value={a.style.fontSize} min={10} max={120} step={1} format={px} testId="ann-font" onChange={(v) => st("Font size", { fontSize: v })} />
          <ColorInput label="Text colour" value={a.style.textColor} onChange={(v) => st("Text colour", { textColor: v })} />
          <Toggle label="Bold" value={a.style.bold} onChange={(v) => st("Bold", { bold: v }, false)} />
        </>
      )}
      {(a.kind === "rect" || a.kind === "callout" || a.kind === "text") && <Slider defaultValue={dst.radius} label="Corner radius" value={a.style.radius} min={0} max={40} step={1} format={px} onChange={(v) => st("Corner radius", { radius: v })} />}
      {a.kind === "arrow" && (
        <>
          <Slider defaultValue={0} label="Curve" value={a.curve ?? 0} min={-0.8} max={0.8} step={0.02} format={(v) => v.toFixed(2)} testId="ann-curve" onChange={(v) => set("Arrow curve", { curve: v }, true)} />
          <Select<ArrowHead> label="Head" value={a.head ?? "triangle"} options={[{ value: "triangle", label: "Triangle" }, { value: "open", label: "Open" }, { value: "dot", label: "Dot" }, { value: "none", label: "None" }]} onChange={(v) => set("Arrow head", { head: v })} />
          <Select<ArrowHead> label="Tail" value={a.tail ?? "none"} options={[{ value: "none", label: "None" }, { value: "triangle", label: "Triangle" }, { value: "open", label: "Open" }, { value: "dot", label: "Dot" }]} onChange={(v) => set("Arrow tail", { tail: v })} />
        </>
      )}
      <Toggle label="Shadow" value={a.style.shadow.enabled} onChange={(v) => st("Shadow", { shadow: { ...a.style.shadow, enabled: v } }, false)} />
      {a.style.shadow.enabled && <Slider defaultValue={dst.shadow.blur} label="Softness" value={a.style.shadow.blur} min={0} max={40} step={1} format={px} onChange={(v) => st("Shadow softness", { shadow: { ...a.style.shadow, blur: v } })} />}
      <Slider defaultValue={dst.opacity} label="Opacity" value={a.style.opacity} min={0.1} max={1} step={0.02} format={pct} onChange={(v) => st("Opacity", { opacity: v })} />
      <div className="ann-anim">
        <Select<InAnimation> label="In" value={a.in.kind} testId="ann-in" options={IN_OPTS} onChange={(v) => set("In animation", { in: { ...a.in, kind: v } })} />
        <Slider defaultValue={dan.in.ms} label="In time" value={a.in.ms} min={0} max={2000} step={50} format={ms} testId="ann-in-ms" onChange={(v) => set("In time", { in: { ...a.in, ms: v } }, true)} />
        <Select<OutAnimation> label="Out" value={a.out.kind} testId="ann-out" options={OUT_OPTS} onChange={(v) => set("Out animation", { out: { ...a.out, kind: v } })} />
        <Slider defaultValue={dan.out.ms} label="Out time" value={a.out.ms} min={0} max={2000} step={50} format={ms} onChange={(v) => set("Out time", { out: { ...a.out, ms: v } }, true)} />
        <div className="ann-jump">
          <button className="chip-btn" data-testid="ann-jump-in" title="Put the playhead at the start of the in-animation" onClick={() => { store.pause(); store.seekSource(a.startMs); }}>⇤ In</button>
          <button className="chip-btn" data-testid="ann-play-in" title="Play the in-animation" onClick={() => { store.seekSource(a.startMs); store.play(1); }}>▶ Play in</button>
          <button className="chip-btn" title="Put the playhead at the start of the out-animation" onClick={() => { store.pause(); store.seekSource(Math.max(a.startMs, a.endMs - a.out.ms)); }}>Out ⇥</button>
        </div>
      </div>
    </div>
  );
}

export function SlideCard({ index, s }: { index: number; s: TextSlide }) {
  const fps = useEditor((st) => st.plan?.output.fps ?? 30);
  const brandOn = useEditor((st) => st.project.brand.enabled);
  const imageInput = useRef<HTMLInputElement>(null);
  const kind = s.kind ?? "text";
  const name = kind === "image" ? "Image" : kind === "freeze" ? "Freeze pause" : "Title card";
  const branded = !!s.brand;
  return (
    <div className="selection-card ann-card" data-testid="slide-card" data-kind={kind}>
      <div className="sel-head">
        <span className={`dot ${kind === "freeze" ? "dot-freeze" : "dot-slide"}`} />
        <b>{name}</b>
        <span className="sel-time">at {timecode(s.atMs, fps)} · {(s.durationMs / 1000).toFixed(1)} s</span>
        <button className="icon-btn danger" title="Delete (Del)" aria-label="Delete slide" data-testid="slide-delete" onClick={() => { store.edit(`Delete ${name.toLowerCase()}`, (p) => ({ ...p, slides: p.slides.filter((_, i) => i !== index) })); store.select(null); }}>
          <Icon name="trash" />
        </button>
      </div>
      {kind === "freeze" && <p className="note">The whole video stops on this frame for the length below, silent; everything after it plays later. To keep the sound going over a still screen, use a Freeze block instead.</p>}
      {kind === "image" && (
        <>
          <div className="row slide-image-row">
            <span className="row-label">Picture</span>
            <span className="slide-image-name" title={s.image?.path ?? ""}>{s.image?.path?.split("/").pop() ?? "none"}</span>
            <button className="chip-btn" data-testid="slide-image-replace" onClick={() => imageInput.current?.click()}>Replace…</button>
            <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp" hidden data-testid="slide-image-input"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void store.replaceSlideImage(index, f); e.target.value = ""; }} />
          </div>
          <Segmented label="Fit" value={s.image?.fit ?? "contain"} testId="slide-image-fit"
            options={[{ value: "contain", label: "Fit", hint: "The whole picture on the slide background" }, { value: "cover", label: "Fill", hint: "Fill the frame; edges may be cropped" }]}
            onChange={(v) => s.image && store.updateSlide(index, { image: { ...s.image, fit: v } })} />
        </>
      )}
      {kind !== "freeze" && (
        <>
          <label className="row ann-text-row">
            <span className="row-label">{kind === "image" ? "Caption" : "Title"}</span>
            <input className="ann-text-input" value={s.title} placeholder={kind === "image" ? "optional" : ""} data-testid="slide-title" onChange={(e) => store.updateSlide(index, { title: e.target.value }, true)} />
          </label>
          <label className="row ann-text-row">
            <span className="row-label">Subtitle</span>
            <input className="ann-text-input" value={s.subtitle} placeholder={kind === "image" ? "optional" : ""} data-testid="slide-subtitle" onChange={(e) => store.updateSlide(index, { subtitle: e.target.value }, true)} />
          </label>
        </>
      )}
      <Slider defaultValue={kind === "image" ? 3000 : DS.durationMs} label="Duration" value={s.durationMs} min={kind === "freeze" ? 200 : 500} max={kind === "freeze" ? 10000 : 8000} step={100} format={(v) => `${(v / 1000).toFixed(1)} s`} testId="slide-duration" onChange={(v) => store.updateSlide(index, { durationMs: v }, true)} />
      {kind !== "freeze" && (
        <>
          <Slider defaultValue={DS.fadeMs} label="Cross-fade" value={s.fadeMs} min={0} max={1000} step={50} format={ms} onChange={(v) => store.updateSlide(index, { fadeMs: v }, true)} />
          <Toggle label="Brand kit look" value={branded} testId="slide-brand" disabled={!brandOn && !branded}
            hint={brandOn ? "Theme backdrop, brand font, primary accent and logo; follows brand changes" : "Turn on the brand kit (Brand panel) to use its look"}
            onChange={(v) => store.updateSlide(index, { brand: v || undefined })} />
          {!branded && (
            <>
              <ColorInput label="Background" value={s.background} onChange={(v) => store.updateSlide(index, { background: v }, true)} />
              <ColorInput label="Text" value={s.textColor} onChange={(v) => store.updateSlide(index, { textColor: v }, true)} />
            </>
          )}
          {kind === "text" && !branded && <Toggle label="Accent bar" value={s.accent !== null} onChange={(v) => store.updateSlide(index, { accent: v ? "@primary" : null })} />}
          {kind === "text" && (
            <Segmented label="Size" value={s.titleSize >= 96 ? "l" : s.titleSize <= 64 ? "s" : "m"} options={[{ value: "s", label: "S" }, { value: "m", label: "M" }, { value: "l", label: "L" }]}
              onChange={(v) => store.updateSlide(index, { titleSize: v === "s" ? 60 : v === "m" ? 84 : 110 })} />
          )}
        </>
      )}
    </div>
  );
}
