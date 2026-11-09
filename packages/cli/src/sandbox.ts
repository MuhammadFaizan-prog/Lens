/**
 * Path policy. With a root (always for lens-mcp, `--root` / $LENS_ROOT for the CLI) every path a
 * command reads or writes must resolve, after following symlinks, inside that root. Relative paths
 * resolve against the root (MCP) or the working directory (CLI).
 */
import fs from "node:fs";
import path from "node:path";
import { LensError, usage } from "./errors.js";

/** realpath of the deepest existing ancestor, with the rest of the path appended. */
export function realish(abs: string): string {
  let cur = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

export function isInside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export class Sandbox {
  /** Real path of the allowed root, or null = unrestricted (CLI default). */
  readonly root: string | null;
  /** Where relative paths start. */
  readonly base: string;

  constructor(root?: string | null, base?: string) {
    if (root) {
      const abs = path.resolve(root);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new LensError("not_found", `root ${root} is not a directory`);
      this.root = fs.realpathSync(abs);
    } else this.root = null;
    this.base = base ? path.resolve(base) : this.root ?? process.cwd();
  }

  /** Resolve a user-given path; throws outside_root / not_found. */
  resolve(p: unknown, opts: { mustExist?: boolean; what?: string; base?: string } = {}): string {
    const what = opts.what ?? "path";
    if (typeof p !== "string" || p.length === 0) throw usage(`${what} must be a non-empty string`);
    if (p.includes("\0")) throw new LensError("outside_root", `${what} contains a NUL byte`);
    const abs = path.resolve(opts.base ?? this.base, p);
    const real = realish(abs);
    if (this.root && !isInside(this.root, real)) throw new LensError("outside_root", `${what} ${p} is outside the allowed root`);
    if (opts.mustExist && !fs.existsSync(real)) throw new LensError("not_found", `${what} ${p} does not exist`);
    return real;
  }

  /** A path stored in project.json (relative to the project folder): must stay inside the root. */
  checkStored(projectDir: string, p: string, what: string): string {
    return this.resolve(p, { base: projectDir, what });
  }
}
