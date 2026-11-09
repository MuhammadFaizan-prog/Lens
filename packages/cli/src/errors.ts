/**
 * Exit codes and the one error type every lens command throws. The CLI maps `exit` to the process
 * exit code; the MCP server returns `{ code, message }` as a tool error.
 */
export const EXIT = {
  /** success (including "nothing to do": the command is idempotent) */
  OK: 0,
  /** a step ran and failed (renderer, transcriber, translator, scanner) */
  FAILED: 1,
  /** bad command line: unknown subcommand, missing or malformed argument */
  USAGE: 2,
  /** the project, a file, a field or a prerequisite (e.g. transcript) does not exist */
  NOT_FOUND: 3,
  /** the value is not valid for the project (engine validation, pointer, range) */
  INVALID: 4,
  /** a path resolves outside the allowed root */
  OUTSIDE_ROOT: 5,
  /** the target exists with different content and --force was not given */
  CONFLICT: 6,
} as const;

export type ErrorCode = "failed" | "usage" | "not_found" | "invalid" | "outside_root" | "conflict";

const EXIT_OF: Record<ErrorCode, number> = {
  failed: EXIT.FAILED,
  usage: EXIT.USAGE,
  not_found: EXIT.NOT_FOUND,
  invalid: EXIT.INVALID,
  outside_root: EXIT.OUTSIDE_ROOT,
  conflict: EXIT.CONFLICT,
};

export class LensError extends Error {
  readonly exit: number;
  constructor(readonly code: ErrorCode, message: string, readonly details?: unknown) {
    super(message);
    this.exit = EXIT_OF[code];
  }
  toJSON(): { code: ErrorCode; message: string; exit: number; details?: unknown } {
    return { code: this.code, message: this.message, exit: this.exit, ...(this.details !== undefined ? { details: this.details } : {}) };
  }
}

export const usage = (m: string) => new LensError("usage", m);
export const notFound = (m: string) => new LensError("not_found", m);
export const invalid = (m: string, details?: unknown) => new LensError("invalid", m, details);
