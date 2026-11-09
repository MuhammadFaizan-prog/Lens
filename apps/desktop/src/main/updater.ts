/**
 * Auto-update (docs/Releasing.md): electron-updater against GitHub Releases of
 * MuhammadFaizan-prog/Lens (latest.yml + NSIS installer + blockmap). Checks on launch and every
 * 4 hours; the recorder window shows "Update available vX" -> Update (download, sha512-verified by
 * electron-updater) -> "Restart to update" (quitAndInstall). A downloaded update also installs on the
 * next normal quit.
 *
 * The installer only replaces the program folder. Recordings live in <Videos>/Lens and settings in
 * the user-data folder, neither of which the installer or the updater writes (nsis
 * deleteAppDataOnUninstall stays false).
 *
 * The build is unsigned and publisherName is not set, so the updater skips the Authenticode check.
 *
 * Test / dev switches: LENS_UPDATE_URL=<generic feed> overrides the feed; LENS_UPDATE_NSIS=1 runs the
 * Windows (NSIS) updater on another OS so detect + download + sha512 can be tested on Linux;
 * LENS_NO_UPDATE=1 turns the updater off.
 */
import { app } from "electron";

export const UPDATE_OWNER = "MuhammadFaizan-prog";
export const UPDATE_REPO = "Lens";
export const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

export type UpdateState =
  | { status: "disabled"; reason: string }
  | { status: "idle" }
  | { status: "checking" }
  | { status: "none"; version: string; checkedAt: number }
  | { status: "available"; version: string; notes?: string }
  | { status: "downloading"; version: string; percent: number; bytes: number; total: number }
  | { status: "downloaded"; version: string; file: string; sha512: string }
  | { status: "error"; message: string };

type Updater = import("electron-updater").AppUpdater;

export const FOCUS_RECHECK_MS = 15 * 60 * 1000;

export class UpdateController {
  state: UpdateState = { status: "idle" };
  private updater: Updater | null = null;
  private timer: NodeJS.Timeout | null = null;
  private available: string | null = null;
  /** When the last check started (focus re-checks are throttled on it). */
  lastCheckAt = 0;
  checks = 0;

  constructor(private readonly onState: (s: UpdateState) => void) {}

  private set(s: UpdateState): void {
    this.state = s;
    this.onState(s);
  }

  init(): void {
    if (process.env.LENS_NO_UPDATE === "1") return this.set({ status: "disabled", reason: "LENS_NO_UPDATE=1" });
    const forceNsis = process.env.LENS_UPDATE_NSIS === "1";
    if (process.platform !== "win32" && !forceNsis) return this.set({ status: "disabled", reason: "auto-update ships for the Windows installer only" });
    if (!app.isPackaged && !forceNsis && !process.env.LENS_UPDATE_URL) return this.set({ status: "disabled", reason: "development build" });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const eu = require("electron-updater") as typeof import("electron-updater");
    const u: Updater = forceNsis ? new eu.NsisUpdater() : eu.autoUpdater;
    u.autoDownload = false;
    u.autoInstallOnAppQuit = true;
    u.allowDowngrade = false;
    u.allowPrerelease = false;
    u.logger = { info: (m: unknown) => console.log("[update]", m), warn: (m: unknown) => console.warn("[update]", m), error: (m: unknown) => console.error("[update]", m), debug: () => undefined };
    if (!app.isPackaged) u.forceDevUpdateConfig = true;
    const url = process.env.LENS_UPDATE_URL;
    if (url) u.setFeedURL({ provider: "generic", url });
    else if (!app.isPackaged || forceNsis) u.setFeedURL({ provider: "github", owner: UPDATE_OWNER, repo: UPDATE_REPO });
    // packaged builds read resources/app-update.yml (github, written by electron-builder from the publish config)
    u.on("checking-for-update", () => this.set({ status: "checking" }));
    u.on("update-available", (i) => {
      this.available = i.version;
      this.set({ status: "available", version: i.version, notes: typeof i.releaseNotes === "string" ? i.releaseNotes : undefined });
    });
    u.on("update-not-available", (i) => this.set({ status: "none", version: i.version, checkedAt: Date.now() }));
    u.on("download-progress", (p) => this.set({ status: "downloading", version: this.available ?? "", percent: Math.round(p.percent * 10) / 10, bytes: p.transferred, total: p.total }));
    u.on("update-downloaded", (e) => this.set({ status: "downloaded", version: e.version, file: e.downloadedFile, sha512: e.sha512 }));
    u.on("error", (e) => this.set({ status: "error", message: e?.message ?? String(e) }));
    this.updater = u;
    setTimeout(() => void this.check(), Number(process.env.LENS_UPDATE_FIRST_CHECK_MS ?? 8000));
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
  }

  /**
   * Windows #21: an app left open since before a release must still notice it. Called when any Lens
   * window gains focus; checks again if the last check is older than minAgeMs (15 min by default).
   */
  checkIfStale(minAgeMs = Number(process.env.LENS_UPDATE_FOCUS_MS ?? FOCUS_RECHECK_MS)): boolean {
    if (!this.updater || this.state.status === "checking" || this.state.status === "downloading" || this.state.status === "downloaded") return false;
    if (Date.now() - this.lastCheckAt < minAgeMs) return false;
    void this.check();
    return true;
  }

  async check(): Promise<UpdateState> {
    if (!this.updater) return this.state;
    this.lastCheckAt = Date.now();
    this.checks++;
    if (this.state.status === "downloading" || this.state.status === "downloaded") return this.state;
    try {
      await this.updater.checkForUpdates();
    } catch (e) {
      this.set({ status: "error", message: e instanceof Error ? e.message : String(e) });
    }
    return this.state;
  }

  async download(): Promise<UpdateState> {
    if (!this.updater || this.state.status !== "available") return this.state;
    this.set({ status: "downloading", version: this.available ?? "", percent: 0, bytes: 0, total: 0 });
    try {
      await this.updater.downloadUpdate();
    } catch (e) {
      this.set({ status: "error", message: e instanceof Error ? e.message : String(e) });
    }
    return this.state;
  }

  /** Quit and run the downloaded installer (silent per-user install, then relaunch). */
  install(): void {
    if (!this.updater || this.state.status !== "downloaded") return;
    if (process.env.LENS_UPDATE_NO_INSTALL === "1") return; // tests stop before the Windows-only step
    setImmediate(() => this.updater!.quitAndInstall(true, true));
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
