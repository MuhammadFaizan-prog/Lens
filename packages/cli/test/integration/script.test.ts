/**
 * Demo-as-code: `lens run script.lens.yaml` must produce the same result as the same edits made with
 * individual CLI commands.
 *
 * Bounds, fixed before the first run:
 *  - project.json byte-identical, render plan sha256 identical
 *  - exported MP4s: same frame count, every frame's luma SSIM >= 0.999 (identical frames reported)
 *  - a second `lens run` of the same script reports no project change (idempotent)
 *  - a bad step stops the run with exit 4 before any step runs, naming the step
 */
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { lens, py, sample, scratch } from "../helpers.js";

const SCRIPT = `# release demo, re-rendered by CI
version: 1
name: release demo
project: ./proj-yaml
steps:
  - preset: { name: Clean Product Demo, sections: [look] }
  - zoom: { start: 1.2s, end: 3.8s, scale: 2.2, focus: [400, 300] }
  - cut: { start: 8.6s, end: 9.2s }
  - annotate: { id: save-label, kind: text, text: "Click Save", start: 5.5s, end: 7.5s, rect: [880, 520, 320, 0] }
  - captions: { enabled: true, style: { fontSize: 40, highlightColor: "#22d3ee", position: top } }
  - brand: { primary: "#1c7ed6" }
  - set: { /cursor/size: 2, /output/resolution: 360 }
  - export: { format: mp4, out: out/yaml.mp4, x264Preset: ultrafast }
`;

const CLI_STEPS = (p: string, out: string): string[][] => [
  ["preset", "apply", "Clean Product Demo", "--sections", "look", "-C", p],
  ["zoom", "add", "--start", "1.2s", "--end", "3.8s", "--scale", "2.2", "--focus", "400,300", "-C", p],
  ["cut", "add", "--start", "8.6s", "--end", "9.2s", "-C", p],
  ["annotate", "add", '{"id":"save-label","kind":"text","text":"Click Save","start":"5.5s","end":"7.5s","rect":[880,520,320,0]}', "-C", p],
  ["set", "/captions/enabled", "true", "-C", p],
  ["set", "/captions/style/fontSize", "40", "-C", p],
  ["set", "/captions/style/highlightColor", "#22d3ee", "-C", p],
  ["set", "/captions/style/position", "top", "-C", p],
  ["brand", "set", "--primary", "#1c7ed6", "-C", p],
  ["set", "/cursor/size", "2", "-C", p],
  ["set", "/output/resolution", "360", "-C", p],
  ["export", "--out", out, "--x264-preset", "ultrafast", "-C", p],
];

const SSIM = `
import cv2, sys, hashlib, numpy as np
def frames(p):
    cap = cv2.VideoCapture(p)
    while True:
        ok, f = cap.read()
        if not ok: break
        yield cv2.cvtColor(f, cv2.COLOR_BGR2GRAY).astype(np.float64)
def ssim(a, b):
    C1, C2 = (0.01*255)**2, (0.03*255)**2
    g = lambda x: cv2.GaussianBlur(x, (11, 11), 1.5)
    ma, mb = g(a), g(b)
    va, vb, cov = g(a*a) - ma*ma, g(b*b) - mb*mb, g(a*b) - ma*mb
    return float((((2*ma*mb + C1)*(2*cov + C2)) / ((ma*ma + mb*mb + C1)*(va + vb + C2))).mean())
fa, fb = list(frames(sys.argv[1])), list(frames(sys.argv[2]))
s = [ssim(a, b) for a, b in zip(fa, fb)]
same = sum(1 for a, b in zip(fa, fb) if hashlib.md5(a.tobytes()).digest() == hashlib.md5(b.tobytes()).digest())
print(len(fa), len(fb), min(s), sum(s)/len(s), same)
`;

let dir: string;
beforeAll(() => {
  dir = scratch("script");
  for (const name of ["proj-yaml", "proj-cli"]) {
    const r = lens(["project", "new", path.join(dir, name), "--from", sample()]);
    expect(r.code).toBe(0);
  }
  fs.writeFileSync(path.join(dir, "demo.lens.yaml"), SCRIPT);
});

