/**
 * Lens desktop (Electron). The recorder window (pick a screen or window, mic toggle, Start / Stop,
 * live auto-zoom preview), a global hotkey (Ctrl+Shift+R), a tray icon, the recording session
 * (recording.ts) and the bundled editor (editorServer.ts), opened on the new project after Stop.
 * See docs/Desktop.md.
 */
import { app, BrowserWindow, desktopCapturer, dialog, shell, globalShortcut, ipcMain, Menu, nativeImage, screen, session, Tray } from "electron";
import path from "node:path";
import { displayForSource } from "../shared/coords";
import { startEditorServer, type EditorServer } from "./editorServer";
import { ffmpegPath, recordingsDir, rendererFile } from "./paths";
import { IMPORT_EXTENSIONS, deleteBundle, importVideo, listHistory } from "./library";
import { displayGeoms, Recording, setKeyTable, type Hook, type StartInfo } from "./recording";
import { UpdateController, type UpdateState } from "./updater";
import { defaultSettings, loadSettings, normalize, saveSettings, shortcutConflict, type Settings } from "./settings";

const APP_ID = "io.github.muhammadfaizanprog.lens"; // = electron-builder appId (scripts/dist-win.mjs)
export const HOTKEY = process.env.LENS_HOTKEY || "CommandOrControl+Shift+R";

if (process.env.LENS_LOWMEM === "1") {
  // small CI sandboxes (docs/Desktop.md, Tests)
  for (const s of ["disable-gpu", "in-process-gpu", "disable-dev-shm-usage", "no-zygote", "disable-gpu-sandbox"]) app.commandLine.appendSwitch(s);
  app.commandLine.appendSwitch("renderer-process-limit", "2");
}
if (process.env.LENS_USER_DATA) app.setPath("userData", process.env.LENS_USER_DATA);
// Windows groups taskbar buttons and picks their icon by AppUserModelID; without it the windows group
// under electron.exe. Must equal the appId the installer writes on the Start-menu shortcut.
if (process.platform === "win32") app.setAppUserModelId(APP_ID);

// ---- settings (Windows #19): loaded before ready (hardware acceleration must be decided now)
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
const settingsDefaults = (): Settings => {
  const d = defaultSettings(app.getPath("videos"), HOTKEY);
  if (process.env.LENS_RECORDINGS_DIR) d.general.saveDir = process.env.LENS_RECORDINGS_DIR;
  if (process.env.LENS_RECORDINGS_DIR) d.general.exportDir = path.join(process.env.LENS_RECORDINGS_DIR, "Exports");
  return d;
};
let settings: Settings = loadSettings(settingsFile(), settingsDefaults());
let hotkey = settings.shortcuts.startStop;
function applySettingsEnv(): void {
  process.env.LENS_SAVE_DIR = settings.general.saveDir;
  process.env.LENS_EXPORT_DIR = settings.general.exportDir;
}
applySettingsEnv();
if (!settings.general.hardwareAcceleration) app.disableHardwareAcceleration();

let recorderWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let editor: EditorServer | null = null;
let rec: Recording | null = null;
let hook: (Hook & { start(): void; stop(): void }) | null = null;
let hookError: string | null = null;
const editorWindows: BrowserWindow[] = [];
const updates = new UpdateController((st) => {
  recorderWin?.webContents.send("lens:update", st);
  updateTray();
  buildAppMenu();
});

function updateLabel(st: UpdateState): string {
  switch (st.status) {
    case "available": return `Update available v${st.version}: download`;
    case "downloading": return `Downloading update ${Math.round(st.percent)}%`;
    case "downloaded": return `Restart to update to v${st.version}`;
    case "checking": return "Checking for updates…";
    default: return "Check for updates";
  }
}

function updateAction(): void {
  const st = updates.state;
  if (st.status === "available") void updates.download();
  else if (st.status === "downloaded") updates.install();
  else if (st.status !== "downloading" && st.status !== "checking") void updates.check();
  showRecorder();
}

function buildAppMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: "Lens", submenu: [{ label: updateLabel(updates.state), enabled: updates.state.status !== "disabled", click: () => updateAction() }, { type: "separator" }, { role: "quit" }] },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

function loadHook(): void {
  try {
    // native module (Windows / macOS / Linux prebuilds); kept out of the bundle
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require("uiohook-napi");
    setKeyTable(m.UiohookKey);
    hook = m.uIOhook;
    hook!.start();
  } catch (e) {
    hookError = e instanceof Error ? e.message : String(e);
    hook = null;
    console.error("[lens] uiohook-napi unavailable:", hookError);
  }
}

