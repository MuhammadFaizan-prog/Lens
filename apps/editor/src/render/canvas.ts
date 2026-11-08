export type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

export function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}
