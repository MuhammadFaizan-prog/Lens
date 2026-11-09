/**
 * Demo-as-code (lite): `lens run demo.lens.yaml` applies a declarative list of edits to a project
 * and exports, so a release pipeline can re-record the raw session and re-render the same demo.
 *
 *   version: 1
 *   project: ./recording            # relative to this file
 *   steps:
 *     - preset: Clean Product Demo  # or { name: ..., sections: [look, captions] }
 *     - zoom: { start: 1.5s, end: 4s, scale: 2, focus: [640, 360] }
 *     - cut: { start: 0, end: 800ms }
 *     - annotate: { kind: text, text: "Click Save", start: 2s, end: 4s, rect: [900, 520, 300, 0] }
 *     - captions: { enabled: true, style: { fontSize: 40, highlightColor: "#ffd23f" } }
 *     - brand: { primary: "#e8132a", logo: assets/logo.png }
 *     - set: { /cursor/size: 2 }
 *     - export: { format: mp4, out: out/demo.mp4 }
 *
 * Each step runs the same operation as the CLI subcommand of the same name, so a script and the
 * equivalent CLI calls produce the same project.json and the same video.
 */
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { invalid, LensError, usage } from "./errors.js";
import { parsePointer } from "./jsonpointer.js";
import * as ops from "./project.js";
import { Sandbox } from "./sandbox.js";

export const STEP_KINDS = ["preset", "brand", "set", "zoom", "cut", "annotate", "captions", "takes", "privacy", "steps", "transcribe", "translate", "export", "frame"] as const;
type StepKind = (typeof STEP_KINDS)[number];

const obj = (v: unknown, what: string): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw usage(`${what} must be a mapping`);
  return v as Record<string, unknown>;
};

export async function runStep(ctx: ops.Ctx, dir: string, kind: StepKind, arg: unknown): Promise<Record<string, unknown>> {
  switch (kind) {
    case "preset": {
      if (typeof arg === "string") return ops.presetApply(ctx, dir, arg);
      const a = obj(arg, "preset");
      return ops.presetApply(ctx, dir, String(a.name ?? a.file ?? ""), a.sections as string[] | undefined);
    }
    case "brand": {
      const a = { ...obj(arg, "brand") };
      const { name, primary, accent, font, logo, watermark, enabled, ...rest } = a;
      return ops.brandSet(ctx, dir, {
        json: Object.keys(rest).length ? rest : undefined,
        name: name as string | undefined,
        primary: primary as string | undefined,
        accent: accent as string | undefined,
        font: font as string | undefined,
        logo: logo as string | undefined,
        watermark: watermark as boolean | undefined,
        enabled: enabled as boolean | undefined,
      });
    }
    case "set": {
      const a = obj(arg, "set");
      let last: Record<string, unknown> = {};
      const diff: unknown[] = [];
      for (const [ptr, value] of Object.entries(a)) {
        parsePointer(ptr);
        last = ops.set(ctx, dir, ptr, value);
        diff.push(...(last.diff as unknown[]));
      }
      return { ...last, diff, changed: diff.length > 0 };
    }
    case "zoom": {
      const a = obj(arg, "zoom");
      return ops.zoomAdd(ctx, dir, { start: a.start, end: a.end, scale: a.scale as number | undefined, focus: a.focus, id: a.id as string | undefined });
    }
    case "cut": {
      const a = obj(arg, "cut");
      return ops.cutAdd(ctx, dir, { start: a.start, end: a.end });
    }
    case "annotate":
      return ops.annotate(ctx, dir, obj(arg, "annotate"));
    case "captions":
      return ops.captions(ctx, dir, obj(arg, "captions"));
    case "takes": {
      const a = obj(arg, "takes");
      return ops.takesSet(ctx, dir, { enabled: a.enabled as boolean | undefined, strategy: a.strategy as string | undefined, group: a.group === undefined ? undefined : String(a.group), keep: a.keep as number | undefined });
    }
    case "privacy": {
      const a = typeof arg === "string" ? { [arg]: "all" } : obj(arg, "privacy");
      if (a.scan) await ops.privacyScan(ctx, dir);
      for (const st of ["accept", "dismiss"] as const)
        if (a[st] !== undefined) return ops.privacyReview(ctx, dir, st === "accept" ? "accepted" : "dismissed", a[st] === "all" ? null : (a[st] as string[]));
      return ops.projectInfo(ctx, dir).privacy as unknown as Record<string, unknown>;
    }
    case "steps": {
      const a = typeof arg === "string" ? { [arg]: "all" } : obj(arg, "steps");
      if (a.generate) await ops.stepsGenerate(ctx, dir);
      if (a.accept !== undefined) return ops.stepsReview(ctx, dir, "accepted", a.accept === "all" ? null : (a.accept as string[]));
      return { project: dir };
    }
    case "transcribe":
      return ops.transcribe(ctx, dir, arg && typeof arg === "object" ? (arg as { force?: boolean }) : {});
    case "translate": {
      const a = typeof arg === "string" ? { to: arg } : obj(arg, "translate");
      const to = Array.isArray(a.to) ? (a.to as string[]) : String(a.to ?? "").split(",").filter(Boolean);
      return ops.translate(ctx, dir, { to, select: a.select as string | undefined });
    }
    case "export": {
      const a = typeof arg === "string" ? { format: arg } : obj(arg, "export");
      return ops.exportProject(ctx, dir, { format: a.format as string | undefined, out: a.out as string | undefined, language: a.language as string | undefined, crf: a.crf as number | undefined, x264Preset: (a.x264Preset ?? a["x264-preset"]) as string | undefined });
    }
    case "frame": {
      const a = obj(arg, "frame");
      return ops.renderFrame(ctx, dir, { frame: a.frame as number | undefined, atMs: a.at === undefined ? undefined : ops.parseTime(a.at, "at"), out: a.out as string | undefined });
    }
  }
}

