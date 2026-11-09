/**
 * Look tab "Screen" section (feat/canvas-layout): the screen card's X / Y / W / H in output px and its
 * scale (vs the fitted size), Fit / Fill / Center / Reset, and a Crop mode with L / T / R / B insets
 * (source px) that set project.crop. Every change is one store.edit, so undo works.
 */
import { useEffect, useState } from "react";
import { cardRect, fittedCardRect, normalizeCrop, validCard } from "@lens/engine";
import type { Rect } from "@lens/engine";
import { store, useEditor } from "../state/store";
import { cardCenter, cardFill, cardFit, cardReset, insetsOf, scaledRect, setCardRect, setCropInsets, type Insets } from "../state/layoutOps";
import { Section, Toggle } from "./Controls";

function NumField({ label, value, onCommit, testId, min, suffix }: { label: string; value: number; onCommit: (v: number) => void; testId: string; min?: number; suffix?: string }) {
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
  const scale = box.w / Math.max(1, fitted.w);
  const setRect = (label: string, r: Rect) => store.edit(label, (p) => setCardRect(p, r, out));
  const ins = insetsOf(project.crop, meta);
  const setIns = (patch: Partial<Insets>) => store.edit("Crop screen", (p) => setCropInsets(p, { ...insetsOf(p.crop, meta), ...patch }, meta));
  return (
    <Section title="Screen" aside={<span className="ctl-value" data-testid="screen-mode">{free ? "Free" : project.output.fit === "fill" ? "Fill & follow" : "Fit"}</span>}>
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
      <Toggle label="Crop" value={cropMode} testId="screen-crop-mode" hint="Trim the recording's edges (source px)" onChange={setCropMode} />
      {cropMode && (
        <div className="screen-grid" data-testid="screen-crop">
          <NumField label="L" value={ins.l} min={0} testId="crop-l" onCommit={(v) => setIns({ l: v })} />
          <NumField label="T" value={ins.t} min={0} testId="crop-t" onCommit={(v) => setIns({ t: v })} />
          <NumField label="R" value={ins.r} min={0} testId="crop-r" onCommit={(v) => setIns({ r: v })} />
          <NumField label="B" value={ins.b} min={0} testId="crop-b" onCommit={(v) => setIns({ b: v })} />
        </div>
      )}
      <p className="note">Drag the screen on the preview to move it, its corners to resize (Shift keeps the shape, Alt from the centre). Padding applies only to Fit.</p>
    </Section>
  );
}
