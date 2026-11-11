/**
 * Crop keyframes in the Custom framing panel (demand #15): with keys, the window shown and every
 * window edit (fields, drag, reset) act on the key at the playhead; without keys nothing changes.
 */
import { describe, expect, it } from "vitest";
import { defaultProject, setFramingKey, type ProjectConfig } from "@lens/engine";
import { editFramingField, framingWindowOf, resetFramingRect, setFramingRect } from "../src/state/layoutOps";

const meta = { width: 1280, height: 720 };
const out = { width: 360, height: 360 };
const custom = (): ProjectConfig => {
  const p = defaultProject();
  return { ...p, output: { ...p.output, aspect: "1:1", resolution: 360, framing: "custom", framingRect: { x: 490, y: 210, w: 300, h: 300 } } };
};

describe("framing keys in the editor (demand #15)", () => {
  it("no keys: the playhead time changes nothing", () => {
    const p = custom();
    expect(framingWindowOf(p, meta, out, 1234)).toEqual(framingWindowOf(p, meta, out));
    expect(setFramingRect(p, { x: 10, y: 10, w: 300, h: 300 }, meta, out, 500)).toEqual(setFramingRect(p, { x: 10, y: 10, w: 300, h: 300 }, meta, out));
    expect(setFramingRect(p, { x: 10, y: 10, w: 300, h: 300 }, meta, out, 500).output.framingKeys).toBeUndefined();
  });

  it("with keys: edits set the key at the playhead, the window is the keyed one", () => {
    let p = setFramingKey(custom(), 100, { x: 170, y: 370, w: 300, h: 300 });
    p = setFramingKey(p, 1900, { x: 750, y: 100, w: 300, h: 300 });
    expect(framingWindowOf(p, meta, out, 0)).toEqual({ x: 170, y: 370, w: 300, h: 300 });
    expect(framingWindowOf(p, meta, out, 1900)).toEqual({ x: 750, y: 100, w: 300, h: 300 });
    const mid = framingWindowOf(p, meta, out, 1000);
    expect(mid.x).toBeGreaterThan(170);
    expect(mid.x).toBeLessThan(750);
    // a field edit at 1900 replaces that key only
    const q = editFramingField(p, "x", 800, meta, out, 1900);
    expect(q.output.framingKeys!.map((k) => [k.srcMs, k.rect.x])).toEqual([[100, 170], [1900, 800]]);
    // a drag at 1000 adds a key there
    const r = setFramingRect(p, { x: 400, y: 200, w: 300, h: 300 }, meta, out, 1000);
    expect(r.output.framingKeys!.map((k) => k.srcMs)).toEqual([100, 1000, 1900]);
    // reset at 100 puts the centred fill window on that key
    const z = resetFramingRect(p, meta, out, 100);
    expect(z.output.framingKeys![0]!.rect).toEqual({ x: 280, y: 0, w: 720, h: 720 });
  });
});
