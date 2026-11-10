/**
 * Integrated loudness (ITU-R BS.1770-4 / EBU R128): K-weighting (pre-filter shelf + RLB high-pass,
 * coefficients derived for any sample rate), 400 ms blocks with 75 % overlap, the -70 LUFS absolute
 * gate and the -10 LU relative gate. Streaming: push stereo (or mono) blocks, read `integrated()`.
 *
 * Used by the music bed (demand #23) to put the music at a level relative to the speech, in the
 * preview (Web Audio, on the decoded buffers) and in the in-app export (on the decoded raw PCM), so
 * both paths compute the same gain from the same function.
 */

interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number }

/** BS.1770 K-weighting stages for sample rate `sr` (the standard's 48 kHz analogue design, bilinear). */
export function kWeighting(sr: number): [Biquad, Biquad] {
  // stage 1: high shelf (+4 dB above ~1.5 kHz)
  const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  const K = Math.tan((Math.PI * f0) / sr);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / Q + K * K;
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  // stage 2: RLB high-pass (~38 Hz)
  const f1 = 38.13547087602444, Q1 = 0.5003270373238773;
  const K1 = Math.tan((Math.PI * f1) / sr);
  const d = 1 + K1 / Q1 + K1 * K1;
  const hp: Biquad = { b0: 1, b1: -2, b2: 1, a1: (2 * (K1 * K1 - 1)) / d, a2: (1 - K1 / Q1 + K1 * K1) / d };
  return [shelf, hp];
}

class Chain {
  private s = [0, 0, 0, 0]; // two biquads, direct form II transposed state
  constructor(private f: [Biquad, Biquad]) {}
  step(x: number): number {
    const [a, b] = this.f;
    const s = this.s;
    const y1 = a.b0 * x + s[0]!;
    s[0] = a.b1 * x - a.a1 * y1 + s[1]!;
    s[1] = a.b2 * x - a.a2 * y1;
    const y2 = b.b0 * y1 + s[2]!;
    s[2] = b.b1 * y1 - b.a1 * y2 + s[3]!;
    s[3] = b.b2 * y1 - b.a2 * y2;
    return y2;
  }
}

export class LoudnessMeter {
  private chains: Chain[];
  private step: number; // samples per 100 ms
  private acc: number[] = []; // sum of squares per 100 ms sub-block (channels summed, G = 1 for L / R)
  private cur = 0;
  private n = 0;
  constructor(readonly sampleRate: number, readonly channels: 1 | 2 = 2) {
    const f = kWeighting(sampleRate);
    this.chains = Array.from({ length: channels }, () => new Chain(f));
    this.step = Math.round(sampleRate / 10);
  }

  /** Push planar channel data (one array per channel, same length). */
  pushPlanar(ch: Float32Array[]): void {
    const len = ch[0]?.length ?? 0;
    for (let i = 0; i < len; i++) {
      let e = 0;
      for (let c = 0; c < this.channels; c++) {
        const y = this.chains[c]!.step(ch[c]![i]!);
        e += y * y;
      }
      this.cur += e;
      if (++this.n === this.step) this.flush();
    }
  }

  /** Push interleaved stereo frames (channels must be 2). */
  pushInterleaved(x: Float32Array): void {
    const n = Math.floor(x.length / 2);
    const [l, r] = this.chains as [Chain, Chain];
    for (let i = 0; i < n; i++) {
      const a = l.step(x[2 * i]!);
      const b = r.step(x[2 * i + 1]!);
      this.cur += a * a + b * b;
      if (++this.n === this.step) this.flush();
    }
  }

  private flush(): void {
    this.acc.push(this.cur / this.step);
    this.cur = 0;
    this.n = 0;
  }

  /** Mean-square energy of each 400 ms gating block (75 % overlap). */
  private blocks(): number[] {
    const out: number[] = [];
    for (let i = 0; i + 4 <= this.acc.length; i++) out.push((this.acc[i]! + this.acc[i + 1]! + this.acc[i + 2]! + this.acc[i + 3]!) / 4);
    return out;
  }

  /** Integrated loudness in LUFS; -Infinity when nothing is above the absolute gate. */
  integrated(): number {
    const lk = (z: number) => -0.691 + 10 * Math.log10(z);
    const abs = this.blocks().filter((z) => z > 0 && lk(z) > -70);
    if (!abs.length) return -Infinity;
    const rel = lk(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
    const g = abs.filter((z) => lk(z) > rel);
    if (!g.length) return -Infinity;
    return lk(g.reduce((a, b) => a + b, 0) / g.length);
  }
}

/** Integrated loudness of planar channels (a mono buffer is measured as the stereo it plays as: both channels). */
export function integratedLoudness(channels: Float32Array[], sampleRate: number): number {
  const ch = channels.length === 1 ? [channels[0]!, channels[0]!] : channels.slice(0, 2);
  const m = new LoudnessMeter(sampleRate, 2);
  m.pushPlanar(ch);
  return m.integrated();
}
