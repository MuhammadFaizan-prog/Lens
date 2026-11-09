/**
 * Canvas aspect picker (feat/canvas-layout): Auto, 16:9, 9:16, 1:1, 4:5, 4:3, 21:9 or a custom W x H.
 * Shown compact in the preview toolbar and as a full row in the Look tab. Picking one re-fits the
 * screen card (card null) and fits the whole recording: an aspect change never crops.
 */
import { useEffect, useState } from "react";
import { store, useEditor } from "../state/store";
import { ASPECTS, aspectChoiceOf, aspectLabel, setAspect, setCustomSize, type AspectChoice } from "../state/layoutOps";

const OPTIONS: AspectChoice[] = [...ASPECTS, "custom"];

function pick(a: AspectChoice): void {
  if (a === "custom") {
    // start the custom size from the canvas as it is now
    const out = store.get().plan?.output;
    const w = out?.width ?? 1920;
    const h = out?.height ?? 1080;
    store.edit(`Canvas ${w}×${h}`, (q) => setCustomSize(q, w, h));
  } else store.edit(`Aspect ${aspectLabel(a)}`, (q) => setAspect(q, a));
}

function CustomSize({ compact }: { compact?: boolean }) {
  const size = useEditor((s) => s.project.output.size);
  const [w, setW] = useState(String(size?.w ?? ""));
  const [h, setH] = useState(String(size?.h ?? ""));
  useEffect(() => {
    setW(String(size?.w ?? ""));
    setH(String(size?.h ?? ""));
  }, [size?.w, size?.h]);
  const commit = () => {
    const nw = Number(w);
    const nh = Number(h);
    if (nw > 0 && nh > 0 && (nw !== size?.w || nh !== size?.h)) store.edit(`Canvas ${nw}×${nh}`, (q) => setCustomSize(q, nw, nh));
    else {
      setW(String(size?.w ?? ""));
      setH(String(size?.h ?? ""));
    }
  };
  const field = (v: string, set: (s: string) => void, label: string, testId: string) => (
    <input className="num-input" type="number" min={16} max={8192} step={2} value={v} aria-label={label} data-testid={testId}
      onChange={(e) => set(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
  );
  return (
    <span className={`custom-size ${compact ? "compact" : ""}`} data-testid={compact ? "tb-custom-size" : "custom-size"}>
      {field(w, setW, "Canvas width", compact ? "tb-size-w" : "size-w")}
      <span className="times">×</span>
      {field(h, setH, "Canvas height", compact ? "tb-size-h" : "size-h")}
    </span>
  );
}

/** Compact toolbar picker. */
export function AspectSelect() {
  const choice = useEditor((s) => aspectChoiceOf(s.project));
  return (
    <span className="aspect-select" data-testid="tb-aspect-wrap">
      <select className="tb-select" value={choice} aria-label="Canvas aspect" title="Canvas aspect: the screen re-fits, nothing is cropped" data-testid="tb-aspect" onChange={(e) => pick(e.target.value as AspectChoice)}>
        {OPTIONS.map((a) => (
          <option key={a} value={a}>
            {a === "custom" ? "Custom W×H" : aspectLabel(a)}
          </option>
        ))}
      </select>
      {choice === "custom" && <CustomSize compact />}
    </span>
  );
}

/** Look tab picker. */
export function AspectRow() {
  const choice = useEditor((s) => aspectChoiceOf(s.project));
  return (
    <div className="aspect-row" data-testid="aspect-row">
      <div className="ctl segmented-row stacked">
        <span className="ctl-label">Aspect</span>
        <div className="segmented wrap" role="radiogroup" aria-label="Aspect" data-testid="aspect">
          {OPTIONS.map((a) => (
            <button key={a} type="button" role="radio" aria-checked={a === choice} className={a === choice ? "on" : ""} data-testid={`aspect-${a.replace(":", "x")}`} onClick={() => pick(a)}>
              {aspectLabel(a)}
            </button>
          ))}
        </div>
      </div>
      {choice === "custom" && (
        <label className="ctl">
          <span className="ctl-label">Size (px)</span>
          <CustomSize />
        </label>
      )}
    </div>
  );
}
