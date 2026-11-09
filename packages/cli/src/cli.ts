#!/usr/bin/env node
/**
 * lens: drive a Lens project from a terminal, a script or an agent. Every subcommand takes --json
 * (one JSON object on stdout: { ok, command, result } or { ok: false, command, error }) and exits
 * with a documented code (errors.ts EXIT). See docs/Automation.md.
 */
import { stringify as toYaml } from "yaml";
import { EXIT, LensError, usage } from "./errors.js";
import { parseValue } from "./jsonpointer.js";
import * as ops from "./project.js";
import { Sandbox } from "./sandbox.js";
import { runScript } from "./script.js";

export const USAGE = `lens <command> [options]            (every command: --json, --project <dir>, --root <dir>)

  project new <dir> (--from <bundle> | --screen f --meta f --events f) [--cam f] [--mic f]
                    [--transcript f] [--project-file f] [--force]
  project open [<dir>]                 check a project and list its files
  project info [<dir>]                 output size, zooms, cuts, captions, languages, privacy, steps
  plan [--out plan.json] [--language es|source]
  export [--format mp4|gif|srt|vtt] [--out file] [--language es] [--crf n] [--x264-preset p]
  render ...                           same as export
  export demo [--out folder]           interactive click-through demo (one self-contained index.html)
  export guide [--out folder]          step guide: guide.md + guide.html + guide.pdf
  demo hotspot <step-id> [--x px --y px] [--tooltip text] [--clear]   hotspot editor
  frame [--frame n | --at 1.5s] [--out frame.png]       one output frame as PNG
  transcribe [--force] [--model m] [--track id]
  translate --to es[,fr,...] [--select es|source] [--no-download]
  takes list | takes set [--enabled true|false] [--strategy last|best] [--group i --keep k]
  privacy scan [--force] | privacy accept [id...] | privacy dismiss [id...]   (no ids = all)
  steps generate [--force] | steps accept [id...] | steps dismiss [id...]
  preset list | preset apply <name|file.lenspreset> [--sections look,captions,...]
  brand set [--primary #hex] [--accent #hex] [--font f] [--name n] [--logo f.png]
            [--watermark true|false] [--json-value '{...}']
  get [<json-pointer>]
  set <json-pointer> <value> [--create]   value is JSON when it parses, else a string
  zoom add --start t --end t [--scale s] [--focus x,y|follow] [--id id]
  cut add --start t --end t
  annotate add '<json>'                e.g. '{"kind":"text","text":"Hi","start":"1s","end":"3s","rect":[100,80,400,0]}'
  run <script.lens.yaml> [--project dir]

Times: ms, "1.5s", "800ms" or "m:ss". --root (or $LENS_ROOT) refuses every path outside it.
Exit codes: 0 ok, 1 failed, 2 usage, 3 not found, 4 invalid, 5 outside root, 6 conflict.`;

const BOOL = new Set(["json", "force", "create", "no-download", "help", "progress", "clear"]);

export interface Parsed {
  pos: string[];
  flags: Record<string, string | true>;
}

export function parseArgs(argv: string[]): Parsed {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-h") flags.help = true;
    else if (a === "-C") flags.project = argv[++i] ?? "";
    else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) flags[name] = a.slice(eq + 1);
      else if (BOOL.has(name)) flags[name] = true;
      else {
        const v = argv[i + 1];
        if (v === undefined) throw usage(`--${name} needs a value`);
        flags[name] = v;
        i++;
      }
    } else pos.push(a);
  }
  return { pos, flags };
}

const str = (f: Parsed["flags"], k: string): string | undefined => (typeof f[k] === "string" ? (f[k] as string) : undefined);
function num(f: Parsed["flags"], k: string): number | undefined {
  const v = str(f, k);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw usage(`--${k} must be a number`);
  return n;
}
function bool(f: Parsed["flags"], k: string): boolean | undefined {
  const v = str(f, k);
  if (v === undefined) return f[k] === true ? true : undefined;
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  throw usage(`--${k} must be true or false`);
}
const list = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