// The Lens icon (scripts/make-icon.mjs, built into dist/icons): the same art as the installer and
// Lens.exe. Windows gets the multi-size .ico (it picks 16 / 24 / 32 px for the title bar, taskbar
// and tray by DPI); elsewhere a PNG.
const appIconPath = path.join(__dirname, "icons", process.platform === "win32" ? "lens.ico" : "lens-256.png");
let appIconImage: Electron.NativeImage | null = null;
function appIcon(): Electron.NativeImage {
  appIconImage ??= nativeImage.createFromPath(appIconPath);
  return appIconImage;
}

function trayIcon(): Electron.NativeImage {
  if (process.platform === "win32") return appIcon();
  return nativeImage.createFromPath(path.join(__dirname, "icons", "lens-32.png")).resize({ width: 16, height: 16, quality: "best" });
}

function updateTray(): void {
  if (!tray) return;
  const recording = !!rec;
    tray.setToolTip(recording ? `Lens: recording (${keyLabel(hotkey)} to stop)` : `Lens: ready (${keyLabel(hotkey)} to record)`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: recording ? "Stop recording" : "Start recording", accelerator: hotkey, click: () => toggle() },
      { label: "Show recorder", click: () => showRecorder() },
      { label: "Settings…", click: () => openSettings() },
      { label: updateLabel(updates.state), enabled: updates.state.status !== "disabled", click: () => updateAction() },
      { type: "separator" },
      { label: "Quit Lens", click: () => app.quit() },
    ]),
  );
}

/**
 * Windows #6: the recorder must come up on launch, on a second launch (Start menu while Lens sits in
 * the tray), and on a tray click. Restores a minimised window, pulls it back on screen if its saved
 * position is on a display that is gone, and raises it above other windows.
 */
function showRecorder(): void {
  if (!recorderWin) createRecorder();
  const w = recorderWin!;
  if (w.isMinimized()) w.restore();
  const b = w.getBounds();
  const onScreen = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x + 40 < a.x + a.width && b.x + b.width - 40 > a.x && b.y >= a.y - 10 && b.y + 40 < a.y + a.height;
  });
  if (!onScreen) w.center();
  w.show();
  w.moveTop();
  w.focus();
}
let quitting = false;

function toggle(): void {
  recorderWin?.webContents.send("lens:toggle");
}

function createRecorder(): void {
  recorderWin = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 720,
    minHeight: 520,
    x: process.env.LENS_E2E ? 0 : undefined,
    y: process.env.LENS_E2E ? 0 : undefined,
    resizable: true,
    title: "Lens Recorder",
    show: false,
    icon: appIcon(),
    backgroundColor: "#0f1115",
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), backgroundThrottling: false, contextIsolation: true, sandbox: false },
  });
  // Windows 10 2004+: keep the recorder's own window out of screen captures
  recorderWin.setContentProtection(true);
  void recorderWin.loadFile(rendererFile("recorder.html"));
  const me = recorderWin;
  // closing the recorder hides it (Lens keeps running in the tray; the tray / a second launch brings it back)
  recorderWin.on("close", (e) => {
    if (quitting || recorderWin !== me) return;
    e.preventDefault();
    me.hide();
  });
  recorderWin.on("closed", () => {
    if (recorderWin === me) recorderWin = null;
  });
}

function recycleRecorder(): void {
  if (rec || !recorderWin) return;
  const old = recorderWin;
  const bounds = old.getBounds();
  const visible = old.isVisible();
  recorderWin = null;
  old.destroy();
  createRecorder();
  recorderWin!.setBounds(bounds);
  if (visible) recorderWin!.once("ready-to-show", () => recorderWin?.show());
}

async function openEditor(dir: string): Promise<BrowserWindow> {
  if (!editor) editor = await startEditorServer();
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: `Lens — ${path.basename(dir)}`,
    icon: appIcon(),
    backgroundColor: "#0f1115",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true },
  });
  editorWindows.push(win);
  win.on("closed", () => editorWindows.splice(editorWindows.indexOf(win), 1));
  await win.loadURL(editor.urlFor(dir) + (settings.general.autoPlay ? "&autoplay=1" : ""));
  return win;
}

/**
 * Screen capture goes through getDisplayMedia (Windows #9: the legacy getUserMedia desktop capture
 * always bakes the OS cursor into the video, under Lens's own rendered cursor = two cursors).
 * The recorder names the source first (lens:capture-source); this handler hands that source to
 * Chromium without a picker, and the renderer asks for cursor: "never" (Windows Graphics Capture
 * honours it) unless "Show system cursor" is ticked.
 */
