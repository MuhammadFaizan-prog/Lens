// Editor windows (Windows #21): the update state and actions, so the editor header can show the
// "Update available" banner. Nothing else from the desktop app is exposed to the editor page.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("lensUpdates", {
  state: () => ipcRenderer.invoke("lens:update-state"),
  check: () => ipcRenderer.invoke("lens:update-check"),
  download: () => ipcRenderer.invoke("lens:update-download"),
  install: () => ipcRenderer.invoke("lens:update-install"),
  onUpdate: (fn: (s: unknown) => void) => ipcRenderer.on("lens:update", (_e, s) => fn(s)),
});
