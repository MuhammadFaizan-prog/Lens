/**
 * lens-mcp end to end: spawn the server over stdio with the MCP SDK client, list tools, open a
 * project, add a zoom, see the frame change, export, read resources, and try to escape the root.
 *
 * Bounds, fixed before the first run:
 *  - tools/list returns every tool below, each with an object JSON schema
 *  - render_frame after zoom_add: a different PNG (sha256) with mean |diff| >= 2.0 levels vs before
 *  - export: h264 MP4 with exactly the plan's frame count and duration within one frame of the plan
 *  - every path-escape attempt is an MCP tool error with code outside_root, and nothing is written outside
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MCP, imageDiff, probe, sample, scratch, smallProject } from "../helpers.js";

const EXPECTED_TOOLS = [
  "project_new", "project_open", "project_info", "plan", "export", "render_frame", "transcribe", "translate",
  "takes_list", "takes_set", "privacy_scan", "privacy_review", "steps_generate", "steps_review",
  "preset_list", "preset_apply", "brand_set", "get", "set", "zoom_add", "cut_add", "annotate", "captions", "run_script",
  "export_demo", "export_guide",
];

let base: string;
let root: string;
let P: string;
let client: Client;

type Result = { isError?: boolean; content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; structuredContent?: any };
async function call(name: string, args: Record<string, unknown> = {}): Promise<Result> {
  return (await client.callTool({ name, arguments: args })) as Result;
}
async function ok(name: string, args: Record<string, unknown> = {}) {
  const r = await call(name, args);
  if (r.isError) throw new Error(`${name}: ${r.content[0]?.text}`);
  return r;
}
async function refused(name: string, args: Record<string, unknown>, code = "outside_root") {
  const r = await call(name, args);
  expect(r.isError, `${name} ${JSON.stringify(args)} should fail`).toBe(true);
  expect(r.structuredContent.error.code, JSON.stringify(r.structuredContent)).toBe(code);
}

beforeAll(async () => {
  base = scratch("mcp");
  root = path.join(base, "root");
  fs.mkdirSync(root);
  P = smallProject(root);
  fs.mkdirSync(path.join(base, "outside"));
  fs.writeFileSync(path.join(base, "outside", "evil.lens.yaml"), "project: .\nsteps: []\n");
  client = new Client({ name: "lens-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: "node", args: [MCP, "--root", root], stderr: "pipe" }));
});

afterAll(async () => {
  await client?.close();
});

describe("lens-mcp", () => {
  it("lists every tool with a JSON schema, and no shell tool", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.description?.length).toBeGreaterThan(20);
    }
    expect(names.some((n) => /shell|exec|command|eval/.test(n))).toBe(false);
  });

  it("open -> zoom_add -> render_frame shows the change -> export matches the plan", async () => {
    const open = await ok("project_open", { project: "proj" });
    expect(open.structuredContent.project).toBe(fs.realpathSync(P));
    const info = (await ok("project_info")).structuredContent;
    const frame = Math.round(9.0 * info.output.fps);

    const before = await ok("render_frame", { frame });
    const img = before.content.find((c) => c.type === "image")!;
    expect(img.mimeType).toBe("image/png");
    expect(Buffer.from(img.data!, "base64").subarray(1, 4).toString()).toBe("PNG");
    const beforePng = path.join(base, "before.png");
    fs.copyFileSync(before.structuredContent.out, beforePng);

    const z = await ok("zoom_add", { start: "7.5s", end: "9.8s", scale: 2.5, focus: [640, 360] });
    expect(z.structuredContent.changed).toBe(true);
    expect(z.structuredContent.diff[0].path).toBe("/zoom/segments");

    const after = await ok("render_frame", { frame });
    expect(after.structuredContent.sha256).not.toBe(before.structuredContent.sha256);
    const d = imageDiff(beforePng, after.structuredContent.out);
    console.log(`render_frame ${frame}: mean |diff| after zoom_add = ${d.toFixed(2)}`);
    expect(d).toBeGreaterThanOrEqual(2.0);

    const ex = (await ok("export", { x264Preset: "ultrafast" })).structuredContent;
    const plan = (await ok("plan")).structuredContent;
    const v = probe(ex.out);
    console.log(`export: ${v.frames} frames, ${v.durationS}s; plan ${plan.output.frames} frames, ${plan.output.durationMs} ms`);
    expect(v.codec).toBe("h264");
    expect(v.frames).toBe(plan.output.frames);
    expect(Math.abs(v.durationS * 1000 - plan.output.durationMs)).toBeLessThanOrEqual(1000 / plan.output.fps);
  });

  it("resources: project JSON, transcript, preview PNG, frame template", async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toEqual(expect.arrayContaining(["lens://project/project.json", "lens://project/transcript.json", "lens://project/preview.png", "lens://project/info.json"]));
    const pj = await client.readResource({ uri: "lens://project/project.json" });
    expect(JSON.parse((pj.contents[0] as { text: string }).text).zoom.segments[0].scale).toBe(2.5);
    const tr = await client.readResource({ uri: "lens://project/transcript.json" });
    expect(JSON.parse((tr.contents[0] as { text: string }).text).words.length).toBeGreaterThan(0);
    const pv = await client.readResource({ uri: "lens://project/preview.png" });
    expect(Buffer.from((pv.contents[0] as { blob: string }).blob, "base64").subarray(1, 4).toString()).toBe("PNG");
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates[0]!.uriTemplate).toBe("lens://project/frame/{n}.png");
    const f0 = await client.readResource({ uri: "lens://project/frame/0.png" });
    expect((f0.contents[0] as { mimeType: string }).mimeType).toBe("image/png");
  });

  it("set / get / errors come back as tool errors with codes", async () => {
    const s = await ok("set", { pointer: "/captions/style/fontSize", value: 40 });
    expect(s.structuredContent.after).toBe(40);
    expect((await ok("get", { pointer: "/captions/style/fontSize" })).structuredContent.value).toBe(40);
    await refused("set", { pointer: "/captions/nope", value: 1 }, "invalid");
    await refused("zoom_add", { start: 1, end: 2, shell: "rm -rf /" }, "usage");
    await refused("no_such_tool", {}, "usage");
  });

  it("export_demo / export_guide (demand #7): no accepted steps is not_found; after steps review both export", async () => {
    await ok("steps_review", { state: "dismissed" }).catch(() => undefined);
    await refused("export_demo", {}, "not_found");
    await ok("steps_generate");
    await ok("steps_review", { state: "accepted" });
    const d = (await ok("export_demo")).structuredContent;
    expect(d.kind).toBe("demo");
    expect(d.steps.length).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(d.out, "index.html"), "utf8")).toContain("lens-demo-data");
    const g = (await ok("export_guide", { out: "guide-out" })).structuredContent;
    expect(g.guide.pages).toBe(d.steps.length + 1);
    expect(g.out).toBe(fs.realpathSync(path.join(root, "guide-out")));
    await refused("export_demo", { out: "../demo-escape" });
  });

  it("refuses every path outside the root", async () => {
    fs.symlinkSync(path.join(base, "outside"), path.join(root, "out-link"));
    await refused("project_open", { project: ".." });
    await refused("project_open", { project: sample() });
    await refused("project_new", { dir: "copy", from: sample() });
    await refused("project_new", { dir: "../escaped", from: "proj" });
    await refused("export", { format: "srt", out: "../escape.srt" });
    await refused("export", { format: "srt", out: "/tmp/escape.srt" });
    await refused("render_frame", { frame: 0, out: "out-link/escape.png" });
    await refused("set", { pointer: "/audio/tracks/0/path", value: "../../../../etc/passwd" });
    await refused("set", { pointer: "/brand/logo/path", value: "/etc/passwd" });
    await refused("brand_set", { logo: "/etc/passwd" });
    await refused("preset_apply", { preset: "../outside/x.lenspreset" });
    await refused("run_script", { script: path.join(base, "outside", "evil.lens.yaml") });
    await refused("run_script", { script: "out-link/evil.lens.yaml" });
    await refused("set", { pointer: "/brand/customFonts", value: [{ family: "X", regular: "system:../../etc/passwd", bold: "system:DejaVuSans-Bold.ttf" }] });
    expect(fs.existsSync(path.join(base, "escape.srt"))).toBe(false);
    expect(fs.existsSync(path.join(base, "escaped"))).toBe(false);
    expect(fs.readdirSync(path.join(base, "outside"))).toEqual(["evil.lens.yaml"]);
    // the project is unchanged by the refused calls
    expect((await ok("get", { pointer: "/audio/tracks/0/path" })).structuredContent.value).toBe("mic.wav");
  });
});
