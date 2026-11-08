import { describe, expect, it } from "vitest";
import { buildRenderPlan, resolveProject } from "@lens/engine";
import { audioSchedule } from "../src/media/audio";

const META = { width: 1280, height: 720, fps: 30, durationMs: 6000, pixelRatio: 1 };
const plan = (edits: object, offsetMs = 0) =>
  buildRenderPlan({
    meta: META,
    events: [],
    project: resolveProject({ output: { fps: 30, resolution: 360 }, edits, audio: { tracks: [{ id: "mic", kind: "mic", path: "mic.wav", offsetMs, volume: 1, muted: false }] } }),
  });

describe("preview audio schedule", () => {
  it("plays straight through without edits", () => {
    const s = audioSchedule(plan({}), 0, 1, 6000);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ whenS: 0, offsetS: 0, durationS: 6, playbackRate: 1 });
  });

  it("skips cuts: the piece after the cut starts when the output reaches it", () => {
    const s = audioSchedule(plan({ cuts: [{ startMs: 1000, endMs: 2000 }] }), 0, 1, 6000);
    expect(s.map((x) => [x.whenS, x.offsetS, x.durationS])).toEqual([[0, 0, 1], [1, 2, 4]]);
  });

  it("plays speed ranges faster and starts mid-piece from the playhead", () => {
    const p = plan({ speed: [{ startMs: 2000, endMs: 4000, rate: 2 }] });
    const s = audioSchedule(p, 30, 1, 6000); // output 1 s
    expect(s[0]).toMatchObject({ whenS: 0, offsetS: 1, durationS: 1, playbackRate: 1 });
    expect(s[1]).toMatchObject({ whenS: 1, offsetS: 2, durationS: 2, playbackRate: 2 });
    expect(s[2]!.whenS).toBeCloseTo(2, 6); // 2 s of source at 2x = 1 s of output
    // 2x transport doubles every rate and halves every wait
    const fast = audioSchedule(p, 30, 2, 6000);
    expect(fast[1]).toMatchObject({ whenS: 0.5, playbackRate: 4 });
  });

  it("honours the track offset and the file length, and is silent in reverse", () => {
    const s = audioSchedule(plan({}, 500), 0, 1, 3000);
    expect(s[0]).toMatchObject({ offsetS: 0, durationS: 3 });
    expect(s[0]!.whenS).toBeCloseTo(0.5, 6); // the file starts 500 ms into the recording
    expect(audioSchedule(plan({}), 0, -1, 6000)).toEqual([]);
  });
});
