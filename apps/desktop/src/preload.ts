/** The recorder window's bridge to the main process (contextIsolation on). */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("lensDesktop", {
  sources: () => ipcRenderer.invoke("lens:sources"),
  status: () => ipcRenderer.invoke("lens:status"),
  begin: () => ipcRenderer.invoke("lens:begin"),
  started: (info: unknown) => ipcRenderer.invoke("lens:started", info),
  chunk: (kind: "video" | "audio", data: ArrayBuffer) => ipcRenderer.send("lens:chunk", kind, data),
  stop: (opts?: { stopAt?: number }) => ipcRenderer.invoke("lens:stop", opts),
  abort: () => ipcRenderer.invoke("lens:abort"),
  openEditor: (dir: string) => ipcRenderer.invoke("lens:open-editor", dir),
  onToggle: (fn: () => void) => ipcRenderer.on("lens:toggle", () => fn()),
  onLive: (fn: (b: unknown) => void) => ipcRenderer.on("lens:live", (_e, b) => fn(b)),
  updateState: () => ipcRenderer.invoke("lens:update-state"),
  updateCheck: () => ipcRenderer.invoke("lens:update-check"),
  updateDownload: () => ipcRenderer.invoke("lens:update-download"),
  updateInstall: () => ipcRenderer.invoke("lens:update-install"),
  onUpdate: (fn: (s: unknown) => void) => ipcRenderer.on("lens:update", (_e, s) => fn(s)),
  onFinalizing: (fn: (stage: string) => void) => ipcRenderer.on("lens:finalizing", (_e, s) => fn(s)),
});
