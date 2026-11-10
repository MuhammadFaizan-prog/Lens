/**
 * Brand panel (demand #9): colours, backdrop, caption highlight, font, logo watermark and the
 * intro / outro cards. Brand colours apply live to everything that inherits them (annotations,
 * step badges, caption highlight, the theme backdrop, slide accents); items with their own colour
 * keep it.
 */
import { useRef } from "react";
import { BUILTIN_FONTS, type BrandKit, type Corner } from "@lens/engine";
import { assetUrl } from "../render/assets";
import { store, useEditor } from "../state/store";
import { ColorInput, Section, Segmented, Select, Slider, Toggle } from "./Controls";
import { Icon } from "./Icon";

const pct = (v: number) => `${Math.round(v * 100)}%`;
const sec = (v: number) => `${(v / 1000).toFixed(1)} s`;

function Card({ which, b }: { which: "intro" | "outro"; b: BrandKit }) {
  const c = b[which];
  const name = which === "intro" ? "Intro" : "Outro";
  const set = (label: string, patch: Partial<BrandKit["intro"]>, live = false) => store.editBrand(label, (x) => ({ ...x, [which]: { ...x[which], ...patch } }), live);
  return (
    <Section title={`${name} card`}>
      <Toggle label={`${name} card`} value={c.enabled} testId={`brand-${which}`} onChange={(v) => set(v ? `${name} card on` : `${name} card off`, { enabled: v })} />
      {c.enabled && (
        <>
          <label className="ctl text">
            <span className="ctl-label">Title</span>
            <input value={c.title} placeholder={b.name} data-testid={`brand-${which}-title`} onChange={(e) => set(`${name} title`, { title: e.target.value }, true)} />
          </label>
          <label className="ctl text">
            <span className="ctl-label">Subtitle</span>
            <input value={c.subtitle} placeholder={which === "outro" ? "yourproduct.com" : ""} onChange={(e) => set(`${name} subtitle`, { subtitle: e.target.value }, true)} />
          </label>
          <Slider defaultValue={2000} label="Length" value={c.durationMs} min={500} max={6000} step={100} format={sec} onChange={(v) => set(`${name} length`, { durationMs: v }, true)} />
          <Toggle label="Show logo" value={c.logo} onChange={(v) => set(`${name} logo`, { logo: v })} />
        </>
      )}
    </Section>
  );
}

