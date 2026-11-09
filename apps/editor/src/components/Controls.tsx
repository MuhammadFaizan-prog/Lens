import { useMemo, type ReactNode } from "react";
import { projectPalette, resolveColor } from "@lens/engine";
import { useEditor } from "../state/store";

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="insp-section">
      <header>
        <h3>{title}</h3>
        {aside}
      </header>
      <div className="insp-body">{children}</div>
    </section>
  );
}

export function Slider({ label, value, min, max, step, format, onChange, testId }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  testId?: string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <label className="ctl slider">
      <span className="ctl-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        data-testid={testId}
        style={{ ["--pct" as string]: `${Math.max(0, Math.min(100, pct))}%` }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="ctl-value">{format ? format(value) : value}</span>
    </label>
  );
}

export function Toggle({ label, value, onChange, testId, hint }: { label: string; value: boolean; onChange: (v: boolean) => void; testId?: string; hint?: string }) {
  return (
    <label className="ctl toggle" title={hint}>
      <span className="ctl-label">{label}</span>
      <button type="button" role="switch" aria-checked={value} aria-label={label} data-testid={testId} className={`switch ${value ? "on" : ""}`} onClick={() => onChange(!value)}>
        <span />
      </button>
    </label>
  );
}

export function Segmented<T extends string>({ label, value, options, onChange, testId, stacked }: {
  label?: string;
  stacked?: boolean;
  value: T;
  options: Array<{ value: T; label: string; hint?: string }>;
  onChange: (v: T) => void;
  testId?: string;
}) {
  return (
    <div className={`ctl segmented-row ${stacked ? "stacked" : ""}`}>
      {label && <span className="ctl-label">{label}</span>}
      <div className="segmented" role="radiogroup" aria-label={label} data-testid={testId}>
        {options.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className={o.value === value ? "on" : ""} title={o.hint} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Colour field. A theme reference ("@primary") shows the colour it resolves to (preset palette <
 * brand kit) with a "Brand" / "Theme" tag; picking a colour makes it this item's own override,
 * and `onReset` (when given) puts the reference back.
 */
export function ColorInput({ label, value, onChange, testId, onReset }: { label: string; value: string; onChange: (v: string) => void; testId?: string; onReset?: () => void }) {
  const project = useEditor((s) => s.project);
  const pal = useMemo(() => projectPalette(project), [project]);
  const token = value.startsWith("@");
  const shown = token ? resolveColor(value, pal) : value;
  const tag = token ? (project.brand.enabled ? "Brand" : "Theme") : null;
  return (
    <label className={`ctl color ${token ? "inherited" : ""}`}>
      <span className="ctl-label">{label}</span>
      <span className="swatch" style={{ background: shown }}>
        <input type="color" value={shown} aria-label={label} data-testid={testId} data-token={token ? value : undefined} onChange={(e) => onChange(e.target.value)} />
      </span>
      <span className="ctl-value mono">{shown.toUpperCase()}</span>
      {tag && <span className="inherit-tag" title={`Follows the ${tag.toLowerCase()} ${value.slice(1)} colour`}>{tag}</span>}
      {!token && onReset && (
        <button type="button" className="mini-reset" title="Follow the theme / brand colour again" aria-label={`Reset ${label} to theme`} data-testid={testId ? `${testId}-reset` : undefined} onClick={(e) => { e.preventDefault(); onReset(); }}>
          ↺
        </button>
      )}
    </label>
  );
}

export function Select<T extends string>({ label, value, options, onChange, testId }: { label: string; value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; testId?: string }) {
  return (
    <label className="ctl select">
      <span className="ctl-label">{label}</span>
      <select value={value} aria-label={label} data-testid={testId} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
