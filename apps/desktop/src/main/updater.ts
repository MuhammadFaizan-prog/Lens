/**
 * Auto-update (docs/Releasing.md): electron-updater against GitHub Releases of
 * MuhammadFaizan-prog/Lens (latest.yml + NSIS installer + blockmap). Checks on launch and every
 * 4 hours; the recorder window shows "Update available vX" -> Update (download, sha512-verified by
 * electron-updater) -> "Restart to update" (install()). A downloaded update also installs on the
 * next normal quit.
 *
 * The installer only replaces the program folder. Recordings live in <Videos>/Lens and settings in
 * the user-data folder, neither of which the installer or the updater writes (nsis
 * deleteAppDataOnUninstall stays false).
 *
 * Restart to update (fix/updater-014; Windows report on 0.1.3: the app closed, the installer never
 * ran, Lens never came back):
 *   1. the main process is told first (hooks.prepare): the quit-for-update flag makes window "close"
 *      handlers let go instead of hiding to the tray, and every child process (ffmpeg.exe /
 *      whisper-cli.exe, which run from inside the install folder and keep it locked; the NSIS
 *      installer only kills Lens.exe) is killed and awaited, the keyboard hook and the editor server
 *      are stopped;
 *   2. quitAndInstall(isSilent=true, isForceRunAfter=true) on the next tick: electron-updater spawns
 *      `<installer> --updated /S --force-run` detached, then app.quit();
 *   3. if quitAndInstall throws or refuses, the installer is spawned directly with the same arguments
 *      and the app exits (app.exit(0), no quit handlers);
 *   4. a watchdog exits the app if it is somehow still running WATCHDOG_MS later (a quit handler or a
 *      window cancelled the quit), so the installer is never left waiting on a live Lens.exe;
 *   5. an updater error while installing (e.g. the installer could not be started) cancels the quit
 *      and shows a dialog with "Download installer manually" (the release page).
 * Every updater event and error is written to lens.log ("[update] ...").
 *
 * The build is unsigned and publisherName is not set, so electron-updater skips the Authenticode check
 * (NsisUpdater.verifySignature returns null without a publisherName). verifyUpdateCodeSignature is also
 * replaced by a pass-through so a publisherName slipping into app-update.yml cannot silently block
 * every update of an unsigned build; replace it when the build is signed. The sha512 check against
 * latest.yml stays on either way.
 *
 * Test / dev switches: LENS_UPDATE_URL=<generic feed> overrides the feed; LENS_UPDATE_NSIS=1 runs the
 * Windows (NSIS) updater on another OS so detect + download + sha512 can be tested on Linux;
 * LENS_NO_UPDATE=1 turns the updater off; LENS_UPDATE_NO_INSTALL=1 stops before the install.
 */
import { app } from "electron";
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import { logLine } from "./log";

export const UPDATE_OWNER = "MuhammadFaizan-prog";
export const UPDATE_REPO = "Lens";
export const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
export const RELEASES_URL = `https://github.com/${UPDATE_OWNER}/${UPDATE_REPO}/releases/latest`;
/** What electron-updater's NsisUpdater passes for quitAndInstall(true, true); the direct fallback uses the same. */
export const INSTALLER_ARGS = ["--updated", "/S", "--force-run"];
export const WATCHDOG_MS = 8000;

export const releasePage = (version?: string): string => (version ? `https://github.com/${UPDATE_OWNER}/${UPDATE_REPO}/releases/tag/v${version}` : RELEASES_URL);

export type UpdateState =
  | { status: "disabled"; reason: string }
  | { status: "idle" }
  | { status: "checking" }
  | { status: "none"; version: string; checkedAt: number }
  | { status: "available"; version: string; notes?: string }
  | { status: "downloading"; version: string; percent: number; bytes: number; total: number }
  | { status: "downloaded"; version: string; file: string; sha512: string }
  | { status: "installing"; version: string; file: string }
  | { status: "error"; message: string };

type Updater = import("electron-updater").AppUpdater;
type UpdaterModule = typeof import("electron-updater");

export const FOCUS_RECHECK_MS = 15 * 60 * 1000;

/** What the main process does around an install (main.ts). */
export interface InstallHooks {
  /** Set the quit-for-update flag and stop everything that could keep the app alive or hold files in the install folder. */
  prepare(): Promise<void>;
  /** The install could not start: undo prepare() (the app keeps running). */
  restore(): void;
  /** Tell the user, with a way to get the installer by hand. */
  showInstallError(message: string, version?: string): void;
}

