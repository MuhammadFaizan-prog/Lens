/**
 * A Canvas2D stand-in that records every call and style assignment, so a test can hash exactly what a
 * draw routine asks the canvas to do (node has no canvas). Numbers are rounded to 1e-6 so the log is
 * stable text; the same draw code gives the same hash, any change to the drawing changes it.
 */
import { createHash } from "node:crypto";

const fmt = (v: unknown): string => {
  if (typeof v === "number") return Number.isFinite(v) ? (Math.round(v * 1e6) / 1e6).toString() : String(v);
  if (v && typeof v === "object" && "__id" in (v as object)) return `#${(v as { __id: number }).__id}`;
  if (ArrayBuffer.isView(v)) return `buf:${createHash("sha256").update(v as Uint8Array).digest("hex").slice(0, 16)}`;
  if (v && typeof v === "object" && "data" in (v as object)) return fmt((v as { data: unknown }).data);
  return JSON.stringify(v);
};

export function recordingCtx(): { ctx: any; log: string[]; hash: () => string } {
  const log: string[] = [];
  let ids = 0;
  const grad = (kind: string, args: unknown[]) => {
    const g = { __id: ++ids, addColorStop: (a: number, c: string) => log.push(`#${g.__id}.stop(${fmt(a)},${fmt(c)})`) };
    log.push(`#${g.__id}=${kind}(${args.map(fmt).join(",")})`);
    return g;
  };
  const target: Record<string, unknown> = {
    createLinearGradient: (...a: unknown[]) => grad("lin", a),
    createRadialGradient: (...a: unknown[]) => grad("rad", a),
    createConicGradient: (...a: unknown[]) => grad("con", a),
    createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  };
  const ctx = new Proxy(target, {
    get(t, k: string) {
      if (k in t) return t[k];
      return (...a: unknown[]) => {
        log.push(`${k}(${a.map(fmt).join(",")})`);
      };
    },
    set(t, k: string, v) {
      log.push(`${k}=${fmt(v)}`);
      return true;
    },
  });
  return { ctx, log, hash: () => createHash("sha256").update(log.join("\n")).digest("hex") };
}
