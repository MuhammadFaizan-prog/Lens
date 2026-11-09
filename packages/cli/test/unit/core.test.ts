/**
 * Unit tests (no renderer, no Python): JSON pointers, diff, argument parsing, time parsing, the
 * sandbox's path policy, MCP argument validation and tool schemas, CLI usage errors and exit codes.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { diffJson, getAt, parsePointer, parseValue, setAt } from "../../src/jsonpointer.js";
import { EXIT, LensError } from "../../src/errors.js";
import { Sandbox } from "../../src/sandbox.js";
import { parseArgs, main, USAGE } from "../../src/cli.js";
import { parseTime } from "../../src/project.js";
import { TOOLS, validateArgs } from "../../src/mcp.js";
import { scratch } from "../helpers.js";

class Sink {
  text = "";
  write(s: string) {
    this.text += s;
    return true;
  }
}
async function run(argv: string[]) {
  const out = new Sink();
  const err = new Sink();
  const code = await main(argv, out as never, err as never);
  return { code, out: out.text, err: err.text };
}

describe("json pointer", () => {
  const doc = { a: { "b/c": 1, "d~e": [10, 20] } };
  it("parses escapes and reads", () => {
    expect(parsePointer("/a/b~1c")).toEqual(["a", "b/c"]);
    expect(getAt(doc, parsePointer("/a/d~0e/1"))).toEqual({ found: true, value: 20 });
    expect(getAt(doc, parsePointer("/a/x")).found).toBe(false);
    expect(getAt(doc, parsePointer("/a/d~0e/2")).found).toBe(false);
  });
  it("sets without mutating, appends with -, refuses unknown keys unless create", () => {
    const n = setAt(doc, ["a", "d~e", "-"], 30);
    expect(n.a["d~e"]).toEqual([10, 20, 30]);
    expect(doc.a["d~e"]).toEqual([10, 20]);
    expect(() => setAt(doc, ["a", "nope"], 1)).toThrow(/unknown field/);
    expect((setAt(doc, ["a", "nope"], 1, true) as never as { a: { nope: number } }).a.nope).toBe(1);
    expect(() => setAt(doc, ["a", "d~e", "7"], 1)).toThrow(/out of range/);
    expect(() => setAt(doc, ["x", "y"], 1)).toThrow(/no object/);
    expect(() => parsePointer("a/b")).toThrow(LensError);
  });
  it("diffs objects and arrays", () => {
    expect(diffJson({ a: 1, b: [1, 2] }, { a: 2, b: [1, 3], c: true })).toEqual([
      { op: "replace", path: "/a", value: 2, old: 1 },
      { op: "replace", path: "/b/1", value: 3, old: 2 },
      { op: "add", path: "/c", value: true },
    ]);
    expect(diffJson({ x: [1] }, { x: [1, 2] })).toEqual([{ op: "replace", path: "/x", value: [1, 2], old: [1] }]);
    expect(diffJson({ a: 1 }, { a: 1 })).toEqual([]);
  });
  it("CLI values are JSON when they parse", () => {
    expect(parseValue("2")).toBe(2);
    expect(parseValue("true")).toBe(true);
    expect(parseValue('{"a":1}')).toEqual({ a: 1 });
    expect(parseValue("#ff0000")).toBe("#ff0000");
    expect(parseValue("follow")).toBe("follow");
  });
});

describe("arguments and times", () => {
  it("parses flags, booleans, = values, -C and --", () => {
    expect(parseArgs(["set", "/a", "1", "--json", "-C", "p", "--create"])).toEqual({ pos: ["set", "/a", "1"], flags: { json: true, project: "p", create: true } });
    expect(parseArgs(["export", "--out=x.mp4", "--crf", "20"]).flags).toEqual({ out: "x.mp4", crf: "20" });
    expect(parseArgs(["set", "/x", "--", "-5"]).pos).toEqual(["set", "/x", "-5"]);
    expect(() => parseArgs(["export", "--out"])).toThrow(/needs a value/);
  });
  it("times", () => {
    expect(parseTime(1500)).toBe(1500);
    expect(parseTime("1.5s")).toBe(1500);
    expect(parseTime("800ms")).toBe(800);
    expect(parseTime("1:02.5")).toBe(62500);
    expect(parseTime("250")).toBe(250);
    expect(() => parseTime("soon")).toThrow(LensError);
  });
});

describe("sandbox", () => {
  const base = scratch("sandbox");
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  fs.mkdirSync(path.join(root, "p"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.txt"), "x");
  fs.symlinkSync(outside, path.join(root, "link"));
  const sb = new Sandbox(root);

  it("resolves relative paths against the root and allows new files inside", () => {
    expect(sb.resolve("p")).toBe(fs.realpathSync(path.join(root, "p")));
    expect(sb.resolve("p/new/out.mp4")).toBe(path.join(fs.realpathSync(root), "p/new/out.mp4"));
  });
  it.each([
    ["..", "parent"],
    ["../outside/secret.txt", "dot-dot"],
    ["p/../../outside", "dot-dot inside"],
    ["link/secret.txt", "symlink out"],
    ["link/new.mp4", "new file behind a symlink"],
    ["/etc/passwd", "absolute"],
  ])("refuses %s (%s)", (p) => {
    try {
      sb.resolve(p);
      throw new Error("resolved");
    } catch (e) {
      expect(e).toBeInstanceOf(LensError);
      expect((e as LensError).code).toBe("outside_root");
      expect((e as LensError).exit).toBe(EXIT.OUTSIDE_ROOT);
    }
  });
  it("refuses NUL bytes and empty paths", () => {
    expect(() => sb.resolve("p\0x")).toThrow(/NUL/);
    expect(() => sb.resolve("")).toThrow(/non-empty/);
  });
  it("unrestricted without a root", () => {
    expect(new Sandbox(null).resolve(path.join(outside, "secret.txt"), { mustExist: true })).toContain("secret.txt");
  });
});

describe("MCP tool schemas", () => {
  it("every tool has a unique name, a description and an object schema with no unknown keys", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of TOOLS) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.additionalProperties).toBe(false);
      for (const r of t.inputSchema.required ?? []) expect(t.inputSchema.properties).toHaveProperty(r);
    }
  });
  it("validates arguments", () => {
    const zoom = TOOLS.find((t) => t.name === "zoom_add")!.inputSchema;
    expect(() => validateArgs(zoom, { start: "1s", end: 3000, scale: 2 })).not.toThrow();
    expect(() => validateArgs(zoom, { start: "1s" })).toThrow(/end is required/);
    expect(() => validateArgs(zoom, { start: true, end: 1 })).toThrow(/number \(ms\) or a time string/);
    expect(() => validateArgs(zoom, { start: 1, end: 2, shell: "rm -rf /" })).toThrow(/not a known argument/);
    expect(() => validateArgs(zoom, { start: 1, end: 2, scale: 0.5 })).toThrow(/>= 1/);
    const exp = TOOLS.find((t) => t.name === "export")!.inputSchema;
    expect(() => validateArgs(exp, { format: "mov" })).toThrow(/one of/);
    expect(() => validateArgs(exp, { crf: 1.5 })).toThrow(/integer/);
  });
});

describe("CLI usage errors (in process)", () => {
  it("--help exits 0 and prints the usage", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("lens <command>");
    expect(USAGE).toContain("Exit codes");
  });
  it.each([
    [[], EXIT.USAGE],
    [["frobnicate", "--json"], EXIT.USAGE],
    [["project", "--json"], EXIT.USAGE],
    [["project", "open", "a", "b", "--json"], EXIT.USAGE],
    [["plan", "--bogus", "1", "--json"], EXIT.USAGE],
    [["set", "/a", "--json"], EXIT.USAGE],
    [["zoom", "add", "--start", "1", "--json"], EXIT.USAGE],
    [["translate", "--json"], EXIT.USAGE],
    [["brand", "set", "--json"], EXIT.USAGE],
  ])("%j exits %i with a JSON error", async (argv, code) => {
    const r = await run(argv as string[]);
    expect(r.code).toBe(code);
    if ((argv as string[]).includes("--json")) {
      const j = JSON.parse(r.out);
      expect(j.ok).toBe(false);
      expect(j.error.exit).toBe(code);
      expect(typeof j.error.message).toBe("string");
    }
  });
});