let captureSourceId: string | null = null;
let captureSystemAudio = false;
function installDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler((_req, callback) => {
    const want = captureSourceId;
    captureSourceId = null;
    desktopCapturer
      .getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })
      .then((all) => {
        const s = all.find((x) => x.id === want);
        // system audio = Windows loopback (Chromium supports it there only)
        if (s) callback(captureSystemAudio && process.platform === "win32" ? { video: s, audio: "loopback" } : { video: s });
        else callback({});
      })
      .catch(() => callback({}));
  });
}

/**
 * Custom mode (Windows #7): a frameless, transparent overlay over the chosen display; the user drags
 * the area to record (Esc cancels). Resolves with the area as fractions of the display.
 */
let regionWin: BrowserWindow | null = null;
function pickRegion(displayId?: string): Promise<{ x: number; y: number; w: number; h: number } | null> {
  regionWin?.destroy();
  const d = screen.getAllDisplays().find((x) => String(x.id) === String(displayId)) ?? screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    ...d.bounds, frame: false, transparent: true, resizable: false, movable: false, alwaysOnTop: true, skipTaskbar: true, hasShadow: false, show: false,
    title: "Lens region", webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: false },
  });
  regionWin = win;
  // the recorder steps aside while the area is dragged, and comes back with the result
  const hadRecorder = !!recorderWin?.isVisible();
  recorderWin?.hide();
  win.setContentProtection(true);
  void win.loadFile(rendererFile("region.html"));
  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });
  return new Promise((resolve) => {
    const done = (_e: unknown, r: { x: number; y: number; w: number; h: number } | null) => {
      ipcMain.removeAllListeners("lens:region-done");
      if (!win.isDestroyed()) win.destroy();
      if (regionWin === win) regionWin = null;
      if (hadRecorder) showRecorder();
      resolve(r ? { x: r.x / d.bounds.width, y: r.y / d.bounds.height, w: r.w / d.bounds.width, h: r.h / d.bounds.height } : null);
    };
    let settled = false;
    const once = (e: unknown, r: { x: number; y: number; w: number; h: number } | null) => {
      if (settled) return;
      settled = true;
      done(e, r);
    };
    ipcMain.removeAllListeners("lens:region-done");
    ipcMain.on("lens:region-done", once);
    win.on("closed", () => once(null, null));
  });
}

