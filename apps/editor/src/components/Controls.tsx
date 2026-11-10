import { useMemo, useState, type ReactNode } from "react";
import { projectPalette, resolveColor } from "@lens/engine";
import { store, useEditor } from "../state/store";
import { fieldDecimals, fieldSpec, fieldText, parseField, stepField } from "../state/numberField";

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

/**
 * A labelled slider row: label / range (takes the free width) / editable number / reset.
 *  - The number is a text field in the slider's display units (read off `format`): type a value and
 *    press Enter or leave the field to set it, Esc puts the old value back, Up/Down step it by 1
 *    (Shift: 10). Typed values are clamped to [inputMin, inputMax] (default the slider range), so a
 *    control whose engine accepts more than its slider shows (3D angles) can take 360 or -720.
 *  - `defaultValue` adds a reset button (↺) and double-click on the range resets too.
 * Typed values, steps and resets are each committed as their own undo step.
 */
export function Slider({ label, value, min, max, step, format, onChange, testId, disabled, defaultValue, inputMin, inputMax }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  testId?: string;
  disabled?: boolean;
  /** The control's default: shows the reset button and enables double-click reset. */
  defaultValue?: number;
  /** Bounds for typed values (default min / max). */
  inputMin?: number;
  inputMax?: number;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  const spec = useMemo(() => fieldSpec(format, min, max), [format, min, max]);
  const decimals = fieldDecimals(step, spec.scale);
  const lo = inputMin ?? min;
  const hi = inputMax ?? max;
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (v: number) => {
    if (disabled) return;
    if (v !== value) {
      store.commitPending();
      onChange(v);
    }
    // close the tweak gesture so this value is one undo step of its own
    store.commitPending();
  };
  const finish = () => {
    if (draft === null) return;
    const v = parseField(draft, spec, lo, hi);
    setDraft(null);
    if (v !== null) commit(v);
  };
  const isDefault = defaultValue !== undefined && Math.abs(value - defaultValue) < 1e-9;
  return (
    <div className={`ctl slider ${disabled ? "disabled" : ""} ${defaultValue !== undefined ? "has-reset" : ""}`}>
      <span className="ctl-label" title={label}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        data-testid={testId}
        disabled={disabled}
        title={defaultValue !== undefined ? "Double-click to reset" : undefined}
        style={{ ["--pct" as string]: `${Math.max(0, Math.min(100, pct))}%` }}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => defaultValue !== undefined && commit(defaultValue)}
      />
      <input
        type="text"
        inputMode="decimal"
        className="ctl-value ctl-num"
        aria-label={`${label} value`}
        data-testid={testId ? `${testId}-value` : undefined}
        disabled={disabled}
        spellCheck={false}
        value={draft ?? (format ? format(value) : String(value))}
        onFocus={(e) => {
          setDraft(fieldText(value, spec, decimals));
          const el = e.currentTarget;
          requestAnimationFrame(() => el.select());
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={finish}
        onKeyDown={(e) => {
          // the editor's shortcuts (space = play, Delete, J/K/L, Alt+arrows) stay out of a typed value
          e.stopPropagation();
          if (e.key === "Enter") {
            finish();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setDraft(null);
            e.currentTarget.blur();
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const v = stepField(value, e.key === "ArrowUp" ? 1 : -1, e.shiftKey, spec, lo, hi, step, min, max);
            commit(v);
            setDraft(fieldText(v, spec, decimals));
          }
        }}
      />
      {defaultValue !== undefined && (
        <button
          type="button"
          className="mini-reset"
          title={`Reset ${label} to ${format ? format(defaultValue) : defaultValue}`}
          aria-label={`Reset ${label}`}
          data-testid={testId ? `${testId}-reset` : undefined}
          disabled={disabled || isDefault}
          onClick={() => commit(defaultValue)}
        >
          ↺
        </button>
      )}
    </div>
  );
}

export function Toggle({ label, value, onChange, testId, hint, disabled }: { label: string; value: boolean; onChange: (v: boolean) => void; testId?: string; hint?: string; disabled?: boolean }) {
  return (
    <label className={`ctl toggle ${disabled ? "disabled" : ""}`} title={hint}>
      <span className="ctl-label">{label}</span>
      <button type="button" role="switch" aria-checked={value} aria-label={label} data-testid={testId} disabled={disabled} className={`switch ${value ? "on" : ""}`} onClick={() => !disabled && onChange(!value)}>
        <span />
      </button>
    </label>
  );
}

export function Segmented<T extends string>({ label, value, options, onChange, testId, stacked, disabled }: {
  label?: string;
  stacked?: boolean;
  disabled?: boolean;
  value: T;
  options: Array<{ value: T; label: string; hint?: string }>;
  onChange: (v: T) => void;
  testId?: string;
}) {
  return (
    <div className={`ctl segmented-row ${stacked ? "stacked" : ""} ${disabled ? "disabled" : ""}`}>
      {label && <span className="ctl-label">{label}</span>}
      <div className="segmented" role="radiogroup" aria-label={label} data-testid={testId}>
        {options.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className={o.value === value ? "on" : ""} title={o.hint ?? o.label} disabled={disabled} onClick={() => onChange(o.value)}>
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

export function Select<T extends string>({ label, value, options, onChange, testId, disabled }: { label: string; value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; testId?: string; disabled?: boolean }) {
  return (
    <label className={`ctl select ${disabled ? "disabled" : ""}`}>
      <span className="ctl-label">{label}</span>
      <select value={value} aria-label={label} data-testid={testId} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