export function BrandPanel() {
  const b = useEditor((s) => s.project.brand);
  const logoInput = useRef<HTMLInputElement>(null);
  const fontInput = useRef<HTMLInputElement>(null);
  const live = (label: string, fn: (x: BrandKit) => BrandKit) => store.editBrand(label, fn, true);
  const fonts = [...BUILTIN_FONTS.map((f) => f.family), ...b.customFonts.map((f) => f.family)];
  return (
    <aside className="transcript brand-panel" data-testid="brand-panel">
      <div className="panel-head">
        <Toggle label="Use brand kit" value={b.enabled} testId="brand-enabled" onChange={(v) => store.editBrand(v ? "Brand kit on" : "Brand kit off", (x) => ({ ...x, enabled: v }))} />
        <p className="note">Annotations, step badges, caption highlights, the theme backdrop and slide accents follow these colours. Anything you colour by hand keeps its colour.</p>
      </div>
      <div className={`brand-body ${b.enabled ? "" : "off"}`}>
        <Section title="Colours">
          <label className="ctl text">
            <span className="ctl-label">Name</span>
            <input value={b.name} data-testid="brand-name" onChange={(e) => live("Brand name", (x) => ({ ...x, name: e.target.value }))} />
          </label>
          <ColorInput label="Primary" value={b.colors.primary} testId="brand-primary" onChange={(v) => live("Brand primary", (x) => ({ ...x, colors: { ...x.colors, primary: v } }))} />
          <ColorInput label="Accent" value={b.colors.accent} testId="brand-accent" onChange={(v) => live("Brand accent", (x) => ({ ...x, colors: { ...x.colors, accent: v } }))} />
          <Segmented label="Highlight" value={b.captionHighlight} options={[{ value: "primary", label: "Primary" }, { value: "accent", label: "Accent" }]} testId="brand-caption-highlight"
            onChange={(v) => store.editBrand("Caption highlight colour", (x) => ({ ...x, captionHighlight: v }))} />
          <Segmented label="Backdrop" value={b.colors.background.mode} options={[{ value: "derived", label: "Derived", hint: "A deep gradient made from the primary colour" }, { value: "custom", label: "Custom" }]} testId="brand-bg-mode"
            onChange={(v) => store.editBrand("Brand backdrop", (x) => ({ ...x, colors: { ...x.colors, background: { ...x.colors.background, mode: v, colors: x.colors.background.colors.length ? x.colors.background.colors : ["#141a3d", "#2c3c99"] } } }))} />
          {b.colors.background.mode === "custom" && (
            <>
              <ColorInput label="From" value={b.colors.background.colors[0] ?? "#000000"} onChange={(v) => live("Brand backdrop", (x) => ({ ...x, colors: { ...x.colors, background: { ...x.colors.background, colors: [v, ...x.colors.background.colors.slice(1)] } } }))} />
              <ColorInput label="To" value={b.colors.background.colors[1] ?? b.colors.background.colors[0] ?? "#000000"} onChange={(v) => live("Brand backdrop", (x) => ({ ...x, colors: { ...x.colors, background: { ...x.colors.background, colors: [x.colors.background.colors[0] ?? v, v] } } }))} />
            </>
          )}
        </Section>
        <Section title="Font">
          <Select label="Family" value={b.font} options={fonts.map((f) => ({ value: f, label: f }))} testId="brand-font" onChange={(v) => store.editBrand(`Brand font ${v}`, (x) => ({ ...x, font: v }))} />
          <input ref={fontInput} type="file" accept=".ttf,.otf" multiple hidden data-testid="brand-font-input" onChange={(e) => { void store.addBrandFont([...(e.target.files ?? [])]); e.target.value = ""; }} />
          <button className="btn small" onClick={() => fontInput.current?.click()}>
            <Icon name="plus" /> Add font files…
          </button>
          <p className="note">The listed fonts ship with Lens (SIL Open Font License). Pick a regular and a bold file for your own font; you are responsible for its licence.</p>
        </Section>
        <Section title="Logo">
          <input ref={logoInput} type="file" accept="image/png,image/jpeg,image/webp" hidden data-testid="brand-logo-input" onChange={(e) => { const f = e.target.files?.[0]; if (f) void store.uploadLogo(f); e.target.value = ""; }} />
          <div className="logo-row">
            {b.logo.path ? <img className="logo-thumb" src={assetUrl(b.logo.path)} alt="Brand logo" data-testid="brand-logo-thumb" /> : <span className="logo-empty">No logo</span>}
            <button className="btn small" data-testid="brand-logo-upload" onClick={() => logoInput.current?.click()}>
              <Icon name="open" /> {b.logo.path ? "Replace" : "Upload"}
            </button>
          </div>
          {b.logo.path && (
            <>
              <Toggle label="Watermark on video" value={b.logo.watermark} testId="brand-watermark" onChange={(v) => store.editBrand(v ? "Watermark on" : "Watermark off", (x) => ({ ...x, logo: { ...x.logo, watermark: v } }))} />
              <Segmented label="Corner" value={b.logo.corner} stacked
                options={[{ value: "top-left", label: "↖" }, { value: "top-right", label: "↗" }, { value: "bottom-left", label: "↙" }, { value: "bottom-right", label: "↘" }] as Array<{ value: Corner; label: string }>}
                testId="brand-corner" onChange={(v) => store.editBrand("Watermark corner", (x) => ({ ...x, logo: { ...x.logo, corner: v } }))} />
              <Slider defaultValue={0.1} label="Size" value={b.logo.size} min={0.03} max={0.3} step={0.005} format={pct} testId="brand-logo-size" onChange={(v) => live("Watermark size", (x) => ({ ...x, logo: { ...x.logo, size: v } }))} />
              <Slider defaultValue={0.85} label="Opacity" value={b.logo.opacity} min={0.05} max={1} step={0.01} format={pct} testId="brand-logo-opacity" onChange={(v) => live("Watermark opacity", (x) => ({ ...x, logo: { ...x.logo, opacity: v } }))} />
              <Slider defaultValue={0.035} label="Safe margin" value={b.logo.margin} min={0} max={0.12} step={0.005} format={pct} onChange={(v) => live("Watermark margin", (x) => ({ ...x, logo: { ...x.logo, margin: v } }))} />
            </>
          )}
        </Section>
        <Card which="intro" b={b} />
        <Card which="outro" b={b} />
      </div>
    </aside>
  );
}
