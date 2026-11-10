/**
 * Caption look (Windows requests "diff diff fonts for the captions" and v0.1.3 "add more styles n fonts
 * and add option they can import custom fonts"): one-click styles, a searchable font picker with
 * categories where every option is drawn in its own font, "My fonts" (imported from a file, a URL or
 * Google Fonts; copied into the project), weight, capitals, outline and highlight style. Our own layout;
 * every control edits project.captions.style (one undo step each).
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { applyCaptionPreset, BUILTIN_FONTS, captionEffects, captionLook, CAPTION_FONT_CATEGORIES, CAPTION_FONTS, CAPTION_PRESETS, DEFAULT_FONT, filterCaptionFonts, projectPalette, resolveColor, resolveFont } from "@lens/engine";
import type { CaptionHighlightStyle, CaptionStyle, FontFiles, ProjectConfig } from "@lens/engine";
import { store, useEditor } from "../state/store";
import { fontCss, loadFont } from "../render/assets";
import { CAPTION_FONT } from "../render/renderer";
import { desktopFile } from "./FileMenu";
import { ColorInput, Segmented, Slider, Toggle } from "./Controls";

const STACK = `${CAPTION_FONT}, "DejaVu Sans", sans-serif`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** CSS font-family the editor page draws `family` with (the preview's FontFace names). */
function familyCss(family: string | undefined): string {
  return fontCss(family && family !== DEFAULT_FONT ? family : undefined, STACK);
}

