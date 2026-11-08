import type { SpringParams } from "./types.js";

/**
 * Exact closed-form solution of a damped harmonic oscillator moving toward a target.
 * x'' = -(k/m)(x - target) - (c/m) x'
 * Handles under-, critically- and over-damped regimes. Deterministic and frame-rate independent,
 * so preview and export produce identical motion (Rules.md: one motion model everywhere).
 */
export interface SpringState {
  x: number;
  v: number;
}

export function criticalDamping(stiffness: number, mass = 1): number {
  return 2 * Math.sqrt(stiffness * mass);
}

/** Damping ratio zeta = c / (2 sqrt(k m)). */
export function dampingRatio(p: SpringParams): number {
  return p.damping / (2 * Math.sqrt(p.stiffness * p.mass));
}

/** Build spring params from a perceptual description: settle time (ms, to within 1%) and damping ratio. */
export function springFromSettle(settleMs: number, zeta = 1, mass = 1): SpringParams {
  // For zeta >= ~0.7 the 1% settle time is roughly 4.6 / (zeta * omega). For critical damping
  // the (1 + w t) e^{-w t} envelope reaches 1% at w t ~= 6.64.
  const settleS = settleMs / 1000;
  const omega = zeta >= 1 ? 6.638 / settleS : 4.6 / (zeta * settleS);
  const stiffness = omega * omega * mass;
  return { stiffness, damping: 2 * zeta * Math.sqrt(stiffness * mass), mass };
}

/** Advance a spring by dtMs toward target using the exact solution. */
export function stepSpring(state: SpringState, target: number, dtMs: number, p: SpringParams): SpringState {
  const t = dtMs / 1000;
  if (t <= 0) return { ...state };
  const m = p.mass;
  const k = p.stiffness;
  const c = p.damping;
  const omega0 = Math.sqrt(k / m);
  const zeta = c / (2 * Math.sqrt(k * m));
  const x0 = state.x - target;
  const v0 = state.v;
  let x: number;
  let v: number;
  if (Math.abs(zeta - 1) < 1e-6) {
    // Critically damped
    const a = x0;
    const b = v0 + omega0 * x0;
    const e = Math.exp(-omega0 * t);
    x = (a + b * t) * e;
    v = (b - omega0 * (a + b * t)) * e;
  } else if (zeta < 1) {
    const wd = omega0 * Math.sqrt(1 - zeta * zeta);
    const e = Math.exp(-zeta * omega0 * t);
    const a = x0;
    const b = (v0 + zeta * omega0 * x0) / wd;
    const cos = Math.cos(wd * t);
    const sin = Math.sin(wd * t);
    x = e * (a * cos + b * sin);
    v = e * ((-zeta * omega0) * (a * cos + b * sin) + (-a * wd * sin + b * wd * cos));
  } else {
    const s = omega0 * Math.sqrt(zeta * zeta - 1);
    const r1 = -zeta * omega0 + s;
    const r2 = -zeta * omega0 - s;
    const c2 = (v0 - r1 * x0) / (r2 - r1);
    const c1 = x0 - c2;
    const e1 = Math.exp(r1 * t);
    const e2 = Math.exp(r2 * t);
    x = c1 * e1 + c2 * e2;
    v = c1 * r1 * e1 + c2 * r2 * e2;
  }
  return { x: x + target, v };
}

/**
 * Sample a spring that follows a piecewise-constant target signal at a fixed frame rate.
 * targetAt(tMs) returns the target in effect at that time. Returns position and velocity per frame.
 */
export function sampleSpring(
  targetAt: (tMs: number) => number,
  frames: number,
  fps: number,
  p: SpringParams,
  initial?: SpringState,
): SpringState[] {
  const dt = 1000 / fps;
  const out: SpringState[] = [];
  let s: SpringState = initial ?? { x: targetAt(0), v: 0 };
  out.push(s);
  for (let i = 1; i < frames; i++) {
    // The target in effect during the interval is sampled at its start (zero-order hold),
    // matching how a recorder reacts to an event that already happened.
    s = stepSpring(s, targetAt((i - 1) * dt), dt, p);
    out.push(s);
  }
  return out;
}
