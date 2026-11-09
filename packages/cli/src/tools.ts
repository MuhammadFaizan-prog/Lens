/**
 * The on-device tools lens drives (renderer, transcriber, translator, scanner). Each is a fixed
 * script inside the Lens checkout, started with an argument array (never a shell), so no command
 * line from a user or an agent is ever interpreted.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LensError } from "./errors.js";

/** The Lens checkout: packages/cli/dist -> ../../.. ($LENS_HOME overrides). */
export const LENS_HOME = process.env.LENS_HOME ? path.resolve(process.env.LENS_HOME) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PYTHON = process.env.LENS_PYTHON || "python3";

export const TOOLS = {
  render: ["compositor/render.py"],
  frame: ["compositor/frame.py"],
  transcribe: ["transcribe/lens-transcribe"],
  translate: ["translate/lens-translate"],
  redact: ["redact/lens-redact"],
  steps: ["redact/lens-redact", "steps"],
} as const;
export type ToolName = keyof typeof TOOLS;

export interface ToolRun {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

export type Progress = (line: string) => void;

export function runTool(tool: ToolName, args: string[], opts: { onStderr?: Progress; cwd?: string } = {}): Promise<ToolRun> {
  const [script, ...pre] = TOOLS[tool];
  const scriptPath = path.join(LENS_HOME, script);
  if (!fs.existsSync(scriptPath)) throw new LensError("not_found", `Lens tool missing: ${scriptPath}`);
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [scriptPath, ...pre, ...args], { cwd: opts.cwd ?? LENS_HOME, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      if (opts.onStderr) for (const line of s.split("\n")) if (line.trim()) opts.onStderr(line);
    });
    child.on("error", (e) => reject(new LensError("failed", `${tool}: ${e.message}`)));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr, ms: Date.now() - t0 }));
  });
}

export async function mustRun(tool: ToolName, args: string[], opts: { onStderr?: Progress } = {}): Promise<ToolRun> {
  const r = await runTool(tool, args, opts);
  if (r.code !== 0) {
    const tail = r.stderr.split("\n").filter((l) => l.trim() && !/^progress /.test(l)).slice(-6).join("\n");
    throw new LensError("failed", `${tool} exited ${r.code}${tail ? `: ${tail}` : ""}`);
  }
  return r;
}
