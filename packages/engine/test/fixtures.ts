import type { InputEvent, RecordingMeta } from "../src/types.js";

export const META: RecordingMeta = { width: 1920, height: 1080, fps: 60, durationMs: 12000, pixelRatio: 1 };

/** Straight-line mouse move sampled every 8 ms (a typical 120 Hz event rate). */
export function move(from: [number, number], to: [number, number], t0: number, durMs: number, jitter = 0): InputEvent[] {
  const out: InputEvent[] = [];
  const n = Math.max(1, Math.round(durMs / 8));
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
    out.push({ t: t0 + u * durMs, type: "move", x: from[0] + (to[0] - from[0]) * e + rnd() * jitter, y: from[1] + (to[1] - from[1]) * e + rnd() * jitter });
  }
  return out;
}

export function click(x: number, y: number, t: number): InputEvent[] {
  return [
    { t, type: "down", x, y, button: "left" },
    { t: t + 90, type: "up", x, y, button: "left" },
  ];
}

export function typing(text: string, t0: number, gapMs = 120): InputEvent[] {
  return [...text].map((ch, i) => ({ t: t0 + i * gapMs, type: "key" as const, key: ch, modifiers: [] }));
}

/**
 * A canonical demo session: move to a button, click, type into a field, press a shortcut,
 * move far away and click again, then sit idle. Mirrors research/scripts/session-basic.
 */
export function demoSession(): InputEvent[] {
  return [
    ...move([960, 540], [400, 300], 0, 600, 1.5),
    ...click(400, 300, 900),
    ...move([400, 300], [420, 360], 1200, 300),
    ...click(420, 360, 1600),
    ...typing("hello lens world", 1800),
    { t: 4200, type: "key", key: "s", modifiers: ["cmd"] },
    ...move([420, 360], [1600, 900], 5000, 700, 1.5),
    ...click(1600, 900, 6000),
    // idle until 12 s
  ].sort((a, b) => a.t - b.t);
}
