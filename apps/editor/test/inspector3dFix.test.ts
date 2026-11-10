/**
 * fix/3d-inspector-014: the slider number field (display units read off the slider's format),
 * keyframe time editing / reset, the template tile pose, and the store's keyframe fixes
 * (End key seek lands inside the block, Delete removes the selected keyframe, Reset keyframe /
 * Reset all, typed values are one undo step each).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { MOTION3D_TEMPLATES, type Motion3DSegment } from "@lens/engine";
import { fieldDecimals, fieldSpec, fieldText, parseField, stepField } from "../src/state/numberField";

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  length: 0,
};

const { store } = await import("../src/state/store");
const { keyAtRange, resetKeyPose, setKeyAt, templateTilePose, keyAt } = await import("../src/state/motion3dOps");

const deg = (v: number) => `${Math.round(v)}°`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const sec = (v: number) => `${(v / 1000).toFixed(1)} s`;
const px = (v: number) => `${Math.round(v)} px`;

describe("slider number field", () => {
  it("reads display scale and unit off the format", () => {
    expect(fieldSpec(deg, -180, 180)).toEqual({ scale: 1, unit: "°" });
    expect(fieldSpec(pct, -0.5, 0.5)).toEqual({ scale: 100, unit: "%" });
    expect(fieldSpec(pct, 0, 0.12)).toEqual({ scale: 100, unit: "%" });
    expect(fieldSpec(sec, 300, 4000)).toEqual({ scale: 0.001, unit: "s" });
    expect(fieldSpec(px, -1500, 1000)).toEqual({ scale: 1, unit: "px" });
    expect(fieldSpec((v) => `${v.toFixed(2)}×`, 0.3, 2)).toEqual({ scale: 1, unit: "×" });
    expect(fieldSpec((v) => (v ? String(v) : "off"), 0, 80)).toEqual({ scale: 1, unit: "" });
    expect(fieldSpec((v) => `${v} LUFS`, -24, -10)).toEqual({ scale: 1, unit: "LUFS" });
    expect(fieldSpec(undefined, 1, 12)).toEqual({ scale: 1, unit: "" });
  });

  it("typing 3 into a 94° field sets exactly 3; clamps; rejects text", () => {
    const s = fieldSpec(deg, -180, 180);
    expect(parseField("3", s, -3600, 3600)).toBe(3);
    expect(parseField(" -12.5° ", s, -3600, 3600)).toBe(-12.5);
    expect(parseField("360", s, -3600, 3600)).toBe(360);
    expect(parseField("360", s, -180, 180)).toBe(180);
    expect(parseField("abc", s, -180, 180)).toBeNull();
    expect(parseField("", s, -180, 180)).toBeNull();
    const p = fieldSpec(pct, -0.5, 0.5);
    expect(parseField("29", p, -2, 2)).toBe(0.29);
    expect(parseField("1,5", fieldSpec(sec, 0, 2000), 0, 2000)).toBe(1500);
  });

  it("shows the value in display units while editing; arrows step 1 (Shift 10)", () => {
    const p = fieldSpec(pct, 0, 0.25);
    expect(fieldText(0.08, p, fieldDecimals(0.005, p.scale))).toBe("8");
    expect(fieldText(0.085, p, fieldDecimals(0.005, p.scale))).toBe("8.5");
    const d = fieldSpec(deg, -180, 180);
    expect(stepField(94, 1, false, d, -3600, 3600)).toBe(95);
    expect(stepField(94, -1, true, d, -3600, 3600)).toBe(84);
    expect(stepField(0.2, 1, false, p, 0, 0.25)).toBe(0.21);
    // a 0.3-2x scale steps by its own step, not a whole unit
    const x = fieldSpec((v) => `${v.toFixed(2)}×`, 0.3, 2);
    expect(stepField(1, 1, false, x, 0.05, 10, 0.01, 0.3, 2)).toBe(1.01);
  });
});

const seg = (o: Partial<Motion3DSegment> = {}): Motion3DSegment => ({ id: "m", startMs: 1000, endMs: 3000, template: "custom", from: {}, to: {}, easing: "linear", perspective: 2000, ...o });

describe("keyframe ops", () => {
  const s = seg({ keys: [{ at: 0.25, pose: { rx: 10 } }, { at: 0.5, pose: { rx: 20 } }, { at: 0.75, pose: { rx: 30 } }] });

  it("moves an interior key, clamped between its neighbours; Start / End do not move", () => {
    expect(keyAtRange(s, 2)).toEqual([0.26, 0.74]);
    expect(setKeyAt(s, 2, 0.6).keys!.map((k) => k.at)).toEqual([0.25, 0.6, 0.75]);
    expect(setKeyAt(s, 2, 0.9).keys!.map((k) => k.at)).toEqual([0.25, 0.74, 0.75]);
    expect(setKeyAt(s, 1, -1).keys![0]!.at).toBe(0.01);
    expect(setKeyAt(s, 0, 0.5)).toBe(s);
    expect(setKeyAt(s, 4, 0.5)).toBe(s);
  });

  it("reset puts one keyframe back to the flat card", () => {
    const f = seg({ from: { rx: 5 }, to: { ry: 9 }, keys: [{ at: 0.5, pose: { rz: 3 } }] });
    expect(resetKeyPose(f, 0).from).toEqual({});
    expect(resetKeyPose(f, 1).keys![0]).toEqual({ at: 0.5, pose: {} });
    expect(resetKeyPose(f, 2).to).toEqual({});
  });

  it("every built-in template tile shows a pose that is not edge-on, and moved templates are not flat", () => {
    for (const t of MOTION3D_TEMPLATES) {
      const p = templateTilePose(t);
      expect(Math.abs(Math.cos((p.ry * Math.PI) / 180))).toBeGreaterThanOrEqual(0.3);
      expect(Math.abs(Math.cos((p.rx * Math.PI) / 180))).toBeGreaterThanOrEqual(0.3);
      if (t.id !== "custom") expect(Object.entries(p).some(([k, v]) => (k === "scale" ? v !== 1 : v !== 0)), t.id).toBe(true);
    }
  });
});

describe("store: keyframes end to end", () => {
  beforeEach(() => {
    mem.clear();
    store.refreshMotion3dTemplates();
    store.openProject({});
    store.select(null);
  });
  const doc = () => store.get().project;

  it("3 keys with different poses; key time edit; reset keyframe; reset all back to the template", () => {
    store.addMotion3d("tilt-in", 1000);
    expect(store.addMotion3dKey(0, 1250)).toBe(true);
    store.setMotion3dPose(0, { ry: 30 });
    expect(store.addMotion3dKey(0, 1500)).toBe(true);
    store.setMotion3dPose(0, { ry: -30, rz: 8 });
    expect(store.addMotion3dKey(0, 1750)).toBe(true);
    store.setMotion3dPose(0, { tz: -300 });
    const m = doc().motion3d[0]!;
    expect(m.keys!.map((k) => k.at)).toEqual([0.25, 0.5, 0.75]);
    expect(m.keys![1]!.pose).toMatchObject({ ry: -30, rz: 8 });
    // move Key 2 to 60 %
    store.setMotion3dKeyAt(0, 2, 0.6);
    expect(keyAt(doc().motion3d[0]!, 2)).toBe(0.6);
    // reset Key 2
    store.select({ track: "motion3d", index: 0 });
    store.resetMotion3dKey(0, 2);
    expect(doc().motion3d[0]!.keys![1]!.pose).toEqual({});
    store.undo();
    expect(doc().motion3d[0]!.keys![1]!.pose).toMatchObject({ ry: -30 });
    // reset all: the tilt-in template again, same place and length
    store.select({ track: "motion3d", index: 0 });
    store.resetMotion3d(0);
    const r = doc().motion3d[0]!;
    expect(r.keys).toBeUndefined();
    expect(r.from).toEqual({ rx: 25 });
    expect([r.startMs, r.endMs]).toEqual([m.startMs, m.endMs]);
  });

  it("Delete with a keyframe selected removes the keyframe, not the block; Start / End are not deletable", () => {
    store.addMotion3d("tilt-in", 1000);
    store.addMotion3dKey(0, 1500);
    expect(store.get().m3dKey).toBe(1);
    expect(store.deleteSelectedMotion3dKey()).toBe(true);
    expect(doc().motion3d).toHaveLength(1);
    expect(doc().motion3d[0]!.keys).toBeUndefined();
    store.selectMotion3dKey(0);
    expect(store.deleteSelectedMotion3dKey()).toBe(false);
  });

  it("each typed value commits as its own undo step (commitPending closes the slider gesture)", () => {
    store.addMotion3d("custom", 1000);
    store.setMotion3dPose(0, { ry: 3 }, true);
    store.commitPending();
    store.setMotion3dPose(0, { ry: 7 }, true);
    store.commitPending();
    expect(doc().motion3d[0]!.from.ry).toBe(7);
    store.undo();
    expect(doc().motion3d[0]!.from.ry).toBe(3);
  });
});
