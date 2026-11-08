/**
 * One Euro filter (Casiez, Roussel, Vogel, CHI 2012): adaptive low-pass that removes jitter at low
 * speed while keeping lag low at high speed. Used as the first stage of cursor smoothing (C01).
 */
export interface OneEuroParams {
  /** Minimum cutoff frequency in Hz. Lower = smoother at rest. */
  minCutoff: number;
  /** Speed coefficient. Higher = less lag on fast moves. */
  beta: number;
  /** Cutoff for the derivative estimate in Hz. */
  dCutoff: number;
}

export const DEFAULT_ONE_EURO: OneEuroParams = { minCutoff: 1.0, beta: 0.007, dCutoff: 1.0 };

function alpha(cutoff: number, dtS: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dtS);
}

export class OneEuroFilter {
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev: number | null = null;

  constructor(private readonly p: OneEuroParams = DEFAULT_ONE_EURO) {}

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }

  filter(x: number, tMs: number): number {
    if (this.xPrev === null || this.tPrev === null) {
      this.xPrev = x;
      this.tPrev = tMs;
      return x;
    }
    const dtS = Math.max((tMs - this.tPrev) / 1000, 1e-6);
    const dx = (x - this.xPrev) / dtS;
    const aD = alpha(this.p.dCutoff, dtS);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    const cutoff = this.p.minCutoff + this.p.beta * Math.abs(dxHat);
    const a = alpha(cutoff, dtS);
    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat;
    this.dxPrev = dxHat;
    this.tPrev = tMs;
    return xHat;
  }
}
