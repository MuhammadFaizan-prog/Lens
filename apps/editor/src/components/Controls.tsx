import type { ReactNode } from "react";

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

export function ColorInput({ label, value, onChange, testId }: { label: string; value: string; onChange: (v: string) => void; testId?: string }) {
  return (
    <label className="ctl color">
      <span className="ctl-label">{label}</span>
      <span className="swatch" style={{ background: value }}>
        <input type="color" value={value} aria-label={label} data-testid={testId} onChange={(e) => onChange(e.target.value)} />
      </span>
      <span className="ctl-value mono">{value.toUpperCase()}</span>
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
