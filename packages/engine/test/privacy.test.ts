import { describe, expect, it } from "vitest";
import {
  applyPrivacyScan,
  buildRenderPlan,
  keyedRect,
  masksAt,
  privacyCounts,
  privacyMasks,
  ProjectValidationError,
  resolveProject,
  reviewPrivacy,
  setPrivacyMaskKind,
  type MaskKey,
  type PrivacyDetection,
} from "../src/index.js";
import { META, move } from "./fixtures.js";

const r = (x: number, y: number, w = 100, h = 20) => ({ x, y, w, h });

// a box scrolling up 10 px per source frame at 30 fps, then still
const KEYS: MaskKey[] = [
  { tMs: 0, rect: r(100, 500) },
  { tMs: 33.33, rect: r(100, 490) },
  { tMs: 66.67, rect: r(100, 480) },
  { tMs: 100, rect: r(100, 470) },
  { tMs: 2000, rect: r(100, 470) },
];

function det(id: string, over: Partial<PrivacyDetection> = {}): PrivacyDetection {
  return {
    id,
    type: "api_key",
    preview: "sk-•••abcd",
    confidence: 1,
    state: "pending",
    thumb: null,
    firstMs: 0,
    tracks: [{ startMs: 0, endMs: 2000, keys: KEYS }],
    ...over,
  };
}

describe("tracked masks (privacy redaction)", () => {
  it("keyedRect: exact key, union of the keys around t, end keys hold", () => {
    expect(keyedRect(KEYS, 33.33)).toEqual(r(100, 490));
    expect(keyedRect(KEYS, 33.6)).toEqual(r(100, 490)); // within 0.5 ms of a key
    // half way between two frames: covers both positions
    expect(keyedRect(KEYS, 50)).toEqual({ x: 100, y: 480, w: 100, h: 30 });
    expect(keyedRect(KEYS, -10)).toEqual(r(100, 500));
    expect(keyedRect(KEYS, 5000)).toEqual(r(100, 470));
    // inside a still run (only its first and last key are kept) the rect is the run's rect
    expect(keyedRect(KEYS, 1000)).toEqual(r(100, 470));
  });

  it("masksAt follows the keys and ignores the static rect", () => {
    const m = [{ id: "a", kind: "blur" as const, rect: r(0, 0, 5, 5), keys: KEYS, startMs: 0, endMs: 2000, feather: 2, fadeMs: 0 }];
    expect(masksAt(m, 66.67)[0]!.rect).toEqual([100, 480, 100, 20]);
    expect(masksAt(m, 1500)[0]!.rect).toEqual([100, 470, 100, 20]);
    expect(masksAt(m, 2000)).toEqual([]);
  });

  it("the plan maps keyed masks through the crop, frame by frame", () => {
    const project = resolveProject({
      output: { fps: 30 },
      zoom: { auto: false },
      crop: { x: 50, y: 100, w: 1600, h: 900 },
      masks: [{ id: "k", kind: "pixelate", rect: r(100, 500), keys: KEYS, startMs: 0, endMs: 2000, feather: 0, fadeMs: 0 }],
    });
    const plan = buildRenderPlan({ meta: { ...META, durationMs: 3000 }, events: move([10, 10], [20, 20], 0, 100), project });
    expect(plan.frames[0]!.masks[0]!.rect).toEqual([50, 400, 100, 20]);
    expect(plan.frames[1]!.masks[0]!.rect).toEqual([50, 390, 100, 20]);
    expect(plan.frames[3]!.masks[0]!.rect).toEqual([50, 370, 100, 20]);
    expect(plan.frames[30]!.masks[0]!.rect).toEqual([50, 370, 100, 20]);
    expect(plan.frames[61]!.masks).toEqual([]);
  });

  it("validation rejects unsorted or bad keys and bad privacy data", () => {
    const bad = (masks: unknown) => () => resolveProject({ masks } as never);
    expect(bad([{ id: "u", kind: "blur", rect: r(0, 0), startMs: 0, endMs: 10, feather: 0, fadeMs: 0, keys: [KEYS[2], KEYS[0]] }])).toThrow(/sorted/);
    expect(bad([{ id: "u", kind: "blur", rect: r(0, 0), startMs: 0, endMs: 10, feather: 0, fadeMs: 0, keys: [{ tMs: 0, rect: r(0, 0, 0, 5) }] }])).toThrow(/rect invalid/);
    expect(bad([{ id: "u", kind: "blur", rect: r(0, 0), startMs: 0, endMs: 10, feather: 0, fadeMs: 0, keys: [] }])).toThrow(ProjectValidationError);
    expect(() => resolveProject({ privacy: { detections: [det("a", { type: "ssn" as never })] } } as never)).toThrow(/unknown type/);
    expect(() => resolveProject({ privacy: { detections: [det("a"), det("a")] } } as never)).toThrow(/twice/);
    expect(() => resolveProject({ privacy: { maskKind: "spotlight" } } as never)).toThrow(/maskKind/);
    expect(() => resolveProject({ privacy: { detections: [det("a", { tracks: [] })] } } as never)).toThrow(/no tracks/);
    expect(resolveProject({ privacy: { detections: [det("a")] } } as never).privacy.detections).toHaveLength(1);
  });
});

