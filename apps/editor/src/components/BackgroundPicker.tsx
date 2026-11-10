/**
 * Backdrop picker (Windows bug #20): Image (Lens's own procedural art + your upload, cover / contain,
 * blur), Hidden (no backdrop: the recording fills the frame), Gradient (presets + a 2-4 stop editor
 * with angle) and Color (a palette + any hex). Saved in the project and in style presets; draws the
 * same in the preview and the export (render/renderer.ts background()).
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { projectPalette, type ProjectConfig } from "@lens/engine";
import { BUILTIN_BACKDROPS, drawBackdrop, gradientCss, gradientStops } from "../render/backdrops";
import { store } from "../state/store";
import { Section, Segmented, Slider } from "./Controls";

type Tab = "image" | "hidden" | "gradient" | "color";

export const GRADIENTS: Array<{ name: string; colors: string[]; angle: number }> = [
  { name: "Tidepool", colors: ["#0f2027", "#2c5364", "#7ab8a6"], angle: 135 },
  { name: "Ember", colors: ["#3b0d2e", "#c2410c", "#fbbf24"], angle: 135 },
  { name: "Orchid", colors: ["#2e1065", "#7e22ce", "#f0abfc"], angle: 135 },
  { name: "Meadow", colors: ["#052e16", "#15803d", "#bef264"], angle: 135 },
  { name: "Midnight", colors: ["#0f172a", "#1e3a8a"], angle: 160 },
  { name: "Peach", colors: ["#ffecd2", "#fcb69f"], angle: 120 },
  { name: "Lagoon", colors: ["#00c6ff", "#0072ff"], angle: 135 },
  { name: "Berry", colors: ["#41295a", "#2f0743"], angle: 90 },
  { name: "Mint", colors: ["#d4fc79", "#96e6a1"], angle: 120 },
  { name: "Sunset", colors: ["#ff512f", "#f09819", "#ffd452"], angle: 45 },
  { name: "Steel", colors: ["#232526", "#414345"], angle: 180 },
  { name: "Candy", colors: ["#fbc2eb", "#a6c1ee", "#c2e9fb"], angle: 135 },
];

/** 60 swatches: 10 hues x 5 tones plus 10 neutrals. */
export const SWATCHES: string[] = (() => {
  const out: string[] = [];
  const hsl = (h: number, s: number, l: number) => {
    const a = (s * Math.min(l, 1 - l)) / 1;
    const f = (n: number) => {
      const k = (n + h / 30) % 12;
      const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return Math.round(c * 255).toString(16).padStart(2, "0");
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  };
  for (const l of [0.2, 0.35, 0.5, 0.65, 0.82]) for (let i = 0; i < 10; i++) out.push(hsl(i * 36, 0.7, l));
  for (let i = 0; i < 10; i++) {
    const v = Math.round((i / 9) * 255).toString(16).padStart(2, "0");
    out.push(`#${v}${v}${v}`);
  }
  return out;
})();

function Thumb({ id }: { id: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const b = BUILTIN_BACKDROPS.find((x) => x.id === id);
    const c = ref.current;
    if (b && c) drawBackdrop(c.getContext("2d")!, b, c.width, c.height);
  }, [id]);
  return <canvas ref={ref} width={96} height={54} className="bg-thumb-canvas" />;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

export function BackgroundPicker({ p }: { p: ProjectConfig }) {
  const bg = p.background;
  const pal = projectPalette(p);
  const cur = bg.inherit ? { ...bg, kind: pal.background.kind, colors: pal.background.colors, angle: pal.background.angle } : bg;
  const [tab, setTab] = useState<Tab>(cur.kind === "image" ? "image" : cur.kind === "hidden" ? "hidden" : cur.kind === "gradient" ? "gradient" : "color");
  const file = useRef<HTMLInputElement>(null);
  const [hex, setHex] = useState(cur.colors[0] ?? "#000000");
  const set = (label: string, patch: Partial<ProjectConfig["background"]>, live = false) => {
    const fn = (q: ProjectConfig) => {
      const b = { ...q.background, ...patch, inherit: false };
      // stop positions belong to the gradient's colours: a tab that swaps the colours (Image, Color,
      // a preset) drops positions that no longer line up, so the project stays valid
      if (b.stops && b.stops.length !== b.colors.length) delete b.stops;
      return { ...q, background: b };
    };
    if (live) store.tweak(label, fn);
    else store.edit(label, fn);
  };
  const gradColors = cur.kind === "gradient" && cur.colors.length >= 2 ? cur.colors : ["#1f2937", "#6366f1"];
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "image", label: "Image" },
    { id: "hidden", label: "Hidden" },
    { id: "gradient", label: "Gradient" },
    { id: "color", label: "Color" },
  ];
  return (
    <Section title="Background" aside={<button className="chip-btn" data-testid="bg-theme" title={p.brand.enabled ? "Use the brand backdrop" : "Use the preset's backdrop"} onClick={() => store.edit("Theme backdrop", (q) => ({ ...q, background: { ...q.background, kind: q.background.kind === "image" || q.background.kind === "hidden" ? "gradient" : q.background.kind, inherit: true } }))}>{bg.inherit ? "✓ Theme" : "Theme"}</button>}>
      <div className="bg-tabs" role="tablist" data-testid="bg-tabs">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} data-testid={`bg-tab-${t.id}`}
            onClick={() => {
              setTab(t.id);
              if (t.id === "hidden") set("Hide backdrop", { kind: "hidden" });
            }}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "image" && (
        <>
          <div className="bg-grid" data-testid="bg-images">
            {BUILTIN_BACKDROPS.map((b) => {
              const on = cur.kind === "image" && cur.imagePath === `builtin:${b.id}`;
              return (
                <button key={b.id} className={`bg-swatch img ${on ? "on" : ""}`} title={b.name} aria-label={`Backdrop image ${b.name}`} data-testid={`bg-image-${b.id}`}
                  onClick={() => set(`Backdrop ${b.name}`, { kind: "image", imagePath: `builtin:${b.id}`, colors: [b.colors[0]!] })}>
                  <Thumb id={b.id} />
                </button>
              );
            })}
          </div>
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden data-testid="bg-upload-input" onChange={(e) => { const f = e.target.files?.[0]; if (f) void store.uploadBackground(f); if (file.current) file.current.value = ""; }} />
          <button className="btn ghost bg-upload" data-testid="bg-upload" onClick={() => file.current?.click()}>Upload your own…</button>
          {cur.kind === "image" && (
            <>
              <Segmented label="Fit" value={cur.fit ?? "cover"} testId="bg-fit" options={[{ value: "cover", label: "Cover" }, { value: "contain", label: "Contain" }]} onChange={(v) => set("Backdrop fit", { fit: v as "cover" | "contain" })} />
              <Slider defaultValue={0} label="Blur" value={cur.blur} min={0} max={60} step={1} format={(v) => `${v} px`} testId="bg-blur" onChange={(v) => set("Backdrop blur", { blur: v }, true)} />
            </>
          )}
        </>
      )}
      {tab === "hidden" && <p className="note" data-testid="bg-hidden-note">No backdrop: the recording fills the frame edge to edge (no padding, corners or shadow).</p>}
      {tab === "gradient" && (
        <>
          <div className="bg-grid" data-testid="bg-gradients">
            {GRADIENTS.map((gr) => {
              const on = cur.kind === "gradient" && cur.colors.join() === gr.colors.join();
              return (
                <button key={gr.name} className={`bg-swatch ${on ? "on" : ""}`} title={gr.name} aria-label={`Gradient ${gr.name}`} data-testid={`bg-gradient-${gr.name.toLowerCase()}`} style={{ background: gradientCss(gr.colors, gr.angle) }}
                  onClick={() => set(`Gradient ${gr.name}`, { kind: "gradient", colors: [...gr.colors], angle: gr.angle, stops: undefined })} />
              );
            })}
          </div>
          <GradientStops colors={gradColors} stops={cur.kind === "gradient" ? cur.stops : undefined} angle={cur.kind === "gradient" ? cur.angle : 135}
            onChange={(colors, stops, live) => set(live ? "Gradient stop" : "Gradient stops", { kind: "gradient", colors, stops, angle: cur.kind === "gradient" ? cur.angle : 135 }, live)} />
          <Slider defaultValue={135} label="Angle" value={cur.kind === "gradient" ? cur.angle : 135} min={0} max={360} step={5} format={(v) => `${v}°`} testId="bg-angle" onChange={(v) => set("Gradient angle", { kind: "gradient", colors: gradColors, angle: v }, true)} />
        </>
      )}
      {tab === "color" && (
        <>
          <div className="bg-palette" data-testid="bg-colors">
            {SWATCHES.map((c) => (
              <button key={c} className={`bg-dot ${cur.kind === "solid" && cur.colors[0]?.toLowerCase() === c ? "on" : ""}`} style={{ background: c }} title={c} aria-label={`Colour ${c}`} data-testid={`bg-color-${c.slice(1)}`}
                onClick={() => { setHex(c); set("Backdrop colour", { kind: "solid", colors: [c] }); }} />
            ))}
          </div>
          <div className="bg-custom">
            <input type="color" value={HEX.test(hex) ? hex : "#000000"} aria-label="Custom colour" data-testid="bg-color-picker" onChange={(e) => { setHex(e.target.value); set("Backdrop colour", { kind: "solid", colors: [e.target.value] }, true); }} />
            <input className="cue-input" value={hex} data-testid="bg-hex" aria-label="Hex colour" maxLength={7} onKeyDown={(e) => e.stopPropagation()}
              onChange={(e) => { const v = e.target.value.trim(); setHex(v); if (HEX.test(v)) set("Backdrop colour", { kind: "solid", colors: [v.toLowerCase()] }); }} />
          </div>
        </>
      )}
    </Section>
  );
}

