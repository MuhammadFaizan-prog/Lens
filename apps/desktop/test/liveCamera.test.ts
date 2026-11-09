import { describe, expect, it } from "vitest";
import { buildCameraTrack, buildCursorTrack, defaultProject, planAutoZoom } from "../../../packages/engine/src/index";
import type { InputEvent, RecordingMeta } from "../../../packages/engine/src/types";
import { LiveCamera, viewportOf } from "../src/shared/liveCamera";

const meta: RecordingMeta = { width: 1280, height: 720, fps: 60, durationMs: 9000, pixelRatio: 1 };

function session(): InputEvent[] {
  const ev: InputEvent[] = [];
  const pts = [
    { t: 1000, x: 300, y: 200 },
    { t: 4200, x: 1000, y: 560 },
    { t: 7000, x: 640, y: 120 },
  ];
  let last = { x: 640, y: 360 };
  for (let t = 0; t <= meta.durationMs; t += 1000 / 60) {
    // head for the next click, then dwell on it for a second after clicking (as a user reading the result does)
    const next = pts.find((p) => p.t + 1000 >= t) ?? pts[pts.length - 1]!;
    const u = Math.min(1, 1 / 30);
    last = { x: last.x + (next.x - last.x) * u * 4, y: last.y + (next.y - last.y) * u * 4 };
    ev.push({ t, type: "move", x: last.x, y: last.y });
  }
  for (const p of pts) ev.push({ t: p.t, type: "down", x: p.x, y: p.y, button: "left" });
  return ev.sort((a, b) => a.t - b.t);
}

describe("live camera (recorder preview)", () => {
  it("with the final segments and the same cursor samples it reproduces the engine's camera track", () => {
    const cfg = defaultProject().zoom;
    const ev = session();
    const segs = planAutoZoom(ev, meta, cfg);
    const moves = ev.filter((e): e is Extract<InputEvent, { type: "move" }> => e.type === "move");
    const cursor = moves.map((m) => ({ t: m.t, x: m.x, y: m.y, opacity: 1, scale: 1, shape: "arrow" as const, speed: 0 }));
    const ref = buildCameraTrack(cursor, segs, meta, { spring: cfg.spring, followDeadzone: cfg.followDeadzone });
    const live = new LiveCamera(meta, cfg, segs);
    let worst = 0;
    moves.forEach((m, i) => {
      const s = live.step(m.t, m);
      const r = ref[i]!;
      worst = Math.max(worst, Math.abs(s.cx - r.cx), Math.abs(s.cy - r.cy), Math.abs(s.scale - r.scale) * 1000);
    });
    expect(worst).toBeLessThan(1e-6);
    void buildCursorTrack;
  });

  it("re-planned live from the click stream, the viewport holds each click shortly after it", () => {
    const ev = session();
    const live = new LiveCamera(meta);
    const downs = ev.filter((e) => e.type === "down") as Array<Extract<InputEvent, { type: "down" }>>;
    const checks = new Map(downs.map((d) => [d, null as null | { scale: number; inView: boolean }]));
    for (const e of ev) {
      if (e.type === "down") {
        live.push(e);
        continue;
      }
      if (e.type !== "move") continue;
      const s = live.step(e.t, e);
      for (const d of downs) {
        if (checks.get(d) || e.t < d.t + 600) continue;
        const vp = viewportOf(s, meta.width, meta.height);
        checks.set(d, { scale: s.scale, inView: d.x >= vp.x && d.x <= vp.x + vp.w && d.y >= vp.y && d.y <= vp.y + vp.h });
      }
    }
    for (const [d, c] of checks) {
      expect(c, `click at ${d.t}`).not.toBeNull();
      expect(c!.inView, `click at ${d.t} in view`).toBe(true);
      expect(c!.scale, `zoomed in at ${d.t}`).toBeGreaterThan(1.3);
    }
    expect(live.zoomSegments(9000).length).toBe(3);
  });
});