/** Injectable for tests (test/updater.test.ts); defaults are the real Electron / Node pieces. */
export interface UpdaterEnv {
  platform: NodeJS.Platform;
  isPackaged(): boolean;
  exit(code: number): void;
  load(): UpdaterModule;
  spawn: typeof nodeSpawn;
  exists(file: string): boolean;
  log(level: "INFO" | "WARN" | "ERROR", message: string): void;
  watchdogMs: number;
}

const defaultEnv = (): UpdaterEnv => ({
  platform: process.platform,
  isPackaged: () => app.isPackaged,
  exit: (code) => app.exit(code),
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  load: () => require("electron-updater") as UpdaterModule,
  spawn: nodeSpawn,
  exists: (f) => fs.existsSync(f),
  log: (level, message) => logLine(level, `[update] ${message}`),
  watchdogMs: Number(process.env.LENS_UPDATE_WATCHDOG_MS ?? WATCHDOG_MS),
});

/**
 * Unsigned build: never let an Authenticode check refuse the update (see the header). NsisUpdater calls
 * verifyUpdateCodeSignature only when app-update.yml names a publisherName; a null result means "ok".
 */
export function allowUnsignedUpdates(u: object, log: (m: string) => void = () => undefined): boolean {
  if (!("verifyUpdateCodeSignature" in u)) return false;
  (u as { verifyUpdateCodeSignature: unknown }).verifyUpdateCodeSignature = async (publishers: string[], file: string) => {
    log(`signature check skipped (unsigned build; publisherName ${JSON.stringify(publishers)}) for ${file}`);
    return null;
  };
  return true;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const noHooks: InstallHooks = { prepare: async () => undefined, restore: () => undefined, showInstallError: () => undefined };

export class UpdateController {
  state: UpdateState = { status: "idle" };
  private updater: Updater | null = null;
  private timer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private available: string | null = null;
  private lastLoggedPercent = -10;
  private readonly env: UpdaterEnv;
  /** When the last check started (focus re-checks are throttled on it). */
  lastCheckAt = 0;
  checks = 0;
  /** True from "Restart to update" until the app is gone (or the install failed). main.ts reads it. */
  quittingForUpdate = false;
  /** The install could not start: main.ts cancels the quit electron-updater may still have queued. */
  installFailed = false;
  /** quitAndInstall had queued app.quit() when the install failed: main.ts cancels that one quit. */
  cancelQueuedQuit = false;
  private quitAndInstallInvoked = false;
  /** Inside the synchronous quitAndInstall() call: its errors decide the fallback, not a failure. */
  private inQuitAndInstall = false;
  private prepared = false;
  /** How the last install was started (tests / log). */
  installPath: "quitAndInstall" | "direct-spawn" | null = null;
  hooks: InstallHooks = noHooks;

  constructor(
    private readonly onState: (s: UpdateState) => void,
    env: Partial<UpdaterEnv> = {},
  ) {
    this.env = { ...defaultEnv(), ...env };
  }

  private set(s: UpdateState): void {
    this.state = s;
    this.onState(s);
  }

  private log(level: "INFO" | "WARN" | "ERROR", m: string): void {
    try {
      this.env.log(level, m);
    } catch {
      // logging never breaks the update
    }
  }

  init(): void {
    if (process.env.LENS_NO_UPDATE === "1") return this.set({ status: "disabled", reason: "LENS_NO_UPDATE=1" });
    const forceNsis = process.env.LENS_UPDATE_NSIS === "1";
    if (this.env.platform !== "win32" && !forceNsis) return this.set({ status: "disabled", reason: "auto-update ships for the Windows installer only" });
    if (!this.env.isPackaged() && !forceNsis && !process.env.LENS_UPDATE_URL) return this.set({ status: "disabled", reason: "development build" });
    const eu = this.env.load();
    const u: Updater = forceNsis ? new eu.NsisUpdater() : eu.autoUpdater;
    u.autoDownload = false;
    u.autoInstallOnAppQuit = true;
    u.allowDowngrade = false;
    u.allowPrerelease = false;
    u.logger = {
      info: (m: unknown) => this.log("INFO", `electron-updater: ${String(m)}`),
      warn: (m: unknown) => this.log("WARN", `electron-updater: ${String(m)}`),
      error: (m: unknown) => this.log("ERROR", `electron-updater: ${String(m)}`),
      debug: () => undefined,
    };
    allowUnsignedUpdates(u, (m) => this.log("WARN", m));
    if (!this.env.isPackaged()) u.forceDevUpdateConfig = true;
    const url = process.env.LENS_UPDATE_URL;
    if (url) u.setFeedURL({ provider: "generic", url });
    else if (!this.env.isPackaged() || forceNsis) u.setFeedURL({ provider: "github", owner: UPDATE_OWNER, repo: UPDATE_REPO });
    // packaged builds read resources/app-update.yml (github, written by electron-builder from the publish config)
    u.on("checking-for-update", () => {
      this.log("INFO", "checking-for-update");
      this.set({ status: "checking" });
    });
    u.on("update-available", (i) => {
      this.log("INFO", `update-available v${i.version} (${i.path ?? i.files?.[0]?.url ?? "?"})`);
      this.available = i.version;
      this.lastLoggedPercent = -10;
      this.set({ status: "available", version: i.version, notes: typeof i.releaseNotes === "string" ? i.releaseNotes : undefined });
    });
    u.on("update-not-available", (i) => {
      this.log("INFO", `update-not-available (latest v${i.version})`);
      this.set({ status: "none", version: i.version, checkedAt: Date.now() });
    });
    u.on("download-progress", (p) => {
      if (p.percent - this.lastLoggedPercent >= 10 || p.percent >= 100) {
        this.lastLoggedPercent = p.percent;
        this.log("INFO", `download-progress ${p.percent.toFixed(1)}% (${p.transferred}/${p.total} bytes)`);
      }
      this.set({ status: "downloading", version: this.available ?? "", percent: Math.round(p.percent * 10) / 10, bytes: p.transferred, total: p.total });
    });
    u.on("update-downloaded", (e) => {
      this.log("INFO", `update-downloaded v${e.version} -> ${e.downloadedFile} (sha512 ${e.sha512})`);
      this.set({ status: "downloaded", version: e.version, file: e.downloadedFile, sha512: e.sha512 });
    });
    u.on("update-cancelled", (i) => this.log("WARN", `update-cancelled v${i?.version ?? "?"}`));
    u.on("error", (e, more) => this.onUpdaterError(e, more));
    this.updater = u;
    this.log("INFO", `updater ready (${forceNsis ? "NsisUpdater forced" : "autoUpdater"}, feed ${url ?? "app-update.yml / github"})`);
    setTimeout(() => void this.check(), Number(process.env.LENS_UPDATE_FIRST_CHECK_MS ?? 8000));
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
  }

  /** For tests: drive the controller with a fake electron-updater instance. */
  attach(u: Updater): void {
    this.updater = u;
  }

  private onUpdaterError(e: unknown, more?: unknown): void {
    const message = errText(e);
    this.log("ERROR", `error: ${e instanceof Error && e.stack ? e.stack : message}${more ? ` (${String(more)})` : ""}`);
    if (this.inQuitAndInstall) return; // install() looks at the outcome and falls back to a direct spawn
    if (this.quittingForUpdate && !this.installFailed) {
      // e.g. the installer could not be started: cancel the quit and say so
      const version = this.state.status === "installing" ? this.state.version : undefined;
      this.failInstall(`The update installer could not be started: ${message}`, version);
      return;
    }
    this.set({ status: "error", message });
  }

  /**
   * Windows #21: an app left open since before a release must still notice it. Called when any Lens
   * window gains focus; checks again if the last check is older than minAgeMs (15 min by default).
   */
  checkIfStale(minAgeMs = Number(process.env.LENS_UPDATE_FOCUS_MS ?? FOCUS_RECHECK_MS)): boolean {
    if (!this.updater || this.state.status === "checking" || this.state.status === "downloading" || this.state.status === "downloaded" || this.state.status === "installing") return false;
    if (Date.now() - this.lastCheckAt < minAgeMs) return false;
    void this.check();
    return true;
  }

  async check(): Promise<UpdateState> {
    if (!this.updater) return this.state;
    this.lastCheckAt = Date.now();
    this.checks++;
    if (this.state.status === "downloading" || this.state.status === "downloaded" || this.state.status === "installing") return this.state;
    try {
      await this.updater.checkForUpdates();
    } catch (e) {
      this.log("ERROR", `checkForUpdates failed: ${errText(e)}`);
      this.set({ status: "error", message: errText(e) });
    }
    return this.state;
  }

  async download(): Promise<UpdateState> {
    if (!this.updater || this.state.status !== "available") return this.state;
    this.log("INFO", `download requested v${this.available ?? "?"}`);
    this.set({ status: "downloading", version: this.available ?? "", percent: 0, bytes: 0, total: 0 });
    try {
      await this.updater.downloadUpdate();
    } catch (e) {
      this.log("ERROR", `downloadUpdate failed: ${errText(e)}`);
      this.set({ status: "error", message: errText(e) });
    }
    return this.state;
  }

  /**
   * Quit and run the downloaded installer (silent per-user install, then relaunch). See the header for
   * the steps. Resolves once the install has been handed off (the app is then exiting) or has failed.
   */
  async install(): Promise<void> {
    if (!this.updater || this.state.status !== "downloaded") {
      this.log("WARN", `install ignored in state ${this.state.status}`);
      return;
    }
    if (process.env.LENS_UPDATE_NO_INSTALL === "1") {
      this.log("INFO", "install skipped (LENS_UPDATE_NO_INSTALL=1)");
      return; // tests stop before the Windows-only step
    }
    const { version, file } = this.state;
    this.log("INFO", `install requested v${version}: ${file}`);
    if (!this.env.exists(file)) return this.failInstall(`The downloaded installer is missing (${file}).`, version);
    this.quittingForUpdate = true;
    this.installFailed = false;
    this.set({ status: "installing", version, file });
    try {
      this.prepared = true;
      await this.hooks.prepare();
      this.log("INFO", "prepared for install (children stopped, quit-for-update set)");
    } catch (e) {
      this.log("WARN", `prepare for install failed, installing anyway: ${errText(e)}`);
    }
    // next tick: nothing of ours is on the stack when electron-updater spawns the installer and quits
    await new Promise<void>((r) => setImmediate(r));
    let threw: unknown = null;
    try {
      this.log("INFO", "quitAndInstall(isSilent=true, isForceRunAfter=true)");
      this.quitAndInstallInvoked = true;
      this.inQuitAndInstall = true;
      this.updater.quitAndInstall(true, true);
    } catch (e) {
      threw = e;
    } finally {
      this.inQuitAndInstall = false;
    }
    // BaseUpdater.install() leaves quitAndInstallCalled true only when it spawned the installer
    const accepted = !threw && (this.updater as unknown as { quitAndInstallCalled?: boolean }).quitAndInstallCalled !== false;
    if (this.installFailed) return; // an "error" event already cancelled it
    if (!accepted) {
      this.log("WARN", `quitAndInstall did not start the installer (${threw ? errText(threw) : "refused"}): spawning it directly`);
      this.quitAndInstallInvoked = false; // it queued no quit
      return this.directInstall(file, version);
    }
    this.installPath = "quitAndInstall";
    this.armWatchdog();
  }

  /** Fallback: run the installer ourselves, detached, then leave without quit handlers. */
  private directInstall(file: string, version: string): void {
    let pid: number | undefined;
    try {
      this.log("INFO", `spawn ${file} ${INSTALLER_ARGS.join(" ")}`);
      const p = this.env.spawn(file, INSTALLER_ARGS, { detached: true, stdio: "ignore" });
      p.on("error", (e) => this.log("ERROR", `direct installer spawn error: ${errText(e)}`));
      pid = p.pid;
      p.unref();
    } catch (e) {
      return this.failInstall(`The update installer could not be started: ${errText(e)}`, version);
    }
    if (pid === undefined) return this.failInstall("The update installer could not be started (no process).", version);
    this.installPath = "direct-spawn";
    this.log("INFO", `installer started directly (pid ${pid}); exiting`);
    this.env.exit(0);
  }

  private armWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      if (this.installFailed) return;
      this.log("WARN", `still running ${this.env.watchdogMs} ms after quitAndInstall: forcing exit so the installer can replace the files`);
      this.env.exit(0);
    }, this.env.watchdogMs);
    this.watchdog.unref?.();
  }

  private failInstall(message: string, version?: string): void {
    this.log("ERROR", `install failed: ${message}`);
    this.installFailed = true;
    this.quittingForUpdate = false;
    // electron-updater queues app.quit() right after spawning the installer; an error reported before
    // that quit runs means the installer did not start, so that quit must not happen
    this.cancelQueuedQuit = this.quitAndInstallInvoked && this.installPath !== "direct-spawn";
    this.quitAndInstallInvoked = false;
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    if (this.prepared) {
      this.prepared = false;
      try {
        this.hooks.restore();
      } catch (e) {
        this.log("WARN", `restore after failed install: ${errText(e)}`);
      }
    }
    this.set({ status: "error", message });
    this.hooks.showInstallError(message, version);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