const KNOWN: Record<string, string[]> = {
  "project new": ["from", "screen", "meta", "events", "cam", "mic", "transcript", "project-file", "force"],
  plan: ["out", "language"],
  export: ["format", "out", "language", "crf", "x264-preset"],
  "export demo": ["out"],
  "export guide": ["out"],
  "demo hotspot": ["x", "y", "tooltip", "clear"],
  frame: ["frame", "at", "out", "language"],
  transcribe: ["force", "model", "track"],
  translate: ["to", "select", "no-download"],
  "takes set": ["enabled", "strategy", "group", "keep"],
  "privacy scan": ["force"],
  "steps generate": ["force"],
  "preset apply": ["sections"],
  "brand set": ["primary", "accent", "font", "name", "logo", "watermark", "json-value", "enabled"],
  set: ["create"],
  "zoom add": ["start", "end", "scale", "focus", "id"],
  "cut add": ["start", "end"],
};
const GLOBAL = ["json", "project", "root", "help", "progress"];

function checkFlags(cmd: string, flags: Parsed["flags"]) {
  const ok = new Set([...GLOBAL, ...(KNOWN[cmd] ?? [])]);
  const bad = Object.keys(flags).filter((k) => !ok.has(k));
  if (bad.length) throw usage(`unknown option${bad.length > 1 ? "s" : ""} for ${cmd}: ${bad.map((b) => "--" + b).join(", ")}`);
}

