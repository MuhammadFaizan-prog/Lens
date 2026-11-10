/**
 * Child processes started by the main process (ffmpeg for finalize / import / export / probes,
 * whisper-cli for speech-to-text, ...). Before an update installs, every one of them must be gone:
 * ffmpeg.exe and whisper-cli.exe live inside the install folder (resources\ffmpeg,
 * resources\lens\assets\models\whisper), the NSIS installer only kills Lens.exe, and a running child
 * keeps its .exe and DLLs locked, so the old uninstaller cannot move the folder away and the silent
 * installer quits without installing or relaunching (fix/updater-014).
 *
 * trackChildProcesses() wraps child_process.spawn once (the bundle reads `spawn` off the module at call
 * time, so every caller is covered) and records live, non-detached children. killChildren() kills them
 * and waits (bounded) for their exit. Detached children (the update installer itself) are never
 * tracked or killed.
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";

type SpawnFn = (...args: unknown[]) => ChildProcess;
type CpModule = { spawn: SpawnFn };

const live = new Set<ChildProcess>();
let installed: CpModule | null = null;

function optionsOf(args: unknown[]): SpawnOptions | undefined {
  // spawn(cmd, options) or spawn(cmd, args, options)
  const a = args[1];
  const o = Array.isArray(a) ? args[2] : a;
  return o && typeof o === "object" ? (o as SpawnOptions) : undefined;
}

/** Record a child until it exits. Exported for callers that create children another way. */
export function trackChild(p: ChildProcess): ChildProcess {
  if (p.exitCode !== null || p.signalCode !== null) return p;
  live.add(p);
  const drop = () => live.delete(p);
  p.once("exit", drop);
  p.once("error", drop);
  return p;
}

export function trackChildProcesses(cp: CpModule = require("node:child_process") as CpModule): void {
  if (installed === cp) return;
  const orig = cp.spawn;
  cp.spawn = function trackedSpawn(this: unknown, ...args: unknown[]): ChildProcess {
    const p = orig.apply(this, args);
    if (!optionsOf(args)?.detached) trackChild(p);
    return p;
  } as SpawnFn;
  installed = cp;
}

export function liveChildren(): ChildProcess[] {
  return [...live].filter((p) => p.exitCode === null && p.signalCode === null);
}

/**
 * Kill every tracked child and wait until each has exited, at most timeoutMs. Resolves with how many
 * were killed and how many were still alive at the deadline. Never throws.
 */
export async function killChildren(timeoutMs = 3000, log: (m: string) => void = () => undefined): Promise<{ killed: number; stillAlive: number }> {
  const kids = liveChildren();
  if (!kids.length) return { killed: 0, stillAlive: 0 };
  log(`killing ${kids.length} child process(es): ${kids.map((k) => `${k.pid ?? "?"} ${k.spawnfile ?? ""}`.trim()).join(", ")}`);
  const exits = kids.map(
    (k) =>
      new Promise<void>((resolve) => {
        if (k.exitCode !== null || k.signalCode !== null) return resolve();
        k.once("exit", () => resolve());
        try {
          // Windows: TerminateProcess (no graceful signal exists); elsewhere SIGKILL
          k.kill("SIGKILL");
        } catch {
          resolve();
        }
      }),
  );
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([Promise.all(exits), new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))]);
  if (timer) clearTimeout(timer);
  const stillAlive = liveChildren().length;
  if (stillAlive) log(`${stillAlive} child process(es) still alive after ${timeoutMs} ms`);
  return { killed: kids.length, stillAlive };
}

/** Tests only. */
export function _resetChildren(): void {
  live.clear();
  installed = null;
}
