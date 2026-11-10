/**
 * Restart to update (fix/updater-014; Windows on 0.1.3: the app closed, the installer never ran, Lens
 * never reopened). The install flow of updater.ts with a mocked electron-updater, plus the real
 * electron-updater 6.6.2 NsisUpdater spawning a stand-in installer script, so the arguments the NSIS
 * installer receives are the ones checked. Running the real NSIS installer is Windows-only and not
 * covered here.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: true, exit: vi.fn(), getVersion: () => "0.1.3" } }));

import { INSTALLER_ARGS, UpdateController, allowUnsignedUpdates, releasePage, type InstallHooks, type UpdateState, type UpdaterEnv } from "../src/main/updater";
import { cancelQuit, hideToTrayOnClose } from "../src/main/quitPolicy";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lens-updater-"));
const installer = path.join(tmp, "Lens-Setup-0.1.4.exe");
fs.writeFileSync(installer, "stub");

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  allowDowngrade = true;
  allowPrerelease = true;
  forceDevUpdateConfig = false;
  logger: unknown = null;
  quitAndInstallCalled = false;
  verifyUpdateCodeSignature: unknown = "default-powershell-verifier";
  quitAndInstall = vi.fn((_silent: boolean, _forceRun: boolean) => {
    this.quitAndInstallCalled = true;
  });
  setFeedURL = vi.fn();
  checkForUpdates = vi.fn(async () => null);
  downloadUpdate = vi.fn(async () => []);
}

type Events = string[];

function setup(over: Partial<UpdaterEnv> = {}, hookOver: Partial<InstallHooks> = {}) {
  const events: Events = [];
  const logs: string[] = [];
  const states: UpdateState[] = [];
  const fake = new FakeUpdater();
  fake.quitAndInstall.mockImplementation((s: boolean, f: boolean) => {
    events.push(`quitAndInstall(${s},${f})`);
    fake.quitAndInstallCalled = true;
  });
  const exit = vi.fn((code: number) => void events.push(`exit(${code})`));
  const spawned: Array<{ file: string; args: string[]; opts: Record<string, unknown> }> = [];
  const spawn = vi.fn((file: string, args: string[], opts: Record<string, unknown>) => {
    spawned.push({ file, args, opts });
    events.push("spawn");
    const p = new EventEmitter() as EventEmitter & { pid?: number; unref(): void };
    p.pid = 4242;
    p.unref = () => undefined;
    return p;
  });
  const env: Partial<UpdaterEnv> = {
    platform: "win32",
    isPackaged: () => true,
    exit,
    load: () => ({ autoUpdater: fake, NsisUpdater: FakeUpdater }) as never,
    spawn: spawn as never,
    exists: (f) => fs.existsSync(f),
    log: (level, m) => void logs.push(`${level} ${m}`),
    watchdogMs: 60_000,
    ...over,
  };
  const c = new UpdateController((s) => states.push(s), env);
  const hooks: InstallHooks = {
    prepare: vi.fn(async () => void events.push("prepare")),
    restore: vi.fn(() => void events.push("restore")),
    showInstallError: vi.fn((m: string) => void events.push(`dialog:${m}`)),
    ...hookOver,
  };
  c.hooks = hooks;
  return { c, fake, events, logs, states, exit, spawn, spawned, hooks };
}

function downloaded(c: UpdateController, fake: FakeUpdater, file = installer) {
  c.attach(fake as never);
  c.state = { status: "downloaded", version: "0.1.4", file, sha512: "x" };
}

beforeEach(() => {
  vi.useRealTimers();
  delete process.env.LENS_UPDATE_NO_INSTALL;
  delete process.env.LENS_NO_UPDATE;
  delete process.env.LENS_UPDATE_NSIS;
  delete process.env.LENS_UPDATE_URL;
  process.env.LENS_UPDATE_FIRST_CHECK_MS = "999999999";
});

describe("init", () => {
  it("configures electron-updater, replaces the signature check for the unsigned build, logs events", async () => {
    const { c, fake, logs, states } = setup();
    c.init();
    c.dispose();
    expect(fake.autoDownload).toBe(false);
    expect(fake.autoInstallOnAppQuit).toBe(true);
    expect(fake.allowDowngrade).toBe(false);
    expect(typeof fake.verifyUpdateCodeSignature).toBe("function");
    expect(await (fake.verifyUpdateCodeSignature as (p: string[], f: string) => Promise<string | null>)(["Someone"], installer)).toBeNull();
    fake.emit("update-available", { version: "0.1.4", path: "Lens-Setup-0.1.4.exe" });
    fake.emit("download-progress", { percent: 55, transferred: 55, total: 100 });
    fake.emit("update-downloaded", { version: "0.1.4", downloadedFile: installer, sha512: "abc" });
    fake.emit("error", new Error("boom"));
    expect(states.map((s) => s.status)).toEqual(["available", "downloading", "downloaded", "error"]);
    const text = logs.join("\n");
    for (const s of ["update-available v0.1.4", "download-progress 55.0%", "update-downloaded v0.1.4", "signature check skipped", "ERROR error: Error: boom"]) expect(text).toContain(s);
  });

  it("allowUnsignedUpdates leaves updaters without the hook alone", () => {
    expect(allowUnsignedUpdates({})).toBe(false);
  });
});

describe("install (Restart to update)", () => {
  it("sets the quit-for-update flag, prepares (children killed) before quitAndInstall(true, true)", async () => {
    const { c, fake, events, states } = setup();
    downloaded(c, fake);
    let flagDuringPrepare = false;
    c.hooks.prepare = vi.fn(async () => {
      flagDuringPrepare = c.quittingForUpdate;
      events.push("prepare");
    });
    await c.install();
    expect(flagDuringPrepare).toBe(true);
    expect(events).toEqual(["prepare", "quitAndInstall(true,true)"]);
    expect(c.installPath).toBe("quitAndInstall");
    expect(states.at(-1)).toMatchObject({ status: "installing", version: "0.1.4" });
    expect(c.cancelQueuedQuit).toBe(false);
  });

  it("the recorder's close stops hiding to the tray once the update quit starts", async () => {
    const { c, fake } = setup();
    downloaded(c, fake);
    expect(hideToTrayOnClose({ quitting: false, quittingForUpdate: c.quittingForUpdate }, true)).toBe(true);
    await c.install();
    expect(hideToTrayOnClose({ quitting: false, quittingForUpdate: c.quittingForUpdate }, true)).toBe(false);
    expect(hideToTrayOnClose({ quitting: true, quittingForUpdate: false }, true)).toBe(false);
  });

  it("a failing prepare does not stop the install", async () => {
    const { c, fake, events, logs } = setup({}, { prepare: vi.fn(async () => Promise.reject(new Error("hook stuck"))) });
    downloaded(c, fake);
    await c.install();
    expect(events).toContain("quitAndInstall(true,true)");
    expect(logs.join("\n")).toContain("prepare for install failed, installing anyway: hook stuck");
  });

  it("watchdog: still alive after quitAndInstall -> app.exit(0)", async () => {
    const { c, fake, events } = setup({ watchdogMs: 30 });
    downloaded(c, fake);
    await c.install();
    await new Promise((r) => setTimeout(r, 80));
    expect(events).toEqual(["prepare", "quitAndInstall(true,true)", "exit(0)"]);
  });

  it("fallback: quitAndInstall throws -> spawn the installer with --updated /S --force-run, then exit", async () => {
    const { c, fake, events, spawned } = setup();
    fake.quitAndInstall.mockImplementation(() => {
      throw new Error("ENOENT elevate");
    });
    downloaded(c, fake);
    await c.install();
    expect(events).toEqual(["prepare", "spawn", "exit(0)"]);
    expect(spawned[0]).toMatchObject({ file: installer, args: ["--updated", "/S", "--force-run"], opts: { detached: true, stdio: "ignore" } });
    expect(c.installPath).toBe("direct-spawn");
    expect(INSTALLER_ARGS).toEqual(["--updated", "/S", "--force-run"]);
  });

  it("fallback: quitAndInstall refuses (install() returned false) -> direct spawn", async () => {
    const { c, fake, events } = setup();
    fake.quitAndInstall.mockImplementation(() => {
      fake.quitAndInstallCalled = false;
      fake.emit("error", new Error("No valid update available, can't quit and install"));
    });
    c.init();
    c.dispose();
    downloaded(c, fake);
    await c.install();
    // the error during the refused call is reported and the fallback still runs
    expect(events.filter((e) => e === "spawn" || e === "exit(0)")).toEqual(["spawn", "exit(0)"]);
  });

  it("installer could not be started (updater error while installing): quit cancelled, dialog, restore, no forced exit", async () => {
    const { c, fake, events, states } = setup({ watchdogMs: 30 });
    c.init();
    c.dispose();
    fake.quitAndInstall.mockImplementation(() => {
      fake.quitAndInstallCalled = true;
      // electron-updater reports a failed spawn on the next tick, before its queued app.quit()
      process.nextTick(() => fake.emit("error", new Error("spawn EPERM")));
    });
    downloaded(c, fake);
    await c.install();
    await new Promise((r) => setTimeout(r, 80));
    expect(c.cancelQueuedQuit).toBe(true);
    expect(cancelQuit(c.cancelQueuedQuit)).toBe(true);
    expect(c.quittingForUpdate).toBe(false);
    expect(events).toContain("restore");
    expect(events.find((e) => e.startsWith("dialog:"))).toContain("spawn EPERM");
    expect(events).not.toContain("exit(0)");
    expect(states.at(-1)).toMatchObject({ status: "error" });
  });

  it("missing downloaded installer: dialog, nothing quits", async () => {
    const { c, fake, events } = setup();
    downloaded(c, fake, path.join(tmp, "gone.exe"));
    await c.install();
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
    expect(events[0]).toMatch(/^dialog:The downloaded installer is missing/);
    expect(c.cancelQueuedQuit).toBe(false);
  });

  it("direct spawn fails too: dialog instead of exiting", async () => {
    const { c, fake, events } = setup({
      spawn: (() => {
        const p = new EventEmitter() as EventEmitter & { pid?: number; unref(): void };
        p.unref = () => undefined;
        return p;
      }) as never,
    });
    fake.quitAndInstall.mockImplementation(() => {
      throw new Error("x");
    });
    downloaded(c, fake);
    await c.install();
    expect(events).not.toContain("exit(0)");
    expect(events.at(-1)).toMatch(/^dialog:The update installer could not be started/);
    expect(c.cancelQueuedQuit).toBe(false);
  });

  it("ignored unless downloaded; LENS_UPDATE_NO_INSTALL stops before the install", async () => {
    const a = setup();
    a.c.attach(a.fake as never);
    a.c.state = { status: "available", version: "0.1.4" };
    await a.c.install();
    expect(a.fake.quitAndInstall).not.toHaveBeenCalled();
    process.env.LENS_UPDATE_NO_INSTALL = "1";
    const b = setup();
    downloaded(b.c, b.fake);
    await b.c.install();
    expect(b.fake.quitAndInstall).not.toHaveBeenCalled();
    expect(b.events).toEqual([]);
  });

  it("release page link for the manual download", () => {
    expect(releasePage("0.1.4")).toBe("https://github.com/MuhammadFaizan-prog/Lens/releases/tag/v0.1.4");
    expect(releasePage()).toBe("https://github.com/MuhammadFaizan-prog/Lens/releases/latest");
  });
});

describe("with the real electron-updater 6.6.2 NsisUpdater", () => {
  // electron-updater require()s "electron" (autoUpdater.emit before quitting); give it a stand-in
  const req = createRequire(import.meta.url);
  const M = Module as unknown as { _load: (r: string, ...a: unknown[]) => unknown };
  const origLoad = M._load;
  const quitForUpdate = vi.fn();
  beforeEach(() => {
    M._load = function (r: string, ...a: unknown[]) {
      if (r === "electron") return { autoUpdater: { emit: quitForUpdate }, app: {} };
      return origLoad.call(this, r, ...a);
    };
  });
  afterEach(() => {
    M._load = origLoad;
  });

  function realUpdater(publisherName?: string) {
    const eu = req("electron-updater") as typeof import("electron-updater");
    const cfg = path.join(tmp, `app-update-${publisherName ?? "none"}.yml`);
    fs.writeFileSync(cfg, `provider: github\nowner: MuhammadFaizan-prog\nrepo: Lens\nupdaterCacheDirName: lens-updater\n${publisherName ? `publisherName:\n  - ${publisherName}\n` : ""}`);
    const quit = vi.fn();
    const appAdapter = {
      version: "0.1.3", name: "Lens", isPackaged: true, appUpdateConfigPath: cfg, userDataPath: tmp, baseCachePath: tmp,
      whenReady: () => Promise.resolve(), relaunch: () => undefined, quit, onQuit: () => undefined,
    };
    const u = new eu.NsisUpdater(null, appAdapter as never);
    u.logger = null;
    return { u, quit };
  }

  it("quitAndInstall(true, true) runs the downloaded installer with --updated /S --force-run, then quits", async () => {
    const out = path.join(tmp, "installer-args.txt");
    const script = path.join(tmp, "fake-installer.sh");
    fs.writeFileSync(script, `#!/bin/sh\necho "$@" > "${out}"\n`, { mode: 0o755 });
    const { u, quit } = realUpdater();
    (u as unknown as { downloadedUpdateHelper: unknown }).downloadedUpdateHelper = { file: script, downloadedFileInfo: { isAdminRightsRequired: false }, packageFile: null };
    const order: string[] = [];
    quit.mockImplementation(() => void order.push("app.quit"));
    const c = new UpdateController(() => undefined, { platform: "win32", log: () => undefined, exit: vi.fn(), watchdogMs: 60_000 });
    c.hooks = { prepare: async () => void order.push("prepare"), restore: () => undefined, showInstallError: () => undefined };
    c.attach(u);
    c.state = { status: "downloaded", version: "0.1.4", file: script, sha512: "x" };
    await c.install();
    await new Promise((r) => setTimeout(r, 300));
    expect(fs.readFileSync(out, "utf8").trim()).toBe("--updated /S --force-run");
    expect(order).toEqual(["prepare", "app.quit"]);
    expect(quitForUpdate).toHaveBeenCalledWith("before-quit-for-update");
    expect(c.installPath).toBe("quitAndInstall");
  });

  it("verifySignature: no publisherName -> no check; with a publisherName the replaced check passes the unsigned installer", async () => {
    const a = realUpdater();
    expect(await (a.u as unknown as { verifySignature(f: string): Promise<string | null> }).verifySignature(installer)).toBeNull();
    const b = realUpdater("Someone Else");
    expect(allowUnsignedUpdates(b.u)).toBe(true);
    expect(await (b.u as unknown as { verifySignature(f: string): Promise<string | null> }).verifySignature(installer)).toBeNull();
  });
});