/** Load fonts into the page once so each picker option can be shown in its own face. */
function useFonts(list: FontFiles[]): Record<string, boolean | undefined> {
  const [state, setState] = useState<Record<string, boolean | undefined>>({});
  const key = list.map((f) => `${f.family}|${f.regular}|${f.bold}`).join(";");
  useEffect(() => {
    let alive = true;
    for (const f of list) {
      if (f.family === DEFAULT_FONT) continue;
      void loadFont(f).then((ok) => alive && setState((s) => (s[f.family] === ok ? s : { ...s, [f.family]: ok })));
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

type Style = ProjectConfig["captions"]["style"];

/** The preset tile's sample: the preset's look in CSS (font, colours, box, outline, glow, shadow, gradient). */
function swatchStyle(st: CaptionStyle, themeFont: string, pal: ReturnType<typeof projectPalette>): CSSProperties {
  const l = captionLook(st);
  const fx = captionEffects(st);
  const col = (c: string) => (c.startsWith("@") ? resolveColor(c, pal) : c);
  const fam = st.font ?? (themeFont === DEFAULT_FONT ? undefined : themeFont);
  const shadows: string[] = [];
  if (fx.glow) shadows.push(`0 0 6px ${col(fx.glow.color)}`, `0 0 2px ${col(fx.glow.color)}`);
  if (fx.shadow) shadows.push(`${Math.round(fx.shadow.dx * 18)}px ${Math.round(fx.shadow.dy * 18)}px ${Math.round(fx.shadow.blur * 18)}px ${col(fx.shadow.color)}`);
  const s: CSSProperties = {
    fontFamily: familyCss(fam),
    fontWeight: l.weight === "regular" ? 400 : 700,
    background: st.background.enabled ? (fx.backdropBlur ? `linear-gradient(135deg, rgba(255,255,255,0.32), rgba(255,255,255,0.12)), linear-gradient(135deg, #3a4452, #6b7585)` : st.background.color) : "linear-gradient(135deg, #3a4452, #6b7585)",
    color: col(st.textColor),
    WebkitTextStroke: l.stroke.enabled ? `1px ${col(l.stroke.color)}` : undefined,
    textShadow: shadows.length ? shadows.join(", ") : undefined,
    borderRadius: fx.boxShape === "rounded" ? undefined : 2,
    borderLeft: fx.accent ? `4px solid ${col(fx.accent)}` : undefined,
  };
  if (fx.gradient) Object.assign(s, { backgroundImage: `linear-gradient(${col(fx.gradient.from)}, ${col(fx.gradient.to)})`, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent", backgroundColor: undefined });
  return s;
}

/** The tile's two letters, with the spoken-word look on the second where the style marks it. */
function SwatchText({ st, pal }: { st: CaptionStyle; pal: ReturnType<typeof projectPalette> }) {
  const l = captionLook(st);
  const hi = st.highlightColor.startsWith("@") ? resolveColor(st.highlightColor, pal) : st.highlightColor;
  const a = l.uppercase ? "A" : "A";
  const b = l.uppercase ? "A" : "a";
  const hs: CaptionHighlightStyle = l.highlightStyle;
  const mark: CSSProperties =
    hs === "box" || hs === "pill" ? { background: hi, color: "#111318", borderRadius: hs === "pill" ? 999 : 3, padding: "0 2px", WebkitTextStroke: "0" }
    : hs === "underline" ? { borderBottom: `3px solid ${hi}` }
    : hs === "pop" ? { color: hi, fontSize: "1.2em" }
    : hs === "bounce" ? { color: hi, position: "relative", top: -3 }
    : { color: hi };
  return (
    <>
      <span style={hs === "karaoke" ? { color: hi } : undefined}>{a}</span>
      <span style={mark}>{b}</span>
    </>
  );
}

export function CaptionStyleControls({ p }: { p: ProjectConfig }) {
  const cs = p.captions.style;
  const look = captionLook(cs);
  const pal = projectPalette(p);
  const themeFont = resolveFont("@font", pal);
  const fontLibrary = useEditor((x) => x.fontLibrary);
  const missingFonts = useEditor((x) => x.missingFonts);
  const own = p.customFonts ?? [];
  // "My fonts": this project's imported fonts, then the library's others (picking one copies it in)
  const mine = useMemo(() => {
    const out: Array<{ family: string; label: string; kind: "mine"; bold: boolean; inProject: boolean; files: FontFiles | null; source?: { kind: string; url?: string } }> = own.map((f) => ({ family: f.family, label: f.family, kind: "mine" as const, bold: f.regular !== f.bold, inProject: true, files: f, source: f.source }));
    for (const f of fontLibrary) if (!out.some((o) => o.family === f.family)) out.push({ family: f.family, label: f.family, kind: "mine", bold: f.regular !== f.bold, inProject: false, files: null, source: f.source });
    return out;
  }, [own, fontLibrary]);
  const loaded = useFonts(useMemo(() => [...BUILTIN_FONTS, ...own], [own]));
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<string>(() => (own.some((f) => f.family === cs.font) ? "mine" : "all"));
  const [importOpen, setImportOpen] = useState(false);
  useEffect(() => {
    void store.loadFontLibrary();
  }, []);
  const edit = (label: string, fn: (c: Style) => Partial<Style>) => store.edit(label, (q) => ({ ...q, captions: { ...q.captions, style: { ...q.captions.style, ...fn(q.captions.style), preset: undefined } } }));
  const tweak = (label: string, fn: (c: Style) => Partial<Style>) => store.tweak(label, (q) => ({ ...q, captions: { ...q.captions, style: { ...q.captions.style, ...fn(q.captions.style), preset: undefined } } }));
  const current = cs.font ?? "@font";
  const stroke = look.stroke;
  const builtins = cat === "mine" ? [] : filterCaptionFonts(CAPTION_FONTS, query, cat).filter((o) => o.family !== "@font" || (cat === "all" && !query));
  const mineShown = cat === "mine" || cat === "all" ? mine.filter((m) => !query.trim() || m.label.toLowerCase().includes(query.trim().toLowerCase())) : [];
  const missing = missingFonts.filter((f) => f === cs.font || own.some((o) => o.family === f));
  const ownSource = own.find((f) => f.family === cs.font)?.source;
  return (
    <>
      <div className="ctl caption-presets" role="group" aria-label="Caption styles">
        <span className="ctl-label">Style</span>
        <div className="cap-preset-grid" data-testid="caption-presets">
          {CAPTION_PRESETS.map((pr) => {
            const st = applyCaptionPreset(cs as CaptionStyle, pr.id);
            return (
              <button key={pr.id} type="button" className={`cap-preset ${cs.preset === pr.id ? "on" : ""}`} title={pr.hint} data-testid={`caption-preset-${pr.id}`} aria-pressed={cs.preset === pr.id}
                onClick={() => store.edit(`Caption style ${pr.label}`, (q) => ({ ...q, captions: { ...q.captions, style: applyCaptionPreset(q.captions.style, pr.id) } }))}>
                <span className="cap-preset-swatch" style={swatchStyle(st, themeFont, pal)}>
                  <SwatchText st={st} pal={pal} />
                </span>
                <span className="cap-preset-name">{pr.label}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="ctl caption-fonts" role="radiogroup" aria-label="Caption font" data-testid="caption-font">
        <span className="ctl-label">Font</span>
        <input className="cap-font-search" type="search" placeholder={`Search ${CAPTION_FONTS.length - 1 + mine.length} fonts`} value={query} onChange={(e) => setQuery(e.target.value)} data-testid="caption-font-search" aria-label="Search fonts" />
        <div className="cap-font-cats" role="tablist" aria-label="Font category">
          {CAPTION_FONT_CATEGORIES.map((c) => (
            <button key={c.id} type="button" role="tab" aria-selected={cat === c.id} className={`cap-font-cat ${cat === c.id ? "on" : ""}`} data-testid={`caption-font-cat-${c.id}`} onClick={() => setCat(c.id)}>
              {c.label}
            </button>
          ))}
        </div>
        <div className="cap-font-list" data-testid="caption-font-list">
          {builtins.map((o) => {
            const fam = o.family === "@font" ? (themeFont === DEFAULT_FONT ? undefined : themeFont) : o.family;
            const bad = fam ? loaded[fam] === false : false;
            const on = current === o.family;
            return (
              <button key={o.family} type="button" role="radio" aria-checked={on} className={`cap-font ${on ? "on" : ""}`} data-testid={`caption-font-${slug(o.family === "@font" ? "theme" : o.family)}`}
                disabled={bad} title={bad ? `${o.label} could not be loaded` : o.family === "@font" ? `Follows the theme / brand font (${themeFont})` : `${o.label} · ${o.kind}`}
                style={{ fontFamily: familyCss(fam), fontWeight: look.weight === "regular" || !o.bold ? 400 : 700 }}
                onClick={() => edit(`Caption font ${o.label}`, () => (o.family === "@font" ? { font: undefined } : { font: o.family }))}>
                {o.family === "@font" ? `Theme · ${themeFont}` : o.label}
              </button>
            );
          })}
          {mineShown.map((m) => {
            const on = current === m.family;
            const bad = m.inProject && (loaded[m.family] === false || missingFonts.includes(m.family));
            return (
              <span key={`mine-${m.family}`} className={`cap-font mine ${on ? "on" : ""} ${bad ? "bad" : ""}`} data-testid={`caption-myfont-${slug(m.family)}`}>
                <button type="button" role="radio" aria-checked={on} className="cap-font-pick" title={m.inProject ? `${m.family} (imported${m.source?.kind ? ` from ${m.source.kind === "google" ? "Google Fonts" : m.source.kind}` : ""})` : `${m.family}: from your font library (adds it to this project)`}
                  style={{ fontFamily: m.inProject ? familyCss(m.family) : undefined, fontWeight: look.weight === "regular" || !m.bold ? 400 : 700 }}
                  onClick={() => (m.inProject ? edit(`Caption font ${m.family}`, () => ({ font: m.family })) : void store.importCaptionFont({ kind: "library", family: m.family }))}>
                  {m.family}
                </button>
                <button type="button" className="cap-font-remove" title={`Remove ${m.family}${m.inProject ? " from this project" : ""} and from My fonts`} aria-label={`Remove ${m.family}`} data-testid={`caption-myfont-remove-${slug(m.family)}`}
                  onClick={() => void store.removeCaptionFont(m.family, true)}>
                  ×
                </button>
              </span>
            );
          })}
          {!builtins.length && !mineShown.length && <p className="note cap-font-empty">{cat === "mine" && !query ? "No imported fonts yet." : "No font matches."}</p>}
        </div>
        {missing.length > 0 && (
          <p className="note warn cap-font-missing" role="alert" data-testid="caption-font-missing">
            {missing.join(", ")} {missing.length > 1 ? "are" : "is"} missing from this project; captions use {DEFAULT_FONT} until you import {missing.length > 1 ? "them" : "it"} again.
          </p>
        )}
        <button type="button" className="btn small cap-font-import-toggle" data-testid="caption-font-import" aria-expanded={importOpen} onClick={() => setImportOpen((v) => !v)}>
          + Import font…
        </button>
        {importOpen && <FontImport />}
        {(ownSource || importOpen) && (
          <p className="note cap-font-licence" data-testid="caption-font-licence">
            Imported fonts are copied into this project. Check that the font's licence allows use in your videos (Google Fonts are open source: OFL or Apache).
          </p>
        )}
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
      <Segmented label="Highlight as" value={look.highlightStyle === "color" || look.highlightStyle === "box" ? look.highlightStyle : "color"} testId="caption-highlight-style" options={[{ value: "color", label: "Colour" }, { value: "box", label: "Box" }]} onChange={(v) => edit("Highlight style", () => ({ highlightStyle: v }))} />
      <label className="ctl">
        <span className="ctl-label">Spoken word</span>
        <select value={look.highlightStyle} data-testid="caption-highlight-effect" onChange={(e) => edit("Highlight effect", () => ({ highlightStyle: e.target.value as CaptionHighlightStyle }))}>
          <option value="color">Colour</option>
          <option value="box">Box</option>
          <option value="pill">Pill</option>
          <option value="underline">Underline sweep</option>
          <option value="karaoke">Karaoke fill</option>
          <option value="pop">Pop</option>
          <option value="bounce">Bounce</option>
        </select>
      </label>
      <Toggle label="Word by word" value={cs.reveal === true} testId="caption-reveal" hint="Only the words already spoken are shown" onChange={(v) => edit(v ? "Words one by one" : "Whole caption", (c) => { const { reveal: _r, ...rest } = c; return v ? { ...rest, reveal: true } : rest; })} />
    </>
  );
}

/** The import panel: a file from this computer, a font / CSS URL, or a Google Fonts family. */
function FontImport() {
  const fontImport = useEditor((x) => x.fontImport);
  const [mode, setMode] = useState<"file" | "url" | "google">("file");
  const [url, setUrl] = useState("");
  const [family, setFamily] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const busy = fontImport.busy;
  const pickFile = async () => {
    const pick = (desktopFile as unknown as { pickFonts?: () => Promise<string[]> } | null)?.pickFonts;
    if (pick) {
      const paths = await pick();
      if (paths.length) await store.importCaptionFont({ kind: "path", paths });
    } else input.current?.click();
  };
  return (
    <div className="cap-font-importer" data-testid="caption-font-importer">
      <div className="seg small" role="tablist">
        {(["file", "url", "google"] as const).map((m) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? "on" : ""} data-testid={`caption-font-import-${m}`} onClick={() => setMode(m)}>
            {m === "file" ? "From computer" : m === "url" ? "From URL" : "Google Fonts"}
          </button>
        ))}
      </div>
      {mode === "file" && (
        <>
          <input ref={input} type="file" accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2" multiple hidden data-testid="caption-font-file"
            onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ""; if (files.length) void store.importCaptionFont({ kind: "file", files }); }} />
          <button type="button" className="btn small" disabled={!!busy} onClick={() => void pickFile()}>Choose .ttf / .otf / .woff / .woff2…</button>
          <p className="note">Pick one file, or a regular and a bold file of the same family. Up to 10 MB each.</p>
        </>
      )}
      {mode === "url" && (
        <form onSubmit={(e) => { e.preventDefault(); if (url.trim()) void store.importCaptionFont({ kind: "url", url: url.trim() }); }}>
          <input type="url" placeholder="https://…/font.woff2 or a CSS @font-face URL" value={url} onChange={(e) => setUrl(e.target.value)} data-testid="caption-font-url" />
          <button type="submit" className="btn small" disabled={!!busy || !url.trim()} data-testid="caption-font-url-go">Import</button>
        </form>
      )}
      {mode === "google" && (
        <form onSubmit={(e) => { e.preventDefault(); if (family.trim()) void store.importCaptionFont({ kind: "google", family: family.trim() }); }}>
          <input type="search" placeholder="Family name, e.g. Lobster Two" value={family} onChange={(e) => setFamily(e.target.value)} data-testid="caption-font-google" />
          <button type="submit" className="btn small" disabled={!!busy || !family.trim()} data-testid="caption-font-google-go">Download</button>
          <p className="note">Downloads the regular and bold weights from fonts.google.com.</p>
        </form>
      )}
      {busy && <p className="note" data-testid="caption-font-import-busy">Importing {busy}…</p>}
      {fontImport.error && <p className="note warn" role="alert" data-testid="caption-font-import-error">{fontImport.error}</p>}
    </div>
  );
}