export async function runScript(ctx: ops.Ctx, file: string, o: { project?: string } = {}) {
  const scriptPath = ctx.sandbox.resolve(file, { mustExist: true, what: "script" });
  let doc: unknown;
  try {
    doc = parseYaml(fs.readFileSync(scriptPath, "utf8"));
  } catch (e) {
    throw invalid(`script is not valid YAML: ${(e as Error).message}`);
  }
  const d = obj(doc, "script");
  if (d.version !== undefined && d.version !== 1) throw invalid(`unsupported script version ${String(d.version)} (1)`);
  const extra = Object.keys(d).filter((k) => !["version", "project", "steps", "name"].includes(k));
  if (extra.length) throw invalid(`unknown script key(s): ${extra.join(", ")}`);
  if (!Array.isArray(d.steps)) throw invalid("script needs a steps: list");
  // paths inside the script resolve against the script's folder, under the same root
  const sctx: ops.Ctx = { ...ctx, sandbox: new Sandbox(ctx.sandbox.root, path.dirname(scriptPath)) };
  const projArg = o.project ?? (d.project as string | undefined);
  if (!projArg) throw usage("script has no project: (or pass --project)");
  const dir = o.project ? ctx.sandbox.resolve(o.project, { what: "project" }) : sctx.sandbox.resolve(projArg, { what: "project" });
  ops.load(sctx, dir);
  // validate every step's shape before running any of them
  const steps = d.steps.map((s, i) => {
    const m = obj(s, `step ${i + 1}`);
    const keys = Object.keys(m);
    if (keys.length !== 1 || !STEP_KINDS.includes(keys[0] as StepKind)) throw invalid(`step ${i + 1}: needs exactly one of ${STEP_KINDS.join(", ")} (got ${keys.join(", ") || "nothing"})`, { step: i + 1 });
    return { kind: keys[0] as StepKind, arg: m[keys[0]!] };
  });
  const results: Array<Record<string, unknown>> = [];
  for (const [i, s] of steps.entries()) {
    try {
      const r = await runStep(sctx, dir, s.kind, s.arg);
      results.push({ step: i + 1, op: s.kind, changed: r.changed ?? null, ...(r.out ? { out: r.out } : {}), ...(r.diff ? { diff: r.diff } : {}) });
    } catch (e) {
      if (e instanceof LensError) throw new LensError(e.code, `step ${i + 1} (${s.kind}): ${e.message}`, { step: i + 1, ...(e.details && typeof e.details === "object" ? e.details : {}) });
      throw e;
    }
  }
  return { script: scriptPath, project: dir, steps: results.length, changed: results.some((r) => r.changed === true), results };
}
