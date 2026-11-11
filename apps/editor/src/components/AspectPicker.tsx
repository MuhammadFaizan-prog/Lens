/**
 * Canvas aspect picker (feat/canvas-layout): Auto, 16:9, 9:16, 1:1, 4:5, 4:3, 21:9 or a custom W x H.
 * Shown compact in the preview toolbar and as a full row in the Look tab. Picking one re-fits the
 * screen card (card null) and fits the whole recording: an aspect change never crops.
 */
import { useEffect, useState } from "react";
import { store, useEditor } from "../state/store";
import { ASPECTS, aspectChoiceOf, aspectLabel, FRAMING_HINTS, FRAMING_LABELS, framingChoiceOf, setAspect, setCustomSize, setFraming, type AspectChoice } from "../state/layoutOps";
import { FRAMING_MODES, type FramingMode } from "@lens/engine";

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

/** Compact framing picker next to the toolbar aspect (fix/aspect-framing-014). */
function FramingSelect() {
  const choice = useEditor((s) => framingChoiceOf(s.project));
  const meta = useEditor((s) => s.bundle?.meta);
  const out = useEditor((s) => s.plan?.output);
  if (!meta || !out) return null;
  return (
    <select className="tb-select" value={choice} aria-label="Framing" title="Which part of the recording fills the canvas" data-testid="tb-framing"
      onChange={(e) => {
        const m = e.target.value as FramingMode;
        store.edit(`Framing: ${FRAMING_LABELS[m]}`, (q) => setFraming(q, m, meta, { width: out.width, height: out.height }));
        store.setFramingEdit(m === "custom");
      }}>
      {choice === "free" && <option value="free" disabled>Free</option>}
      {FRAMING_MODES.map((m) => <option key={m} value={m} title={FRAMING_HINTS[m]}>{FRAMING_LABELS[m]}</option>)}
    </select>
  );
}

/** Compact toolbar picker. */
export function AspectSelect() {
  const choice = useEditor((s) => aspectChoiceOf(s.project));
  const targets = useEditor((s) => s.project.exportTargets);
  // several sizes (demand #15): the toolbar picks which size is shown and edited
  if (targets?.items.length)
    return (
      <span className="aspect-select" data-testid="tb-aspect-wrap">
        <select className="tb-select" value={targets.active} aria-label="Size shown" title="Several sizes: pick the one to preview and frame" data-testid="tb-target" onChange={(e) => store.showExportTarget(e.target.value)}>
          {targets.items.map((t) => (
            <option key={t.id} value={t.id}>{aspectLabel(t.aspect as AspectChoice)}{t.enabled ? "" : " (off)"}</option>
          ))}
        </select>
        <FramingSelect />
      </span>
    );
  return (
    <span className="aspect-select" data-testid="tb-aspect-wrap">
      <select className="tb-select" value={choice} aria-label="Canvas aspect" title="Canvas aspect: the screen re-fits, centred; pick the framing next to it" data-testid="tb-aspect" onChange={(e) => pick(e.target.value as AspectChoice)}>
        {OPTIONS.map((a) => (
          <option key={a} value={a}>
            {a === "custom" ? "Custom W×H" : aspectLabel(a)}
          </option>
        ))}
      </select>
      {choice === "custom" && <CustomSize compact />}
      <FramingSelect />
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
