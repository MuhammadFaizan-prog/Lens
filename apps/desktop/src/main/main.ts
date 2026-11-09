/**
 * Lens desktop (Electron). The recorder window (pick a screen or window, mic toggle, Start / Stop,
 * live auto-zoom preview), a global hotkey (Ctrl+Shift+R), a tray icon, the recording session
 * (recording.ts) and the bundled editor (editorServer.ts), opened on the new project after Stop.
 * See docs/Desktop.md.
 */
import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, Menu, nativeImage, screen, Tray } from "electron";
import path from "node:path";
import { displayForSource } from "../shared/coords";
import { startEditorServer, type EditorServer } from "./editorServer";
import { ffmpegPath, recordingsDir, rendererFile } from "./paths";
import { displayGeoms, Recording, setKeyTable, type Hook, type StartInfo } from "./recording";
import { UpdateController, type UpdateState } from "./updater";

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
    tray.setToolTip(recording ? "Lens: recording (Ctrl+Shift+R to stop)" : "Lens: ready (Ctrl+Shift+R to record)");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: recording ? "Stop recording" : "Start recording", accelerator: HOTKEY, click: () => toggle() },
      { label: "Show recorder", click: () => showRecorder() },
      { label: updateLabel(updates.state), enabled: updates.state.status !== "disabled", click: () => updateAction() },
      { type: "separator" },
      { label: "Quit Lens", click: () => app.quit() },
    ]),
  );
}

function showRecorder(): void {
  if (!recorderWin) createRecorder();
  recorderWin!.show();
  recorderWin!.focus();
}

function toggle(): void {
  recorderWin?.webContents.send("lens:toggle");
}

function createRecorder(): void {
  recorderWin = new BrowserWindow({
    width: 420,
    height: 560,
    x: process.env.LENS_E2E ? 0 : undefined,
    y: process.env.LENS_E2E ? 0 : undefined,
    resizable: true,
    title: "Lens Recorder",
    icon: appIcon(),
    backgroundColor: "#0f1115",
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), backgroundThrottling: false, contextIsolation: true, sandbox: false },
  });
  // Windows 10 2004+: keep the recorder's own window out of screen captures
  recorderWin.setContentProtection(true);
  void recorderWin.loadFile(rendererFile("recorder.html"));
  const me = recorderWin;
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
  if (!visible) recorderWin!.hide();
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
  await win.loadURL(editor.urlFor(dir));
  return win;
}

function registerIpc(): void {
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
  ipcMain.handle("lens:status", () => ({ hotkey: HOTKEY, hook: !!hook, hookError, recording: !!rec, recordingsDir: recordingsDir(), platform: process.platform }));
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
    rec.start(info, captured);
    return { ok: true };
  });
  ipcMain.on("lens:chunk", (_e, kind: "video" | "audio", data: ArrayBuffer) => rec?.chunk(kind, data));
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

app.whenReady().then(async () => {
  loadHook();
  registerIpc();
  createRecorder();
  tray = new Tray(trayIcon());
  tray.on("click", () => showRecorder());
  updateTray();
  if (!globalShortcut.register(HOTKEY, toggle)) console.error(`[lens] could not register ${HOTKEY}`);
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
