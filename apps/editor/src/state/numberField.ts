/**
 * The typed-number half of the inspector Slider (fix/3d-inspector-014): every slider shows its value
 * in an editable field. The field works in the units the slider displays (degrees, %, s, px, x), so
 * typing "3" into "94°" sets 3 degrees and typing "40" into "25%" sets 0.4.
 *
 * The display scale and unit are read off the slider's own format function (format(max) = "100%"
 * for max 1 gives scale 100, unit "%"; "4.0 s" for 4000 gives 0.001, "s"), so no slider needs a new
 * prop to get a working field. Pure functions; test/numberField.test.ts covers them.
 */

export interface FieldSpec {
  /** display = value * scale. */
  scale: number;
  /** Unit text shown after the number ("°", "%", "px", "s", "×"); "" for none. */
  unit: string;
}

const NICE = [0.0001, 0.001, 0.01, 0.1, 1, 10, 100, 1000, 10000];

/** Display scale + unit of a slider from its format function (scale 1, no unit without one). */
export function fieldSpec(format: ((v: number) => string) | undefined, min: number, max: number): FieldSpec {
  if (!format) return { scale: 1, unit: "" };
  for (const probe of [max, min, (min + max) / 2]) {
    if (!probe) continue;
    const m = /^\s*([-+]?\d*\.?\d+)\s*(.*?)\s*$/.exec(format(probe));
    if (!m) continue;
    const shown = Number(m[1]);
    if (!shown) continue;
    const raw = shown / probe;
    // snap to a power of ten: formats round ("4.0 s", "12%"), the true scale never is 0.97
    const nice = NICE.find((n) => Math.abs(raw / n - 1) < 0.05);
    if (nice) return { scale: nice, unit: m[2] ?? "" };
  }
  return { scale: 1, unit: "" };
}

/** Decimals the field needs for one slider step in display units (step 0.005 at scale 100 -> 1). */
export function fieldDecimals(step: number, scale: number): number {
  const s = Math.abs(step * scale);
  if (!(s > 0) || s >= 1) return 0;
  return Math.min(4, Math.ceil(-Math.log10(s) - 1e-9));
}

/** The number as the field shows it while editing (display units, no unit text). */
export function fieldText(value: number, spec: FieldSpec, decimals: number): string {
  const d = value * spec.scale;
  return String(Number(d.toFixed(decimals)));
}

/**
 * Parse what the user typed ("3", "3°", "-12.5 %", "1,5") into a slider value, clamped to [lo, hi].
 * Returns null for text that is not a number (the field then puts the old value back).
 */
export function parseField(text: string, spec: FieldSpec, lo: number, hi: number): number | null {
  const m = /^\s*([-+]?\d*[.,]?\d+)/.exec(text);
  if (!m) return null;
  const d = Number(m[1]!.replace(",", "."));
  if (!Number.isFinite(d)) return null;
  const v = d / spec.scale;
  // round away float noise from the division (0.29 / 100 -> 0.0029, not 0.0029000000000000002)
  const r = Number(v.toPrecision(12));
  return Math.max(lo, Math.min(hi, r));
}

/**
 * Arrow keys in the field: +-1 display unit (Shift +-10), clamped. A slider whose whole range is
 * under 10 display units (a 0.3-2x scale) steps by its own step instead, so one press is not the
 * whole range.
 */
export function stepField(value: number, dir: 1 | -1, big: boolean, spec: FieldSpec, lo: number, hi: number, step = 1, rangeMin = lo, rangeMax = hi): number {
  const unit = (rangeMax - rangeMin) * spec.scale <= 10 ? step * spec.scale : 1;
  const d = value * spec.scale + dir * unit * (big ? 10 : 1);
  return Math.max(lo, Math.min(hi, Number((d / spec.scale).toPrecision(12))));
}
