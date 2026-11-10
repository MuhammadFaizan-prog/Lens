/**
 * children.ts (fix/updater-014): every child the main process spawns is tracked and can be killed and
 * awaited before the update installer runs; detached children (the installer) are left alone.
 * Uses real processes (sleep) through a copy of the child_process module object.
 */
import * as cp from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { _resetChildren, killChildren, liveChildren, trackChildProcesses } from "../src/main/children";

afterEach(() => _resetChildren());

describe("child process registry", () => {
  it("tracks spawned children, kills and awaits them; detached ones are not tracked", async () => {
    const mod = { spawn: cp.spawn } as { spawn: (...a: unknown[]) => cp.ChildProcess };
    trackChildProcesses(mod);
    trackChildProcesses(mod); // idempotent
    const a = mod.spawn("sleep", ["30"]);
    const b = mod.spawn("sleep", ["30"], { stdio: "ignore" });
    const det = mod.spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    expect(liveChildren().map((p) => p.pid).sort()).toEqual([a.pid, b.pid].sort());
    const logs: string[] = [];
    const r = await killChildren(3000, (m) => logs.push(m));
    expect(r).toEqual({ killed: 2, stillAlive: 0 });
    expect(a.signalCode ?? a.exitCode).not.toBeNull();
    expect(b.signalCode ?? b.exitCode).not.toBeNull();
    expect(liveChildren()).toEqual([]);
    expect(det.exitCode).toBeNull();
    expect(logs[0]).toContain("killing 2 child process(es)");
    det.kill("SIGKILL");
  });

  it("finished children drop out on their own; nothing to kill resolves at once", async () => {
    const mod = { spawn: cp.spawn } as { spawn: (...a: unknown[]) => cp.ChildProcess };
    trackChildProcesses(mod);
    const p = mod.spawn("true", []);
    await new Promise((r) => p.once("exit", r));
    expect(liveChildren()).toEqual([]);
    expect(await killChildren(10)).toEqual({ killed: 0, stillAlive: 0 });
  });

  it("a spawn that fails (ENOENT) is not left in the registry", async () => {
    const mod = { spawn: cp.spawn } as { spawn: (...a: unknown[]) => cp.ChildProcess };
    trackChildProcesses(mod);
    const p = mod.spawn("/nonexistent/ffmpeg.exe", []);
    await new Promise((r) => p.once("error", r));
    expect(liveChildren()).toEqual([]);
  });
});