describe("lens run (demo-as-code)", () => {
  it("script == the same edits through the CLI", () => {
    const run = lens(["run", path.join(dir, "demo.lens.yaml")]);
    expect(run.code, JSON.stringify(run.json)).toBe(0);
    expect(run.json.result.steps).toBe(8);
    const yamlOut = path.join(dir, "out", "yaml.mp4");
    expect(run.json.result.results.at(-1).out).toBe(fs.realpathSync(yamlOut));

    const cliOut = path.join(dir, "out", "cli.mp4");
    for (const args of CLI_STEPS(path.join(dir, "proj-cli"), cliOut)) {
      const r = lens(args);
      expect(r.code, `${args.join(" ")}: ${JSON.stringify(r.json)}`).toBe(0);
    }

    const pa = fs.readFileSync(path.join(dir, "proj-yaml", "project.json"), "utf8");
    const pb = fs.readFileSync(path.join(dir, "proj-cli", "project.json"), "utf8");
    expect(pa).toBe(pb);
    const planA = lens(["plan", "-C", path.join(dir, "proj-yaml")]).json.result;
    const planB = lens(["plan", "-C", path.join(dir, "proj-cli")]).json.result;
    expect(planA.sha256).toBe(planB.sha256);

    const [na, nb, minS, meanS, same] = py(SSIM, [yamlOut, cliOut]).split(" ").map(Number);
    console.log(`yaml vs cli: ${na} / ${nb} frames, luma SSIM min ${minS!.toFixed(6)} mean ${meanS!.toFixed(6)}, identical frames ${same}/${na}`);
    expect(na).toBe(planA.output.frames);
    expect(nb).toBe(na);
    expect(minS).toBeGreaterThanOrEqual(0.999);
  });

  it("running the script again changes nothing", () => {
    const before = fs.readFileSync(path.join(dir, "proj-yaml", "project.json"), "utf8");
    const again = lens(["run", path.join(dir, "demo.lens.yaml")]);
    expect(again.code).toBe(0);
    expect(again.json.result.changed).toBe(false);
    expect(fs.readFileSync(path.join(dir, "proj-yaml", "project.json"), "utf8")).toBe(before);
  });

  it("a bad step fails before anything runs, naming the step", () => {
    const bad = path.join(dir, "bad.lens.yaml");
    fs.writeFileSync(bad, "project: ./proj-yaml\nsteps:\n  - zoom: { start: 1s, end: 2s }\n  - teleport: { to: mars }\n");
    const before = fs.readFileSync(path.join(dir, "proj-yaml", "project.json"), "utf8");
    const r = lens(["run", bad]);
    expect(r.code).toBe(4);
    expect(r.json.error!.message).toMatch(/step 2/);
    expect(fs.readFileSync(path.join(dir, "proj-yaml", "project.json"), "utf8")).toBe(before);
    fs.writeFileSync(bad, "project: ./proj-yaml\nsteps:\n  - cut: { start: 5s, end: 4s }\n");
    const r2 = lens(["run", bad]);
    expect(r2.code).toBe(4);
    expect(r2.json.error!.message).toMatch(/step 1 \(cut\)/);
    fs.writeFileSync(bad, "project: ./proj-yaml\nsteps: [ {zoom: {start: 1s, end: 2s}\n");
    expect(lens(["run", bad]).code).toBe(4);
    expect(lens(["run", path.join(dir, "missing.lens.yaml")]).code).toBe(3);
  });

  it("script paths stay inside --root", () => {
    fs.writeFileSync(path.join(dir, "escape.lens.yaml"), "project: ./proj-yaml\nsteps:\n  - export: { format: srt, out: ../../escape.srt }\n");
    const r = lens(["run", path.join(dir, "escape.lens.yaml"), "--root", dir]);
    expect(r.code).toBe(5);
    expect(fs.existsSync(path.resolve(dir, "../../escape.srt"))).toBe(false);
  });
});
