import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { store } from "./state/store";
import { pendingBackdrops } from "./render/backdrops";
import { cursorTemplate } from "./render/cursorProbe";
import "./styles.css";

// Test / automation hook (Playwright reads state through it; Tauri will call the same store).
(window as unknown as { __lens: unknown }).__lens = {
  store,
  /** demand #12 e2e: one cursor type's art where frame n's cursor is, over a flat colour (base64 RGB). */
  cursorTemplate: (n: number, shape: string, bg: [number, number, number]) => {
    const plan = store.get().plan;
    const t = plan ? cursorTemplate(plan, n, shape, bg) : null;
    if (!t) return null;
    let s = "";
    for (let i = 0; i < t.rgb.length; i += 0x8000) s += String.fromCharCode(...t.rgb.subarray(i, i + 0x8000));
    return { x0: t.x0, y0: t.y0, w: t.w, h: t.h, size: t.size, b64: btoa(s) };
  },
  state: () => {
    const s = store.get();
    const f = s.plan?.frames[s.frame];
    return {
      status: s.status,
      error: s.error,
      readyMs: store.readyMs,
      firstPaintMs: store.firstPaintMs,
      durationMs: s.bundle?.meta?.durationMs ?? null,
      frame: s.frame,
      frames: s.plan?.frames.length ?? 0,
      fps: s.plan?.output.fps ?? 0,
      src: f?.src ?? 0,
      playing: s.playing,
      revision: s.revision,
      backdropsPending: pendingBackdrops(),
      cuts: s.project.edits.cuts,
      planCuts: s.plan?.cuts ?? [],
      zooms: s.plan?.zoomSegments.map((z) => ({ startMs: z.startMs, endMs: z.endMs, scale: z.scale, auto: z.auto })) ?? [],
      caption: f?.caption ?? null,
      takes: s.plan?.takes.map((g) => ({ kept: g.kept, auto: g.auto, manual: g.manual, takes: g.takes.map((t) => ({ startMs: t.startMs, endMs: t.endMs, firstWord: t.firstWord, lastWord: t.lastWord })) })) ?? [],
      takeCuts: s.plan?.takeCuts ?? [],
      audition: s.audition,
      canUndo: s.canUndo,
      canRedo: s.canRedo,
      project: s.project,
    };
  },
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
