/**
 * Renders a field backdrop off the UI thread (render/backdrops.ts prepareBackdrop): a 4K backdrop is
 * a few seconds of per-pixel math, which would freeze the editor if done inline.
 */
import { renderBackdropField, type Backdrop } from "@lens/engine";

self.onmessage = (e: MessageEvent<{ id: number; b: Backdrop; W: number; H: number }>) => {
  const { id, b, W, H } = e.data;
  try {
    const px = renderBackdropField(b, W, H);
    (self as unknown as Worker).postMessage({ id, px }, [px.buffer]);
  } catch {
    (self as unknown as Worker).postMessage({ id, px: null });
  }
};