/** Teleprompter: an always-on-top script window kept out of the capture (setContentProtection; Windows / macOS). */
let prompterWin: BrowserWindow | null = null;
function toggleTeleprompter(): { open: boolean } {
  if (prompterWin && !prompterWin.isDestroyed()) {
    prompterWin.close();
    prompterWin = null;
    return { open: false };
  }
  const wa = screen.getPrimaryDisplay().workArea;
  prompterWin = new BrowserWindow({
    width: 520, height: 260, x: wa.x + Math.round((wa.width - 520) / 2), y: wa.y + 24, alwaysOnTop: true, title: "Lens Teleprompter", icon: appIcon(), backgroundColor: "#0f1115", autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  prompterWin.setContentProtection(true);
  void prompterWin.loadFile(rendererFile("teleprompter.html"));
  const me = prompterWin;
  me.on("closed", () => {
    if (prompterWin === me) prompterWin = null;
  });
  if (process.env.LENS_E2E) (globalThis as Record<string, unknown>).lensPrompter = me;
  return { open: true };
}

const keyLabel = (a: string) => a.replace("CommandOrControl", process.platform === "darwin" ? "Cmd" : "Ctrl");

/** Bind the global shortcuts; on failure nothing is left half-bound (the caller restores the old set). */
function registerShortcuts(s: Settings["shortcuts"]): { error: string | null } {
  globalShortcut.unregisterAll();
  const binds: Array<[keyof Settings["shortcuts"], string, () => void]> = [
    ["startStop", s.startStop, toggle],
    ["region", s.region, () => {
      showRecorder();
      recorderWin?.webContents.send("lens:mode", "region");
    }],
  ];
  for (const [name, acc, fn] of binds) {
    if (!acc) continue;
    let ok = false;
    try {
      ok = globalShortcut.register(acc, fn);
    } catch (e) {
      return { error: `${name}: "${acc}" is not a valid shortcut (${e instanceof Error ? e.message : String(e)})` };
    }
    if (!ok) return { error: `${name}: ${keyLabel(acc)} is already used by another app` };
  }
  return { error: null };
}

function applyLoginItem(): void {
  // Windows / macOS only (Electron has no login items on Linux); started hidden in the tray
  if (process.platform === "win32" || process.platform === "darwin") app.setLoginItemSettings({ openAtLogin: settings.general.autoStart, args: ["--hidden"] });
}

async function gpuSummary(): Promise<{ name: string; acceleration: string }> {
  try {
    const info = (await app.getGPUInfo("basic")) as { gpuDevice?: Array<{ active?: boolean; vendorString?: string; deviceString?: string; vendorId?: number; deviceId?: number }> };
    const devs = info.gpuDevice ?? [];
    const d = devs.find((x) => x.active) ?? devs[0];
    const name = d ? [d.vendorString, d.deviceString].filter(Boolean).join(" ") || `vendor 0x${(d.vendorId ?? 0).toString(16)} device 0x${(d.deviceId ?? 0).toString(16)}` : "unknown";
    const st = app.getGPUFeatureStatus();
    return { name, acceleration: settings.general.hardwareAcceleration ? `on (${st.gpu_compositing ?? "?"})` : "off" };
  } catch (e) {
    return { name: "unavailable", acceleration: e instanceof Error ? e.message : String(e) };
  }
}

/** Validate, apply and persist new settings. Shortcut problems are reported and nothing is changed. */
function setSettings(next: unknown): { ok: boolean; error?: string; settings: Settings; restartNeeded?: boolean } {
  const n = normalize(next, settingsDefaults());
  const clash = shortcutConflict(n.shortcuts);
  if (clash) return { ok: false, error: `${clash[0]} and ${clash[1]} use the same keys`, settings };
  if (JSON.stringify(n.shortcuts) !== JSON.stringify(settings.shortcuts)) {
    const r = registerShortcuts(n.shortcuts);
    if (r.error) {
      registerShortcuts(settings.shortcuts);
      return { ok: false, error: r.error, settings };
    }
  }
  const restartNeeded = n.general.hardwareAcceleration !== settings.general.hardwareAcceleration;
  settings = n;
  hotkey = n.shortcuts.startStop;
  applySettingsEnv();
  applyLoginItem();
  saveSettings(settingsFile(), settings);
  updateTray();
  recorderWin?.webContents.send("lens:settings", settings);
  return { ok: true, settings, restartNeeded };
}

let settingsWin: BrowserWindow | null = null;
function openSettings(): void {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 640, height: 560, title: "Lens Settings", icon: appIcon(), backgroundColor: "#0f1115", autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: false },
  });
  void settingsWin.loadFile(rendererFile("settings.html"));
  const me = settingsWin;
  me.once("ready-to-show", () => me.show());
  me.on("closed", () => {
    if (settingsWin === me) settingsWin = null;
  });
}

