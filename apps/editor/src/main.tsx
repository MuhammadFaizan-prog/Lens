import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { store } from "./state/store";
import "./styles.css";

// Test / automation hook (Playwright reads state through it; Tauri will call the same store).
(window as unknown as { __lens: unknown }).__lens = {
  store,
  state: () => {
    const s = store.get();
    const f = s.plan?.frames[s.frame];
    return {
      status: s.status,
      frame: s.frame,
      frames: s.plan?.frames.length ?? 0,
      fps: s.plan?.output.fps ?? 0,
      src: f?.src ?? 0,
      playing: s.playing,
      revision: s.revision,
      cuts: s.project.edits.cuts,
      planCuts: s.plan?.cuts ?? [],
      zooms: s.plan?.zoomSegments.map((z) => ({ startMs: z.startMs, endMs: z.endMs, scale: z.scale, auto: z.auto })) ?? [],
      caption: f?.caption ?? null,
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
