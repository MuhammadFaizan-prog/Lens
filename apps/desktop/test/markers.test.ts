/**
 * Demand #19: hotkey zoom markers. The recorder's marker log (markers.jsonl) -> zoom blocks in the new
 * project. Bounds (set before the first run): every block starts at its marker's time within 1 frame
 * at 60 fps (16.7 ms), is aimed at the logged cursor within 0.01 px, and a recording without markers
 * gets exactly the project.json it got before (no zoom key, no markers.jsonl).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const cursor = { x: 100, y: 100 };
vi.mock("electron", () => ({
  screen: {
    getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }],
    getCursorScreenPoint: () => ({ ...cursor }),
    getDisplayNearestPoint: () => ({ id: 1 }),
    dipToScreenRect: (_w: unknown, r: unknown) => r,
  },
}));

import { formatMarker, markerZoomSegments, parseMarkerLog, MARKER_HOLD_MS } from "../../../packages/engine/src/markers";
import { defaultProject } from "../../../packages/engine/src/project";
import { DEFAULT_ZOOM_SCALE, markerSegmentsOf, Recording } from "../src/main/recording";

const FRAME_60 = 1000 / 60;
const META = { width: 1920, height: 1080, durationMs: 20000 };

describe("marker log", () => {
  it("round-trips and skips a line cut off by a crash", () => {
    const text = ["# lens-markers v1", formatMarker({ t: 1234.56, kind: "zoom", x: 10.123, y: 20.987 }), formatMarker({ t: 5000, kind: "zoom" }), '{"t":7000,"kind":"zo'].join("\n");
    expect(parseMarkerLog(text)).toEqual([
      { t: 1234.6, kind: "zoom", x: 10.12, y: 20.99 },
      { t: 5000, kind: "zoom" },
    ]);
  });
  it("ignores other kinds, negative and non-numeric times, and sorts", () => {
    expect(parseMarkerLog('{"t":3,"kind":"zoom"}\n{"t":-1,"kind":"zoom"}\n{"t":"x"}\n{"t":1,"kind":"other"}\n{"t":2}').map((m) => m.t)).toEqual([2, 3]);
  });
});

describe("markers -> zoom blocks", () => {
  it("one manual block per marker, starting at the marker, aimed at the cursor", () => {
    const segs = markerZoomSegments([{ t: 2000, kind: "zoom", x: 400, y: 300 }, { t: 9000, kind: "zoom", x: 1500, y: 800 }], META, { scale: 2 });
    expect(segs).toHaveLength(2);
    for (const [i, t] of [2000, 9000].entries()) {
      expect(Math.abs(segs[i]!.startMs - t)).toBeLessThanOrEqual(FRAME_60);
      expect(segs[i]!.endMs).toBe(t + MARKER_HOLD_MS);
      expect(segs[i]!.auto).toBe(false);
      expect(segs[i]!.scale).toBe(2);
    }
    expect(segs[0]!.focus).toEqual({ x: 400, y: 300 });
    expect(segs[1]!.focus).toEqual({ x: 1500, y: 800 });
  });
  it("a close second marker ends the first block (pan, no overlap); a double tap is one marker", () => {
    const segs = markerZoomSegments([{ t: 1000, kind: "zoom" }, { t: 1200, kind: "zoom" }, { t: 2500, kind: "zoom" }], META, { scale: 2 });
    expect(segs.map((s) => [s.startMs, s.endMs])).toEqual([[1000, 2500], [2500, 5500]]);
    expect(segs[0]!.focus).toBe("follow");
  });
  it("clamps to the recording and the frame", () => {
    const segs = markerZoomSegments([{ t: 19000, kind: "zoom", x: -50, y: 5000 }, { t: 19900, kind: "zoom" }, { t: 25000, kind: "zoom" }], META, { scale: 2 });
    expect(segs.map((s) => [s.startMs, s.endMs])).toEqual([[19000, 19900]]);
    expect(segs[0]!.focus).toEqual({ x: 0, y: 1080 });
  });
  it("uses the project's default zoom", () => {
    expect(DEFAULT_ZOOM_SCALE).toBe(defaultProject().zoom.defaultScale);
  });
});

describe("Recording.marker (the hotkey's handler)", () => {
  it("logs the press on the video clock at the cursor; finalize turns the log into blocks", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-markers-"));
    const rec = new Recording(root, null, null);
    expect(rec.marker()).toBeNull(); // not started yet
    const videoStart = performance.timeOrigin + performance.now();
    rec.start({ sourceId: "screen:1:0", sourceName: "Screen", kind: "screen", displayId: "1", capture: { width: 1920, height: 1080 }, fps: 30, videoMime: "video/webm", videoStart, mic: null }, { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 });
    await new Promise((r) => setTimeout(r, 120));
    cursor.x = 640;
    cursor.y = 360;
    await new Promise((r) => setTimeout(r, 60));
    const before = performance.timeOrigin + performance.now() - videoStart;
    const t = rec.marker()!;
    const after = performance.timeOrigin + performance.now() - videoStart;
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
    expect(rec.markerCount).toBe(1);
    rec.stopInput();
    expect(rec.marker()).toBeNull(); // stopped
    const logged = parseMarkerLog(fs.readFileSync(path.join(rec.dir, "markers.jsonl"), "utf8"));
    expect(logged).toHaveLength(1);
    expect(Math.abs(logged[0]!.t - t)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(logged[0]!.x! - 640)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(logged[0]!.y! - 360)).toBeLessThanOrEqual(0.01);
    const segs = markerSegmentsOf(rec.dir, { width: 1920, height: 1080, durationMs: 10000 });
    expect(segs).toHaveLength(1);
    expect(Math.abs(segs[0]!.startMs - t)).toBeLessThanOrEqual(FRAME_60);
  });
  it("a recording without markers has no marker file and no blocks", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lens-markers-"));
    const rec = new Recording(root, null, null);
    rec.start({ sourceId: "screen:1:0", sourceName: "Screen", kind: "screen", displayId: "1", capture: { width: 1920, height: 1080 }, fps: 30, videoMime: "video/webm", videoStart: performance.timeOrigin + performance.now(), mic: null }, null);
    rec.stopInput();
    expect(fs.existsSync(path.join(rec.dir, "markers.jsonl"))).toBe(false);
    expect(markerSegmentsOf(rec.dir, META)).toEqual([]);
  });
});
