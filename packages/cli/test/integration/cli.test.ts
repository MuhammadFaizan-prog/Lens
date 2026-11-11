/**
 * lens CLI end to end (built dist/cli.js, real renderer / transcriber / translator / scanner).
 * Every subcommand: a happy path and an error path, the exit code, and the JSON shape (snapshot).
 *
 * Bounds, fixed before the first run:
 *  - exit codes exactly as documented (0 ok, 1 failed, 2 usage, 3 not found, 4 invalid, 5 outside root, 6 conflict)
 *  - idempotent commands: the second identical run reports changed: false and leaves project.json byte-identical
 *  - export mp4: h264, frame count == plan frames, duration within one frame of the plan
 *  - transcribe (espeak-ng speech): >= 4 of the 6 content words read back
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { lens, probe, sample, scratch, shape, smallProject } from "../helpers.js";

let dir: string;
let P: string;
const pj = () => fs.readFileSync(path.join(P, "project.json"), "utf8");

beforeAll(() => {
  dir = scratch("cli");
  P = smallProject(dir);
});

function ok(args: string[]) {
  const r = lens(args);
  if (r.code !== 0) throw new Error(`lens ${args.join(" ")} -> ${r.code}: ${JSON.stringify(r.json)}`);
  expect(r.json.ok).toBe(true);
  return r.json.result;
}
function fails(args: string[], code: number, err: string) {
  const r = lens(args);
  expect(r.code, JSON.stringify(r.json)).toBe(code);
  expect(r.json.ok).toBe(false);
  expect(r.json.error!.code).toBe(err);
  expect(r.json.error!.exit).toBe(code);
  return r.json.error!;
}
function idempotent(args: string[]) {
  const first = ok(args);
  const before = pj();
  const again = ok(args);
  expect(again.changed).toBe(false);
  expect(again.diff).toEqual([]);
  expect(pj()).toBe(before);
  return first;
}

describe("project", () => {
  it("new: copies a bundle, idempotent; conflict and missing inputs fail", () => {
    const d = path.join(dir, "fresh");
    const r = ok(["project", "new", d, "--from", sample()]);
    expect(r.created).toBe(true);
    expect(shape(r)).toMatchSnapshot();
    expect(ok(["project", "new", d, "--from", sample()]).created).toBe(false);
    fs.writeFileSync(path.join(dir, "other-meta.json"), JSON.stringify({ width: 1280, height: 720, fps: 30, durationMs: 9000, pixelRatio: 1 }));
    fails(["project", "new", d, "--from", sample(), "--meta", path.join(dir, "other-meta.json")], 6, "conflict");
    fails(["project", "new", path.join(dir, "x"), "--screen", path.join(sample(), "screen.mp4")], 2, "usage");
    fails(["project", "new", path.join(dir, "y"), "--from", path.join(dir, "no-such-bundle")], 3, "not_found");
  });
  it("open / info", () => {
    expect(shape(ok(["project", "open", P]))).toMatchSnapshot();
    const info = ok(["project", "info", P]);
    expect(info.output).toMatchObject({ width: 640, height: 360, fps: 30, frames: 300 });
    expect(shape(info)).toMatchSnapshot();
    expect(info.freezes).toEqual({ holds: 0, holdMs: 0, pauses: 0, images: 0 });
    ok(["set", "/freezes", JSON.stringify([{ id: "f1", startMs: 1000, endMs: 2500, cursor: "live" }]), "--create", "-C", P]);
    expect(ok(["project", "info", P]).freezes).toEqual({ holds: 1, holdMs: 1500, pauses: 0, images: 0 });
    ok(["set", "/freezes", "[]", "-C", P]);
    fails(["project", "open", dir], 3, "not_found");
    fails(["project", "info", path.join(dir, "nope")], 3, "not_found");
  });
});

describe("get / set", () => {
  it("set validates through the engine and is idempotent", () => {
    const r = idempotent(["set", "/cursor/size", "2", "-C", P]);
    expect(r).toMatchObject({ pointer: "/cursor/size", after: 2 });
    expect(shape(r)).toMatchSnapshot();
    expect(ok(["get", "/cursor/size", "-C", P]).value).toBe(2);
    fails(["set", "/cursor/nonsense", "1", "-C", P], 4, "invalid");
    fails(["set", "/output/fps", "-5", "-C", P], 4, "invalid");
    fails(["set", "cursor/size", "1", "-C", P], 4, "invalid");
    fails(["get", "/no/such", "-C", P], 3, "not_found");
    ok(["set", "/cursor/size", "1.5", "-C", P]);
  });
});

describe("zoom / cut / annotate", () => {
  it("zoom add: idempotent, range checked", () => {
    const r = idempotent(["zoom", "add", "--start", "1s", "--end", "3.5s", "--scale", "2.5", "--focus", "640,360", "-C", P]);
    expect(r.zoom).toMatchObject({ id: "zoom-1000-3500", startMs: 1000, endMs: 3500, scale: 2.5, focus: { x: 640, y: 360 }, auto: false });
    expect(shape(r)).toMatchSnapshot();
    fails(["zoom", "add", "--start", "9s", "--end", "12s", "-C", P], 4, "invalid");
    fails(["zoom", "add", "--start", "1s", "--end", "2s", "--focus", "5000,10", "-C", P], 4, "invalid");
  });
  it("cut add: idempotent, start < end", () => {
    expect(shape(idempotent(["cut", "add", "--start", "8500", "--end", "9000", "-C", P]))).toMatchSnapshot();
    fails(["cut", "add", "--start", "3s", "--end", "2s", "-C", P], 4, "invalid");
  });
  it("annotate add: same item twice is one item", () => {
    const a = '{"kind":"text","text":"Click Save","start":"2s","end":"4s","rect":[880,520,320,0]}';
    const r = idempotent(["annotate", "add", a, "-C", P]);
    expect(r.annotation.kind).toBe("text");
    expect(shape(r)).toMatchSnapshot();
    fails(["annotate", "add", '{"kind":"hologram"}', "-C", P], 2, "usage");
  });
});

describe("plan / frame / export", () => {
  it("plan is deterministic", () => {
    const a = ok(["plan", "-C", P]);
    expect(ok(["plan", "-C", P]).sha256).toBe(a.sha256);
    expect(shape(a)).toMatchSnapshot();
    fails(["plan", "--language", "xx", "-C", P], 3, "not_found");
  });
  it("frame renders a PNG; out-of-range frame fails", () => {
    const r = ok(["frame", "--at", "2s", "-C", P]);
    expect(r.frame).toBe(60);
    expect(fs.readFileSync(r.out).subarray(1, 4).toString()).toBe("PNG");
    expect(shape(r)).toMatchSnapshot();
    fails(["frame", "--frame", "100000", "-C", P], 4, "invalid");
  });
  it("export mp4 matches the plan; srt / vtt; render alias; bad format", () => {
    const pl = ok(["plan", "-C", P]);
    const r = ok(["export", "--x264-preset", "ultrafast", "-C", P]);
    expect(shape(r)).toMatchSnapshot();
    const v = probe(r.out);
    expect(v.codec).toBe("h264");
    expect(v.frames).toBe(pl.output.frames);
    expect(Math.abs(v.durationS * 1000 - pl.output.durationMs)).toBeLessThanOrEqual(1000 / pl.output.fps);
    const srt = ok(["export", "--format", "srt", "-C", P]);
    expect(fs.readFileSync(srt.out, "utf8")).toMatch(/^1\r?\n\d\d:\d\d:\d\d,\d{3} --> /);
    const vtt = ok(["render", "--out", path.join(dir, "subs.vtt"), "-C", P]);
    expect(fs.readFileSync(vtt.out, "utf8").startsWith("WEBVTT")).toBe(true);
    fails(["export", "--format", "mov", "-C", P], 2, "usage");
    fails(["export", "--format", "mp4", "--out", path.join(dir, "x.gif"), "-C", P], 2, "usage");
  });
  it("export gif", () => {
    const r = ok(["export", "--format", "gif", "-C", P]);
    expect(fs.readFileSync(r.out).subarray(0, 6).toString()).toMatch(/^GIF8[79]a$/);
  });
  it("a renderer failure is exit 1 (failed)", () => {
    const d = path.join(dir, "broken");
    ok(["project", "new", d, "--from", sample()]);
    fs.writeFileSync(path.join(d, "screen.mp4"), "not a video");
    fails(["frame", "--frame", "0", "-C", d], 1, "failed");
  });
});

describe("presets / brand", () => {
  it("preset list / apply (idempotent); unknown preset and section fail", () => {
    const l = ok(["preset", "list"]);
    expect(l.presets.length).toBeGreaterThanOrEqual(5);
    expect(shape(l)).toMatchSnapshot();
    const r = idempotent(["preset", "apply", "Dark Dev", "--sections", "look", "-C", P]);
    expect(r.preset).toBe("Dark Dev");
    fails(["preset", "apply", "Vaporwave", "-C", P], 3, "not_found");
    fails(["preset", "apply", "minimal", "--sections", "look,smell", "-C", P], 2, "usage");
  });
  it("brand set colours + logo (copied into the project); bad colour fails", () => {
    const logo = path.join(dir, "logo.png");
    spawnSync("python3", ["-c", "import cv2,numpy as np,sys; a=np.zeros((40,120,4),np.uint8); a[...,1]=200; a[...,3]=255; cv2.imwrite(sys.argv[1],a)", logo]);
    const r = idempotent(["brand", "set", "--primary", "#e8132a", "--logo", logo, "-C", P]);
    expect(r.brand).toMatchObject({ enabled: true, primary: "#e8132a", logo: "brand/logo.png" });
    expect(fs.existsSync(path.join(P, "brand", "logo.png"))).toBe(true);
    expect(shape(r)).toMatchSnapshot();
    fails(["brand", "set", "--primary", "red-ish", "-C", P], 4, "invalid");
    fails(["brand", "set", "--logo", path.join(dir, "missing.png"), "-C", P], 3, "not_found");
  });
});

describe("takes", () => {
  it("list / set (idempotent) / bad strategy / unknown group", () => {
    expect(shape(ok(["takes", "list", "-C", P]))).toMatchSnapshot();
    idempotent(["takes", "set", "--enabled", "true", "--strategy", "best", "-C", P]);
    fails(["takes", "set", "--strategy", "worst", "-C", P], 2, "usage");
    fails(["takes", "set", "--group", "99", "--keep", "0", "-C", P], 3, "not_found");
    ok(["takes", "set", "--enabled", "false", "-C", P]);
  });
});

describe("transcribe / translate", () => {
  it("transcribe espeak speech; skip when present; no audio track fails", () => {
    const d = path.join(dir, "speech");
    const wav = path.join(dir, "speech.wav");
    const e = spawnSync("espeak-ng", ["-v", "en-us", "-s", "150", "-w", wav, "Open the settings and click save."]);
    expect(e.status).toBe(0);
    ok(["project", "new", d, "--screen", path.join(sample(), "screen.mp4"), "--meta", path.join(sample(), "meta.json"), "--events", path.join(sample(), "events.jsonl"), "--mic", wav]);
    const r = ok(["transcribe", "-C", d]);
    expect(r.skipped).toBe(false);
    expect(shape(r)).toMatchSnapshot();
    const text = JSON.parse(fs.readFileSync(r.transcript, "utf8")).words.map((w: { text: string }) => w.text.toLowerCase().replace(/[^a-z]/g, ""));
    const hits = ["open", "the", "settings", "and", "click", "save"].filter((w) => text.includes(w)).length;
    expect(hits).toBeGreaterThanOrEqual(4);
    expect(ok(["transcribe", "-C", d]).skipped).toBe(true);
    ok(["set", "/audio/tracks", "[]", "-C", d]);
    fails(["transcribe", "--force", "-C", d], 3, "not_found");
  });
  it("translate to Spanish and select it; no transcript / bad language fail", () => {
    const r = ok(["translate", "--to", "es", "--select", "es", "--no-download", "-C", P]);
    expect(r.languages).toContain("es");
    expect(r.selected).toBe("es");
    expect(shape(r)).toMatchSnapshot();
    expect(ok(["project", "info", P]).captions.language).toBe("es");
    ok(["set", "/translations/language", "null", "-C", P]);
    fails(["translate", "--to", "spanish", "-C", P], 2, "usage");
    const d = path.join(dir, "notranscript");
    ok(["project", "new", d, "--screen", path.join(sample(), "screen.mp4"), "--meta", path.join(sample(), "meta.json"), "--events", path.join(sample(), "events.jsonl")]);
    fails(["translate", "--to", "es", "-C", d], 3, "not_found");
  });
});

describe("privacy / steps", () => {
  it("privacy scan finds the sample's secrets, accept all, idempotent; unknown id fails", () => {
    const d = smallProject(path.join(dir, "priv"), "privacy");
    fails(["privacy", "accept", "-C", d], 3, "not_found");
    const r = ok(["privacy", "scan", "-C", d]);
    expect(r.detections).toBeGreaterThan(0);
    expect(shape(r)).toMatchSnapshot();
    expect(ok(["privacy", "scan", "-C", d])).toMatchObject({ cached: true, changed: false });
    const a = idempotent(["privacy", "accept", "-C", d]);
    expect(a.counts.pending).toBe(0);
    expect(a.counts.accepted).toBe(r.detections);
    fails(["privacy", "dismiss", "no-such-id", "-C", d], 3, "not_found");
  });
  it("steps generate drafts labels from clicks; accept makes badges; unknown id fails", () => {
    const r = ok(["steps", "generate", "-C", P]);
    expect(r.drafts.length).toBeGreaterThan(0);
    expect(shape(r)).toMatchSnapshot();
    const a = idempotent(["steps", "accept", "-C", P]);
    expect(a.badges).toBe(r.drafts.length);
    fails(["steps", "accept", "zzz", "-C", P], 3, "not_found");
  });
});

describe("export demo / guide (demand #7)", () => {
  it("demo + guide from accepted steps; hotspot editor idempotent; no steps / unknown step fail", () => {
    const empty = smallProject(path.join(dir, "nosteps"));
    fails(["export", "demo", "-C", empty], 3, "not_found");
    fails(["export", "demo", "--crf", "3", "-C", P], 2, "usage");
    const steps = (ok(["get", "/stepLabels/drafts", "-C", P]).value as { state: string }[]).filter((d) => d.state === "accepted").length;
    expect(steps).toBeGreaterThan(0);
    const d = ok(["export", "demo", "-C", P]);
    expect(d.steps.length).toBe(steps);
    const html = fs.readFileSync(path.join(d.out, "index.html"), "utf8");
    expect(html).toContain("default-src 'none'");
    expect((html.match(/data:image\/jpeg;base64,/g) ?? []).length).toBe(steps);
    expect(JSON.parse(fs.readFileSync(path.join(d.out, "demo.json"), "utf8")).steps.length).toBe(steps);
    expect(ok(["export", "--format", "demo", "--out", path.join(dir, "demo2"), "-C", P]).kind).toBe("demo");
    const g = ok(["export", "guide", "-C", P]);
    expect(g.guide.pages).toBe(steps + 1);
    for (const f of g.files as string[]) expect(fs.existsSync(f)).toBe(true);
    expect(fs.readFileSync(path.join(g.out, "guide.pdf")).subarray(0, 5).toString()).toBe("%PDF-");
    const id = d.steps[0].id as string;
    const h = idempotent(["demo", "hotspot", id, "--x", "300", "--y", "200", "--tooltip", "Start here", "-C", P]);
    expect(h.changed).toBe(true);
    expect(ok(["get", "/demo/hotspots", "-C", P]).value).toEqual([{ stepId: id, x: 300, y: 200, tooltip: "Start here" }]);
    const d2 = ok(["export", "demo", "--out", path.join(dir, "demo3"), "-C", P]);
    expect(d2.steps[0].label).toBe("Start here");
    idempotent(["demo", "hotspot", id, "--clear", "-C", P]);
    expect(ok(["get", "/demo/hotspots", "-C", P]).value).toEqual([]);
    fails(["demo", "hotspot", "zzz", "--x", "1", "-C", P], 3, "not_found");
    fails(["demo", "hotspot", id, "-C", P], 2, "usage");
    fails(["set", "/demo/cta/url", "javascript:alert(1)", "-C", P], 4, "invalid");
  });
});

describe("root sandbox (CLI --root)", () => {
  it("refuses projects and outputs outside the root", () => {
    const root = path.dirname(P);
    fails(["project", "open", sample(), "--root", root], 5, "outside_root");
    fails(["export", "--format", "srt", "--out", "../../escape.srt", "-C", P, "--root", root], 5, "outside_root");
    const up = path.join(root, "up");
    fs.symlinkSync(path.dirname(root), up);
    try {
      fails(["frame", "--frame", "0", "--out", "up/escape.png", "-C", P, "--root", root], 5, "outside_root");
    } finally {
      fs.unlinkSync(up); // a link to an ancestor is a loop for any file crawler
    }
    fails(["set", "/audio/tracks/0/path", '"../../../../etc/passwd"', "-C", P, "--root", root], 5, "outside_root");
    expect(fs.existsSync(path.join(dir, "escape.srt"))).toBe(false);
  });
});