/**
 * Gradient stop editor: 2-4 stops, each with a colour and a position the user places freely, by
 * dragging its handle along the bar or typing a percentage. Stops may pass each other; they are drawn
 * sorted by position (gradientStops). A new stop goes in the middle of the widest gap.
 */
function GradientStops({ colors, stops, angle, onChange }: { colors: string[]; stops?: number[]; angle: number; onChange: (colors: string[], stops: number[], live: boolean) => void }) {
  const bar = useRef<HTMLDivElement>(null);
  const pos = stops && stops.length === colors.length ? stops : colors.map((_, i) => i / (colors.length - 1));
  const at = (i: number, v: number, live: boolean) => onChange(colors, pos.map((x, j) => (j === i ? Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000 : x)), live);
  const drag = (i: number) => (e: ReactPointerEvent) => {
    e.preventDefault();
    const el = bar.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const move = (ev: PointerEvent) => at(i, (ev.clientX - r.left) / r.width, true);
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      at(i, (ev.clientX - r.left) / r.width, false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const add = () => {
    const sorted = gradientStops(colors, pos);
    let best = 0;
    for (let k = 1; k < sorted.length; k++) if (sorted[k]![0] - sorted[k - 1]![0] > sorted[best + 1]![0] - sorted[best]![0]) best = k - 1;
    const mid = (sorted[best]![0] + sorted[best + 1]![0]) / 2;
    onChange([...colors, sorted[best + 1]![1]], [...pos, Math.round(mid * 1000) / 1000], false);
  };
  return (
    <div className="bg-stops" data-testid="bg-stops">
      <div ref={bar} className="bg-stop-bar" data-testid="bg-stop-bar" style={{ background: gradientCss(colors, 90, pos) }}>
        {colors.map((c, i) => (
          <span key={i} className="bg-stop-handle" role="slider" aria-label={`Stop ${i + 1} position`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pos[i]! * 100)}
            data-testid={`bg-stop-handle-${i}`} style={{ left: `${pos[i]! * 100}%`, background: c }} onPointerDown={drag(i)} />
        ))}
      </div>
      <div className="bg-stop-rows">
        {colors.map((c, i) => (
          <span key={i} className="bg-stop">
            <input type="color" value={c} aria-label={`Stop ${i + 1}`} data-testid={`bg-stop-${i}`} onChange={(e) => onChange(colors.map((x, j) => (j === i ? e.target.value : x)), pos, true)} />
            <input type="number" className="bg-stop-pos" min={0} max={100} step={1} value={Math.round(pos[i]! * 100)} aria-label={`Stop ${i + 1} position %`} data-testid={`bg-stop-pos-${i}`}
              onKeyDown={(e) => e.stopPropagation()} onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) at(i, v / 100, false); }} />
            {colors.length > 2 && <button className="mini-reset" aria-label={`Remove stop ${i + 1}`} onClick={() => onChange(colors.filter((_, j) => j !== i), pos.filter((_, j) => j !== i), false)}>×</button>}
          </span>
        ))}
        {colors.length < 4 && <button className="chip-btn" data-testid="bg-stop-add" onClick={add}>+ Stop</button>}
      </div>
    </div>
  );
}
