// Editor windows (Windows #21): the update state and actions, so the editor header can show the
// "Update available" banner; and the File menu (Import Video, History, New Recording, Open log folder),
// the same desktop calls as the recorder's File menu, plus the font Open dialog. Nothing else is exposed to the editor page.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("lensUpdates", {
  state: () => ipcRenderer.invoke("lens:update-state"),
  check: () => ipcRenderer.invoke("lens:update-check"),
  download: () => ipcRenderer.invoke("lens:update-download"),
  install: () => ipcRenderer.invoke("lens:update-install"),
  onUpdate: (fn: (s: unknown) => void) => ipcRenderer.on("lens:update", (_e, s) => fn(s)),
});

contextBridge.exposeInMainWorld("lensDesktopFile", {
  importVideo: (file?: string) => ipcRenderer.invoke("lens:import", file),
  importCancel: () => ipcRenderer.invoke("lens:import-cancel"),
  onImportProgress: (fn: (p: unknown) => void) => ipcRenderer.on("lens:import-progress", (_e, p) => fn(p)),
  history: () => ipcRenderer.invoke("lens:history"),
  historyOpen: (dir: string) => ipcRenderer.invoke("lens:history-open", dir),
  newRecording: () => ipcRenderer.invoke("lens:show-recorder"),
  openLogFolder: () => ipcRenderer.invoke("lens:open-log-folder"),
  // caption font import: native Open dialog (.ttf / .otf / .woff / .woff2), returns up to two paths
  pickFonts: (): Promise<string[]> => ipcRenderer.invoke("lens:pick-fonts"),
});