describe("privacy review", () => {
  const base = resolveProject({
    masks: [{ id: "manual", kind: "spotlight", rect: r(0, 0), startMs: 500, endMs: 900, feather: 0, fadeMs: 0 }],
    privacy: { detections: [det("pd1"), det("pd2", { type: "email", preview: "j•••@x.com", tracks: [{ startMs: 100, endMs: 400, keys: KEYS }, { startMs: 3000, endMs: 4000, keys: KEYS }] })] },
  } as never);

  it("accepting adds one tracked mask per track, no fade, tagged with the detection", () => {
    const p = reviewPrivacy(base, ["pd2"], "accepted");
    const pm = p.masks.filter((m) => m.privacyId === "pd2");
    expect(pm).toHaveLength(2);
    expect(pm.map((m) => [m.startMs, m.endMs])).toEqual([[100, 400], [3000, 4000]]);
    expect(pm[0]!.fadeMs).toBe(0);
    expect(pm[0]!.kind).toBe("blur");
    expect(pm[0]!.keys).toEqual(KEYS);
    expect(p.masks.find((m) => m.id === "manual")).toBeTruthy(); // manual masks untouched
    expect(p.masks.map((m) => m.startMs)).toEqual([...p.masks.map((m) => m.startMs)].sort((a, b) => a - b));
    expect(privacyCounts(p)).toEqual({ total: 2, pending: 1, accepted: 1, dismissed: 0 });
    // the result is a valid project
    expect(() => resolveProject(p)).not.toThrow();
  });

  it("dismissing removes the masks again; accept all / dismiss all", () => {
    const acc = reviewPrivacy(base, null, "accepted");
    expect(acc.masks.filter((m) => m.privacyId)).toHaveLength(3);
    const dis = reviewPrivacy(acc, ["pd1"], "dismissed");
    expect(dis.masks.filter((m) => m.privacyId === "pd1")).toHaveLength(0);
    expect(dis.masks.filter((m) => m.privacyId === "pd2")).toHaveLength(2);
    const none = reviewPrivacy(acc, null, "pending");
    expect(none.masks).toEqual(base.masks);
    expect(privacyCounts(none).pending).toBe(2);
    // accepting twice does not duplicate masks
    expect(reviewPrivacy(acc, ["pd1"], "accepted").masks).toHaveLength(acc.masks.length);
  });

  it("mask kind change rebuilds accepted masks only", () => {
    const acc = reviewPrivacy(base, ["pd1"], "accepted");
    const px = setPrivacyMaskKind(acc, "pixelate", 20);
    const m = px.masks.find((q) => q.privacyId === "pd1")!;
    expect(m.kind).toBe("pixelate");
    expect(m.strength).toBe(20);
    expect(px.masks.find((q) => q.id === "manual")!.kind).toBe("spotlight");
  });

  it("a re-scan keeps the review of items it finds again and drops masks of items that are gone", () => {
    const acc = reviewPrivacy(reviewPrivacy(base, ["pd1"], "accepted"), ["pd2"], "dismissed");
    const scan = { detections: [det("pd1", { tracks: [{ startMs: 0, endMs: 2500, keys: KEYS }] }), det("pd9", { type: "ip", preview: "10.4.•.•" })] };
    const p = applyPrivacyScan(acc, scan, "2026-11-09T00:00:00Z");
    expect(p.privacy.detections.map((d) => [d.id, d.state])).toEqual([["pd1", "accepted"], ["pd9", "pending"]]);
    expect(p.masks.filter((m) => m.privacyId).map((m) => [m.privacyId, m.endMs])).toEqual([["pd1", 2500]]);
    expect(p.privacy.scannedAt).toBe("2026-11-09T00:00:00Z");
  });

  it("privacyMasks skips empty tracks and honours a strength", () => {
    const d = det("x", { tracks: [{ startMs: 0, endMs: 10, keys: [] }, { startMs: 0, endMs: 10, keys: KEYS }] });
    const ms = privacyMasks(d, { maskKind: "pixelate", strength: 9 });
    expect(ms).toHaveLength(1);
    expect(ms[0]!.strength).toBe(9);
  });
});
