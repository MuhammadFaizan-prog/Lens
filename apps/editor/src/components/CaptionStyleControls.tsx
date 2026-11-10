/**
 * Caption look (Windows request "diff diff fonts for the captions"): one-click styles, a font picker
 * with every option drawn in its own font, weight, capitals, outline and highlight style. Our own
 * layout; every control edits project.captions.style (one undo step each).
 */
import { useEffect, useState } from "react";
import { applyCaptionPreset, BUILTIN_FONTS, captionLook, CAPTION_FONTS, CAPTION_PRESETS, DEFAULT_FONT, projectPalette, resolveFont } from "@lens/engine";
import type { CaptionStyle, ProjectConfig } from "@lens/engine";
import { store } from "../state/store";
import { fontCss, loadFont } from "../render/assets";
import { CAPTION_FONT } from "../render/renderer";
import { ColorInput, Segmented, Slider, Toggle } from "./Controls";

const STACK = `${CAPTION_FONT}, "DejaVu Sans", sans-serif`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** CSS font-family the editor page draws `family` with (the preview's FontFace names). */
function familyCss(family: string | undefined): string {
  return fontCss(family && family !== DEFAULT_FONT ? family : undefined, STACK);
}

/** Load every builtin font into the page once so each picker option can be shown in its own face. */
function useBuiltinFonts(): Record<string, boolean | undefined> {
  const [state, setState] = useState<Record<string, boolean | undefined>>({});
  useEffect(() => {
    let alive = true;
    for (const f of BUILTIN_FONTS) {
      if (f.family === DEFAULT_FONT) continue;
      void loadFont(f).then((ok) => alive && setState((s) => ({ ...s, [f.family]: ok })));
    }
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

type Style = ProjectConfig["captions"]["style"];

export function CaptionStyleControls({ p }: { p: ProjectConfig }) {
  const cs = p.captions.style;
  const look = captionLook(cs);
  const loaded = useBuiltinFonts();
  const themeFont = resolveFont("@font", projectPalette(p));
  const edit = (label: string, fn: (c: Style) => Partial<Style>) => store.edit(label, (q) => ({ ...q, captions: { ...q.captions, style: { ...q.captions.style, ...fn(q.captions.style), preset: undefined } } }));
  const tweak = (label: string, fn: (c: Style) => Partial<Style>) => store.tweak(label, (q) => ({ ...q, captions: { ...q.captions, style: { ...q.captions.style, ...fn(q.captions.style), preset: undefined } } }));
  const current = cs.font ?? "@font";
  const stroke = look.stroke;
  return (
    <>
      <div className="ctl caption-presets" role="group" aria-label="Caption styles">
        <span className="ctl-label">Style</span>
        <div className="cap-preset-grid">
          {CAPTION_PRESETS.map((pr) => {
            const st = applyCaptionPreset(cs as CaptionStyle, pr.id);
            const l = captionLook(st);
            const fam = st.font ?? (themeFont === DEFAULT_FONT ? undefined : themeFont);
            const sample = l.uppercase ? "AA" : "Aa";
            return (
              <button key={pr.id} type="button" className={`cap-preset ${cs.preset === pr.id ? "on" : ""}`} title={pr.hint} data-testid={`caption-preset-${pr.id}`} aria-pressed={cs.preset === pr.id}
                onClick={() => store.edit(`Caption style ${pr.label}`, (q) => ({ ...q, captions: { ...q.captions, style: applyCaptionPreset(q.captions.style, pr.id) } }))}>
                <span className="cap-preset-swatch" style={{
                  fontFamily: familyCss(fam),
                  fontWeight: l.weight === "regular" ? 400 : 700,
                  background: st.background.enabled ? st.background.color : "linear-gradient(135deg, #3a4452, #6b7585)",
                  color: st.textColor.startsWith("@") ? "#ffffff" : st.textColor,
                  WebkitTextStroke: l.stroke.enabled ? `1px ${l.stroke.color}` : undefined,
                }}>
                  {sample}
                </span>
                <span className="cap-preset-name">{pr.label}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="ctl caption-fonts" role="radiogroup" aria-label="Caption font" data-testid="caption-font">
        <span className="ctl-label">Font</span>
        <div className="cap-font-list">
          {CAPTION_FONTS.map((o) => {
            const fam = o.family === "@font" ? (themeFont === DEFAULT_FONT ? undefined : themeFont) : o.family;
            const bad = fam ? loaded[fam] === false : false;
            const on = current === o.family || (o.family === DEFAULT_FONT && current === DEFAULT_FONT);
            return (
              <button key={o.family} type="button" role="radio" aria-checked={on} className={`cap-font ${on ? "on" : ""}`} data-testid={`caption-font-${slug(o.family === "@font" ? "theme" : o.family)}`}
                disabled={bad} title={bad ? `${o.label} could not be loaded` : o.family === "@font" ? `Follows the theme / brand font (${themeFont})` : o.label}
                style={{ fontFamily: familyCss(fam), fontWeight: look.weight === "regular" ? 400 : 700 }}
                onClick={() => edit(`Caption font ${o.label}`, () => (o.family === "@font" ? { font: undefined } : { font: o.family }))}>
                {o.family === "@font" ? `Theme · ${themeFont}` : o.label}
              </button>
            );
          })}
        </div>
      </div>
      <Segmented label="Weight" value={look.weight} testId="caption-weight" options={[{ value: "regular", label: "Regular" }, { value: "bold", label: "Bold" }]} onChange={(v) => edit("Caption weight", () => ({ weight: v }))} />
      <Toggle label="Capitals" value={look.uppercase} testId="caption-uppercase" onChange={(v) => edit(v ? "Caption capitals" : "Caption as typed", () => ({ uppercase: v }))} />
      <Toggle label="Outline" value={stroke.enabled} testId="caption-stroke" onChange={(v) => edit(v ? "Caption outline" : "No caption outline", () => ({ stroke: { ...stroke, enabled: v } }))} />
      {stroke.enabled && (
        <>
          <Slider defaultValue={0.08} label="Outline width" value={stroke.width} min={0.02} max={0.25} step={0.01} format={(v) => `${Math.round(v * 100)}%`} testId="caption-stroke-width" onChange={(v) => tweak("Outline width", () => ({ stroke: { ...stroke, width: v } }))} />
          <ColorInput label="Outline" value={stroke.color} testId="caption-stroke-color" onChange={(v) => tweak("Outline colour", () => ({ stroke: { ...stroke, color: v } }))} />
        </>
      )}
      <Segmented label="Highlight as" value={look.highlightStyle} testId="caption-highlight-style" options={[{ value: "color", label: "Colour" }, { value: "box", label: "Box" }]} onChange={(v) => edit("Highlight style", () => ({ highlightStyle: v }))} />
    </>
  );
}