/** Run one command; returns [commandName, result]. Throws LensError. */
export async function dispatch(p: Parsed, ctx: ops.Ctx): Promise<[string, unknown]> {
  const [c0, c1, ...rest] = p.pos;
  const f = p.flags;
  const dir = str(f, "project");
  const sub = (name: string, allowed: string[]) => {
    if (!c1 || !allowed.includes(c1)) throw usage(`${name} needs a subcommand: ${allowed.join(", ")}`);
    return c1;
  };
  switch (c0) {
    case "project": {
      const s = sub("project", ["new", "open", "info"]);
      checkFlags(`project ${s}`, f);
      if (rest.length > 1) throw usage(`project ${s} takes one folder`);
      const d = rest[0] ?? dir;
      if (s === "new")
        return ["project new", ops.projectNew(ctx, d ?? "", { from: str(f, "from"), screen: str(f, "screen"), meta: str(f, "meta"), events: str(f, "events"), cam: str(f, "cam"), mic: str(f, "mic"), transcript: str(f, "transcript"), project: str(f, "project-file"), force: f.force === true })];
      return [`project ${s}`, s === "open" ? ops.projectOpen(ctx, d) : ops.projectInfo(ctx, d)];
    }
    case "plan":
      checkFlags("plan", f);
      if (c1) throw usage("plan takes no arguments");
      return ["plan", ops.plan(ctx, dir, { out: str(f, "out"), language: str(f, "language") })];
    case "export":
    case "render":
      if (c1 === "demo" || c1 === "guide" || str(f, "format") === "demo" || str(f, "format") === "guide") {
        const kind = c1 ?? str(f, "format")!;
        const { format: _fmt, ...rest2 } = f;
        if (c1 && _fmt !== undefined && _fmt !== c1) throw usage(`export ${c1} does not take --format ${String(_fmt)}`);
        checkFlags(`export ${kind}`, rest2);
        if (rest.length) throw usage(`export ${kind} takes no further arguments`);
        return [`export ${kind}`, await ops.exportSteps(ctx, dir, { kind, out: str(f, "out") })];
      }
      checkFlags("export", f);
      if (c1) throw usage(`${c0} takes no arguments (use --format / --out)`);
      return [c0, await ops.exportProject(ctx, dir, { format: str(f, "format"), out: str(f, "out"), language: str(f, "language"), crf: num(f, "crf"), x264Preset: str(f, "x264-preset") })];
    case "frame":
      checkFlags("frame", f);
      if (c1) throw usage("frame takes no arguments (use --frame / --at)");
      return ["frame", await ops.renderFrame(ctx, dir, { frame: num(f, "frame"), atMs: str(f, "at") !== undefined ? ops.parseTime(str(f, "at"), "--at") : undefined, out: str(f, "out"), language: str(f, "language") })];
    case "transcribe":
      checkFlags("transcribe", f);
      return ["transcribe", await ops.transcribe(ctx, dir, { force: f.force === true, model: str(f, "model"), track: str(f, "track") })];
    case "translate": {
      checkFlags("translate", f);
      const to = list(str(f, "to"));
      if (!to) throw usage("translate needs --to <lang[,lang]>");
      return ["translate", await ops.translate(ctx, dir, { to, select: str(f, "select"), noDownload: f["no-download"] === true })];
    }
    case "takes": {
      const s = sub("takes", ["list", "set"]);
      checkFlags(`takes ${s}`, f);
      if (s === "list") return ["takes list", ops.takesList(ctx, dir)];
      const keep = num(f, "keep");
      return ["takes set", ops.takesSet(ctx, dir, { enabled: bool(f, "enabled"), strategy: str(f, "strategy"), group: str(f, "group"), keep })];
    }
    case "privacy": {
      const s = sub("privacy", ["scan", "accept", "dismiss"]);
      checkFlags(`privacy ${s}`, f);
      if (s === "scan") return ["privacy scan", await ops.privacyScan(ctx, dir, { force: f.force === true })];
      return [`privacy ${s}`, ops.privacyReview(ctx, dir, s === "accept" ? "accepted" : "dismissed", rest.length ? rest : null)];
    }
    case "steps": {
      const s = sub("steps", ["generate", "accept", "dismiss"]);
      checkFlags(`steps ${s}`, f);
      if (s === "generate") return ["steps generate", await ops.stepsGenerate(ctx, dir, { force: f.force === true })];
      return [`steps ${s}`, ops.stepsReview(ctx, dir, s === "accept" ? "accepted" : "dismissed", rest.length ? rest : null)];
    }
    case "preset": {
      const s = sub("preset", ["list", "apply"]);
      checkFlags(`preset ${s}`, f);
      if (s === "list") return ["preset list", ops.presetList()];
      if (rest.length !== 1) throw usage("preset apply needs one preset name or file");
      return ["preset apply", ops.presetApply(ctx, dir, rest[0]!, list(str(f, "sections")))];
    }
    case "brand": {
      sub("brand", ["set"]);
      checkFlags("brand set", f);
      const jv = str(f, "json-value");
      let json: Record<string, unknown> | undefined;
      if (jv !== undefined) {
        const v = parseValue(jv);
        if (!v || typeof v !== "object" || Array.isArray(v)) throw usage("--json-value must be a JSON object");
        json = v as Record<string, unknown>;
      }
      const opts = { json, name: str(f, "name"), primary: str(f, "primary"), accent: str(f, "accent"), font: str(f, "font"), logo: str(f, "logo"), watermark: bool(f, "watermark"), enabled: bool(f, "enabled") };
      if (Object.values(opts).every((v) => v === undefined)) throw usage("brand set needs at least one of --primary --accent --font --name --logo --watermark --json-value");
      return ["brand set", ops.brandSet(ctx, dir, opts)];
    }
    case "demo": {
      sub("demo", ["hotspot"]);
      checkFlags("demo hotspot", f);
      if (rest.length !== 1) throw usage("demo hotspot needs one step id");
      return ["demo hotspot", ops.demoHotspot(ctx, dir, { step: rest[0]!, x: num(f, "x"), y: num(f, "y"), tooltip: str(f, "tooltip"), clear: f.clear === true })];
    }
    case "get":
      checkFlags("get", f);
      if (rest.length) throw usage("get takes one pointer");
      return ["get", ops.get(ctx, dir, c1 ?? "")];
    case "set":
      checkFlags("set", f);
      if (!c1 || rest.length !== 1) throw usage("set needs <json-pointer> <value>");
      return ["set", ops.set(ctx, dir, c1, parseValue(rest[0]!), { create: f.create === true })];
    case "zoom":
      sub("zoom", ["add"]);
      checkFlags("zoom add", f);
      if (f.start === undefined || f.end === undefined) throw usage("zoom add needs --start and --end");
      return ["zoom add", ops.zoomAdd(ctx, dir, { start: str(f, "start"), end: str(f, "end"), scale: num(f, "scale"), focus: str(f, "focus"), id: str(f, "id") })];
    case "cut":
      sub("cut", ["add"]);
      checkFlags("cut add", f);
      if (f.start === undefined || f.end === undefined) throw usage("cut add needs --start and --end");
      return ["cut add", ops.cutAdd(ctx, dir, { start: str(f, "start"), end: str(f, "end") })];
    case "annotate": {
      sub("annotate", ["add"]);
      checkFlags("annotate add", f);
      if (rest.length !== 1) throw usage("annotate add needs one JSON object");
      const v = parseValue(rest[0]!);
      if (!v || typeof v !== "object" || Array.isArray(v)) throw usage("annotate add needs a JSON object");
      return ["annotate add", ops.annotate(ctx, dir, v as Record<string, unknown>)];
    }
    case "run":
      checkFlags("run", f);
      if (!c1 || rest.length) throw usage("run needs one script file");
      return ["run", await runScript(ctx, c1, { project: dir })];
    case undefined:
      throw usage("no command (lens --help)");
    default:
      throw usage(`unknown command ${c0} (lens --help)`);
  }
}