function registerIpc(): void {
  ipcMain.handle("lens:capture-source", (_e, id: string, opts?: { systemAudio?: boolean }) => {
    captureSourceId = id;
    captureSystemAudio = !!opts?.systemAudio;
    return { ok: true };
  });
  ipcMain.handle("lens:sources", async () => {
    const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 240, height: 135 }, fetchWindowIcons: false });
    const displays = displayGeoms();
    return sources.map((s) => {
      const kind = s.id.startsWith("screen:") ? "screen" : "window";
      const d = kind === "screen" ? displayForSource(s.display_id, s.id, displays) : null;
      const phys = d ? (d.physical ?? { width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) }) : null;
      return { id: s.id, name: s.name, kind, displayId: d ? String(d.id) : s.display_id || undefined, thumbnail: s.thumbnail.toDataURL(), size: phys ? { width: phys.width, height: phys.height } : null };
    });
  });
  ipcMain.handle("lens:status", () => ({ hotkey, hook: !!hook, hookError, recording: !!rec, recordingsDir: recordingsDir(), platform: process.platform }));
  ipcMain.handle("lens:begin", () => {
    if (rec) throw new Error("already recording");
    rec = new Recording(recordingsDir(), hook, (batch) => recorderWin?.webContents.send("lens:live", batch));
    updateTray();
    return { dir: rec.dir };
  });
  ipcMain.handle("lens:started", (_e, info: StartInfo) => {
    if (!rec) throw new Error("no recording");
    const displays = displayGeoms();
    const captured = info.kind === "screen" ? displayForSource(info.displayId, info.sourceId, displays) : null;
    rec.start({ ...info, output: { resolution: settings.export.resolution, fps: settings.export.fps } }, captured);
    if (settings.record.hideWhileRecording) recorderWin?.hide();
    return { ok: true };
  });
  ipcMain.handle("lens:settings-get", async () => ({ settings, defaults: settingsDefaults(), platform: process.platform, gpu: await gpuSummary() }));
  ipcMain.handle("lens:settings-set", (_e, next: unknown) => setSettings(next));
  ipcMain.handle("lens:settings-pick-dir", async (e, current: string) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender) ?? undefined!, { defaultPath: current, properties: ["openDirectory", "createDirectory"] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle("lens:settings-open", () => openSettings());
  ipcMain.handle("lens:history", () => listHistory(recordingsDir(), ffmpegPath()));
  ipcMain.handle("lens:history-open", async (_e, dir: string) => {
    await openEditor(dir);
  });
  ipcMain.handle("lens:history-reveal", (_e, dir: string) => shell.showItemInFolder(path.join(dir, "screen.mp4")));
  ipcMain.handle("lens:history-delete", (_e, dir: string) => deleteBundle(recordingsDir(), dir));
  ipcMain.handle("lens:import", async (_e, file?: string) => {
    let f = file;
    if (!f) {
      const r = await dialog.showOpenDialog(recorderWin ?? undefined!, { title: "Import video to create a Lens project", properties: ["openFile"], filters: [{ name: "Video", extensions: IMPORT_EXTENSIONS }] });
      if (r.canceled || !r.filePaths[0]) return null;
      f = r.filePaths[0];
    }
    const dir = await importVideo(recordingsDir(), ffmpegPath(), f);
    (globalThis as Record<string, unknown>).lensLastImport = dir;
    await openEditor(dir);
    return { dir };
  });
  ipcMain.handle("lens:pick-region", (_e, displayId?: string) => pickRegion(displayId));
  ipcMain.handle("lens:teleprompter", () => toggleTeleprompter());
  ipcMain.on("lens:chunk", (_e, kind: "video" | "audio" | "camera" | "system", data: ArrayBuffer) => rec?.chunk(kind, data));
  ipcMain.handle("lens:stop", async (_e, opts?: { stopAt?: number }) => {
    const r = rec;
    if (!r) throw new Error("not recording");
    r.stopInput(opts?.stopAt);
    rec = null;
    updateTray();
    const out = await r.finalize(ffmpegPath(), (stage) => recorderWin?.webContents.send("lens:finalizing", stage));
    if (process.env.LENS_NO_EDITOR !== "1") await openEditor(out.dir);
    const result = { ...out, warnings: r.warnings, clickSources: r.clickSources };
    (globalThis as { lensLastResult?: unknown }).lensLastResult = result;
    // The capture leaves ~450 MB of frame buffers mapped in the recorder's renderer (measured at 720p
    // under Xvfb; stopping the tracks, clearing the <video> and reloading the page do not release
    // them). A fresh recorder window (new renderer process) after each recording gives that back.
    setTimeout(() => recycleRecorder(), 1500);
    return result;
  });
  ipcMain.handle("lens:abort", () => {
    rec?.stopInput();
    rec = null;
    updateTray();
  });
  ipcMain.handle("lens:open-editor", async (_e, dir: string) => {
    await openEditor(dir);
    return { ok: true };
  });
  ipcMain.handle("lens:cursor", () => screen.getCursorScreenPoint());
  ipcMain.handle("lens:update-state", () => ({ ...updates.state, current: app.getVersion() }));
  ipcMain.handle("lens:update-check", () => updates.check());
  ipcMain.handle("lens:update-download", () => updates.download());
  ipcMain.handle("lens:update-install", () => updates.install());
}

// one Lens at a time: a second launch (Start menu / desktop shortcut while Lens is in the tray) shows
// the running recorder instead of starting a second app (Windows #6)
const firstInstance = app.requestSingleInstanceLock();
if (!firstInstance) app.quit();
app.on("second-instance", () => {
  if (app.isReady()) showRecorder();
});
app.on("before-quit", () => {
  quitting = true;
});

app.whenReady().then(async () => {
  if (!firstInstance) return;
  loadHook();
  installDisplayMediaHandler();
  registerIpc();
  createRecorder();
  if (!process.argv.includes("--hidden")) recorderWin!.once("ready-to-show", () => showRecorder());
  tray = new Tray(trayIcon());
  tray.on("click", () => showRecorder());
  tray.on("double-click", () => showRecorder());
  if (process.env.LENS_E2E) (globalThis as Record<string, unknown>).lensTray = tray;
  updateTray();
  const sc = registerShortcuts(settings.shortcuts);
  if (sc.error) console.error(`[lens] ${sc.error}`);
  applyLoginItem();
  buildAppMenu();
  updates.init();
  if (process.env.LENS_OPEN_BUNDLE) await openEditor(process.env.LENS_OPEN_BUNDLE);
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  updates.dispose();
  try {
    hook?.stop();
  } catch {
    // already stopped
  }
  editor?.close();
});

// the tray keeps the app alive with no windows on Windows / Linux
app.on("window-all-closed", () => {
  if (!tray) app.quit();
});
