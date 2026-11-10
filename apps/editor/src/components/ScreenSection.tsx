/**
 * Look tab "Screen" section (feat/canvas-layout): the screen card's X / Y / W / H in output px and its
 * scale (vs the fitted size), Fit / Fill / Center / Reset, and a Crop mode with L / T / R / B insets
 * (source px) that set project.crop. Every change is one store.edit, so undo works.
 */
import { useEffect, useState } from "react";
import { cardRect, fittedCardRect, FRAMING_MODES, normalizeCrop, validCard } from "@lens/engine";
import type { FramingMode, Rect } from "@lens/engine";
import { store, useEditor } from "../state/store";
import { cardCenter, cardFill, cardFit, cardReset, editFramingField, FRAMING_HINTS, FRAMING_LABELS, framingChoiceOf, framingWindowOf, insetsOf, resetFramingRect, scaledRect, setCardRect, setCropInsets, setFraming, type Insets } from "../state/layoutOps";
import { Section, Toggle } from "./Controls";

export function NumField({ label, value, onCommit, testId, min, suffix }: { label: string; value: number; onCommit: (v: number) => void; testId: string; min?: number; suffix?: string }) {
  const [v, setV] = useState(String(Math.round(value)));
  useEffect(() => setV(String(Math.round(value))), [value]);
  const commit = () => {
    const n = Number(v);
    if (Number.isFinite(n) && v.trim() !== "" && Math.round(n) !== Math.round(value) && (min === undefined || n >= min)) onCommit(n);
    else setV(String(Math.round(value)));
  };
  return (
    <label>
      <span>{label}{suffix ? ` ${suffix}` : ""}</span>
      <input className="num-input" type="number" value={v} aria-label={label} data-testid={testId} min={min}
        onChange={(e) => setV(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
    </label>
  );
}

/** Tiny picture of each framing mode: the canvas (outline) and the recording (filled). */
function FramingGlyph({ mode }: { mode: FramingMode }) {
  const canvas = <rect x="7" y="1" width="10" height="18" rx="1.5" className="fg-canvas" />;
  const rec =
    mode === "fit" ? <rect x="7.5" y="7" width="9" height="5.5" className="fg-rec" />
    : mode === "fill" ? <rect x="7" y="1" width="10" height="18" className="fg-rec" />
    : mode === "follow" ? <><rect x="7" y="1" width="10" height="18" className="fg-rec" /><path d="M12.5 8.5l3.5 3.2-1.6.2.9 2-.9.4-.9-2-1 1.1z" className="fg-cursor" /></>
    : <><rect x="7" y="1" width="10" height="18" className="fg-rec" /><rect x="9" y="5" width="6" height="8" className="fg-crop" /></>;
  return <svg viewBox="0 0 24 20" width="24" height="20" aria-hidden="true">{rec}{canvas}</svg>;
}

/**
 * Framing (fix/aspect-framing-014): which part of the recording fills the canvas when the aspect
 * differs: Fit / Fill / Follow cursor / Custom. Shown under the aspect picker (Look > Output) and in
 * the Screen section; `idPrefix` keeps their test ids apart. Every pick is one undo step.
 */
export function FramingTiles({ idPrefix, tilesOnly }: { idPrefix: string; tilesOnly?: boolean }) {
  const project = useEditor((s) => s.project);
  const plan = useEditor((s) => s.plan);
  const meta = useEditor((s) => s.bundle?.meta);
  const editing = useEditor((s) => s.framingEdit);
  if (!plan || !meta) return null;
  const out = { width: plan.output.width, height: plan.output.height };
  const choice = framingChoiceOf(project);
  const pick = (m: FramingMode) => {
    store.edit(`Framing: ${FRAMING_LABELS[m]}`, (p) => setFraming(p, m, meta, out));
    store.setFramingEdit(m === "custom");
  };
  const win = choice === "custom" ? framingWindowOf(project, meta, out) : null;
  const field = (f: "x" | "y" | "w" | "h", label: string) => (
    <NumField label={label} value={win ? win[f] : 0} min={f === "w" || f === "h" ? 16 : 0} testId={`${idPrefix}-${f}`}
      onCommit={(v) => store.edit("Move framing", (p) => editFramingField(p, f, v, meta, out))} />
  );
  return (
    <div className="framing" data-testid={`${idPrefix}`} data-mode={choice}>
      <span className="ctl-label">Framing</span>
      <div className="framing-tiles" role="radiogroup" aria-label="Framing">
        {FRAMING_MODES.map((m) => (
          <button key={m} type="button" role="radio" aria-checked={choice === m} className={`framing-tile ${choice === m ? "on" : ""}`}
            data-testid={`${idPrefix}-${m}`} title={FRAMING_HINTS[m]} onClick={() => pick(m)}>
            <FramingGlyph mode={m} />
            <span>{FRAMING_LABELS[m]}</span>
          </button>
        ))}
      </div>
      {choice === "free" && !tilesOnly && <p className="note">The screen is placed by hand; pick a framing to re-fit it.</p>}
      {win && !tilesOnly && (
        <div className="framing-custom" data-testid={`${idPrefix}-custom-panel`}>
          <div className="screen-grid">
            {field("x", "X")}
            {field("y", "Y")}
            {field("w", "W")}
            {field("h", "H")}
          </div>
          <div className="screen-actions">
            <button className={`chip-btn ${editing ? "on" : ""}`} data-testid={`${idPrefix}-adjust`} title="Show the whole recording and drag / resize the part shown"
              onClick={() => store.setFramingEdit(!editing)}>{editing ? "Done" : "Adjust on preview"}</button>
            <button className="chip-btn" data-testid={`${idPrefix}-reset`} title="Back to the centred fill" onClick={() => store.edit("Reset framing", (p) => resetFramingRect(p, meta, out))}>Reset</button>
          </div>
          <p className="note">Source px; the shape follows the canvas. {editing ? "Drag the box on the preview, corners resize." : ""}</p>
        </div>
      )}
    </div>
  );
}

export function ScreenSection() {
  const project = useEditor((s) => s.project);
  const plan = useEditor((s) => s.plan);
  const meta = useEditor((s) => s.bundle?.meta);
  const [cropMode, setCropMode] = useState(false);
  if (!plan || !meta) return null;
  const out = { width: plan.output.width, height: plan.output.height };
  const userCrop = normalizeCrop(project.crop, meta);
  const aspect = userCrop.w / Math.max(1, userCrop.h);
  const fitted = fittedCardRect(out, aspect, project);
  const box = cardRect(out, aspect, project);
  const free = validCard(project.card);
  // the card's own X / Y / W / H and buttons apply to Fit and a free card; Fill / Follow / Custom cover the canvas
  const cardControls = free || framingChoiceOf(project) === "fit";
  const scale = box.w / Math.max(1, fitted.w);
  const setRect = (label: string, r: Rect) => store.edit(label, (p) => setCardRect(p, r, out));
  const ins = insetsOf(project.crop, meta);
  const setIns = (patch: Partial<Insets>) => store.edit("Crop screen", (p) => setCropInsets(p, { ...insetsOf(p.crop, meta), ...patch }, meta));
  return (
    <Section title="Screen" aside={<span className="ctl-value" data-testid="screen-mode">{free ? "Free" : FRAMING_LABELS[framingChoiceOf(project) as FramingMode]}</span>}>
      <FramingTiles idPrefix="framing" />
      {cardControls && (<>
      <span className="ctl-label">Card</span>
      <div className="screen-grid" data-testid="screen-xywh">
        <NumField label="X" value={box.x} testId="screen-x" onCommit={(v) => setRect("Move screen", { ...box, x: v })} />
        <NumField label="Y" value={box.y} testId="screen-y" onCommit={(v) => setRect("Move screen", { ...box, y: v })} />
        <NumField label="W" value={box.w} min={16} testId="screen-w" onCommit={(v) => setRect("Resize screen", { ...box, w: v })} />
        <NumField label="H" value={box.h} min={16} testId="screen-h" onCommit={(v) => setRect("Resize screen", { ...box, h: v })} />
      </div>
      <div className="screen-grid">
        <NumField label="Scale" suffix="%" value={scale * 100} min={2} testId="screen-scale" onCommit={(v) => setRect("Scale screen", scaledRect(box, fitted, v / 100))} />
      </div>
      <div className="screen-actions">
        <button className={`chip-btn ${!free ? "on" : ""}`} data-testid="screen-fit" title="Fit the whole screen inside the padding" onClick={() => store.edit("Fit screen", cardFit)}>Fit</button>
        <button className="chip-btn" data-testid="screen-fill" title="Cover the canvas; the screen is trimmed to its shape, never stretched" onClick={() => store.edit("Fill screen", cardFill)}>Fill</button>
        <button className="chip-btn" data-testid="screen-center" title="Centre the screen, keeping its size" onClick={() => store.edit("Center screen", (p) => cardCenter(p, box, out))}>Center</button>
        <button className="chip-btn" data-testid="screen-reset" title="Fit, and clear the crop" onClick={() => store.edit("Reset screen", cardReset)}>Reset</button>
      </div>
      </>)}
      <Toggle label="Crop" value={cropMode} testId="screen-crop-mode" hint="Trim the recording's edges (source px)" onChange={setCropMode} />
      {cropMode && (
        <div className="screen-grid" data-testid="screen-crop">
          <NumField label="L" value={ins.l} min={0} testId="crop-l" onCommit={(v) => setIns({ l: v })} />
          <NumField label="T" value={ins.t} min={0} testId="crop-t" onCommit={(v) => setIns({ t: v })} />
          <NumField label="R" value={ins.r} min={0} testId="crop-r" onCommit={(v) => setIns({ r: v })} />
          <NumField label="B" value={ins.b} min={0} testId="crop-b" onCommit={(v) => setIns({ b: v })} />
        </div>
      )}
      <p className="note">{cardControls ? "Drag the screen on the preview to move it, its corners to resize (Shift keeps the shape, Alt from the centre). Padding applies only to Fit." : "Drag the picture on the preview to pan the part shown, its corners to zoom (it becomes Custom)."}</p>
    </Section>
  );
}