const GROUPS = ["project", "takes", "privacy", "steps", "preset", "brand", "zoom", "cut", "annotate", "demo"];
function commandName(argv: string[]): string {
  try {
    const { pos } = parseArgs(argv);
    if ((pos[0] === "export" || pos[0] === "render") && (pos[1] === "demo" || pos[1] === "guide")) return `${pos[0]} ${pos[1]}`;
    return GROUPS.includes(pos[0] ?? "") && pos[1] ? `${pos[0]} ${pos[1]}` : pos[0] ?? "";
  } catch {
    return "";
  }
}

export async function main(argv: string[], out = process.stdout, err = process.stderr): Promise<number> {
  let p: Parsed;
  let json = argv.includes("--json");
  try {
    p = parseArgs(argv);
    json = p.flags.json === true;
    if (p.flags.help || !p.pos.length) {
      if (json) out.write(JSON.stringify({ ok: true, command: "help", result: { usage: USAGE } }) + "\n");
      else out.write(USAGE + "\n");
      return p.flags.help ? EXIT.OK : EXIT.USAGE;
    }
    const sandbox = new Sandbox(str(p.flags, "root") ?? process.env.LENS_ROOT ?? null);
    const ctx: ops.Ctx = { sandbox, progress: p.flags.progress ? (l) => err.write(l + "\n") : undefined };
    const [command, result] = await dispatch(p, ctx);
    out.write(json ? JSON.stringify({ ok: true, command, result }) + "\n" : toYaml(result));
    return EXIT.OK;
  } catch (e) {
    const le = e instanceof LensError ? e : new LensError("failed", e instanceof Error ? e.message : String(e));
    if (json) out.write(JSON.stringify({ ok: false, command: commandName(argv), error: le.toJSON() }) + "\n");
    else err.write(`lens: ${le.message}\n`);
    return le.exit;
  }
}

// run when executed directly (not when imported by tests or the MCP server)
import { fileURLToPath } from "node:url";
import fs from "node:fs";
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // exitCode, not process.exit(): exit() drops whatever is still queued for a piped stdout (a privacy
  // scan's --json result is > 64 KB and was cut off mid-line when read through a pipe)
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
