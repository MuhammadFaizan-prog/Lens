import { describe, expect, it } from "vitest";
import { buildRenderPlan, defaultProject, edlTimecode, nleClips, nleZooms, toEdl, toFcpxml, type ProjectConfig } from "../src/index.js";
import { META, demoSession } from "./fixtures.js";

/**
 * NLE hand-off (demand #11). Bounds set before the first run: every clip's record in / out and source in
 * within 1 output frame of the plan's edit pieces; record ranges tile the output with gaps only at
 * slides; a project without editPieces builds the same plan as before (no `pieces` key).
 */
function plan(edit: (p: ProjectConfig) => void = () => undefined, editPieces = true) {
  const project = defaultProject();
  project.output.fps = 30;
  project.edits.cuts = [{ startMs: 2000, endMs: 3000 }, { startMs: 6000, endMs: 6500 }];
  project.zoom.auto = false;
  project.zoom.segments = [{ id: "z1", startMs: 1000, endMs: 2500, scale: 2, focus: { x: 400, y: 300 }, style: "smooth", auto: false }];
  edit(project);
  return buildRenderPlan({ meta: META, events: demoSession(), project, editPieces });
}

describe("nle export", () => {
  it("plans without editPieces are unchanged", () => {
    const a = plan(() => undefined, false);
    expect("pieces" in a).toBe(false);
    const b = plan();
    expect(JSON.stringify({ ...b, pieces: undefined })).toBe(JSON.stringify({ ...a, pieces: undefined }));
  });

  it("clips match the plan's cut points within one frame", () => {
    const p = plan();
    const clips = nleClips(p);
    expect(clips).toHaveLength(3);
    const fms = 1000 / 30;
    for (const [c, piece] of clips.map((c, i) => [c, p.pieces![i]!] as const)) {
      expect(Math.abs(c.recIn * fms - piece.outStart)).toBeLessThanOrEqual(fms);
      expect(Math.abs(c.recOut * fms - piece.outEnd)).toBeLessThanOrEqual(fms);
      expect(Math.abs(c.srcIn * fms - piece.srcStart)).toBeLessThanOrEqual(fms);
    }
    // cuts: 0-2000 | 3000-6000 | 6500-12000 -> output 0-2000, 2000-5000, 5000-10500
    expect(clips.map((c) => [c.srcIn, c.recIn, c.recOut])).toEqual([[0, 0, 60], [90, 60, 150], [195, 150, 315]]);
    expect(clips[clips.length - 1]!.recOut).toBe(p.frames.length);
  });

  it("zooms are cut to kept ranges", () => {
    const z = nleZooms(plan());
    expect(z.map((x) => [x.clip, x.recIn, x.recOut, x.scale])).toEqual([[0, 30, 60, 2]]);
  });

  it("FCPXML and EDL carry the same cuts", () => {
    const p = plan();
    const x = toFcpxml(p, { name: "Demo", screenSrc: "file:///tmp/screen.mp4", overlaySrc: "file:///tmp/overlay.mov" });
    const offs = [...x.matchAll(/<asset-clip name="screen \d+" ref="r3" offset="([^"]+)" start="([^"]+)" duration="([^"]+)"/g)].map((m) => m.slice(1));
    expect(offs).toEqual([["0s", "0s", "6000/3000s"], ["6000/3000s", "9000/3000s", "9000/3000s"], ["15000/3000s", "19500/3000s", "16500/3000s"]]);
    expect(x).toContain('lane="1"');
    expect(x).toContain('value="Zoom 2.00x at 400,300"');
    const e = toEdl(p, { title: "Demo", clipName: "screen.mp4" });
    const ev = e.split("\n").filter((l) => /^\d{3} /.test(l));
    expect(ev).toHaveLength(3);
    expect(ev[1]).toContain(`${edlTimecode(90, 30)} ${edlTimecode(180, 30)} ${edlTimecode(60, 30)} ${edlTimecode(150, 30)}`);
    expect(e).toContain("* LOC: 00:00:01:00 YELLOW");
  });

  it("slides are gaps; speed ranges get a time map and M2", () => {
    const p = plan((q) => {
      q.edits.speed = [{ startMs: 7000, endMs: 9000, rate: 2 }];
      q.slides = [{ id: "s1", atMs: 4000, durationMs: 1000, title: "Hi", subtitle: "", background: "#000000", textColor: "#ffffff", accent: null, fadeMs: 200, titleSize: 84, subtitleSize: 40 } as never];
    });
    const x = toFcpxml(p, { name: "Demo", screenSrc: "screen.mp4" });
    expect(x).toContain('<gap name="Slide"');
    expect(x).toContain("<timeMap>");
    const e = toEdl(p, { title: "Demo", clipName: "screen.mp4" });
    expect(e).toMatch(/^M2 +SCREEN +060\.0 +00:00:07:00$/m);
    // record ranges tile the output except the slide
    const clips = nleClips(p);
    const covered = clips.reduce((s, c) => s + c.recOut - c.recIn, 0);
    expect(p.frames.length - covered).toBe(30);
  });
});
