/**
 * Editor File menu (desktop app only; Windows report 2026-11-09: no way to import a video from inside
 * the editor): Import Video…, History…, New Recording. The same desktop calls as the recorder's File
 * menu, through the editor preload (window.lensDesktopFile). An imported video opens in a new editor
 * window (this one keeps its project); History > Open does the same.
 */
import { useEffect, useState } from "react";

interface HistoryItem { dir: string; name: string; createdMs: number; durationMs: number | null; imported: boolean; thumbnail: string | null }
interface DesktopFile {
  importVideo(file?: string): Promise<{ dir: string; video: string } | { cancelled: true } | null>;
  importCancel(): Promise<boolean>;
  onImportProgress(fn: (p: { pct: number; phase: string }) => void): void;
  history(): Promise<HistoryItem[]>;
  historyOpen(dir: string): Promise<void>;
  newRecording(): Promise<void>;
  openLogFolder(): Promise<void>;
}
export const desktopFile = (globalThis as { lensDesktopFile?: DesktopFile }).lensDesktopFile ?? null;

const fmt = (ms: number | null) => (ms == null ? "?" : `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}`);
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");

let listening = false;
const progressSubs = new Set<(p: { pct: number; phase: string }) => void>();

export function FileMenu() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<HistoryItem[] | null>(null);
  useEffect(() => {
    if (!desktopFile) return;
    if (!listening) {
      listening = true;
      desktopFile.onImportProgress((p) => progressSubs.forEach((f) => f(p)));
    }
    const sub = (p: { pct: number; phase: string }) => setStatus(p.phase === "probe" ? "Importing… reading the file" : `Importing… ${p.pct}%`);
    progressSubs.add(sub);
    const close = () => setOpen(false);
    document.addEventListener("click", close);
    return () => {
      progressSubs.delete(sub);
      document.removeEventListener("click", close);
    };
  }, []);
  if (!desktopFile) return null;
  const importVideo = async (file?: string) => {
    setOpen(false);
    setBusy(true);
    setStatus("Importing…");
    try {
      const r = await desktopFile!.importVideo(file);
      setStatus(r && "cancelled" in r ? "Import cancelled" : r ? "Imported: opened in a new window" : null);
      return r;
    } catch (e) {
      setStatus(`Import failed: ${reason(e)}`);
      return null;
    } finally {
      setBusy(false);
    }
  };
  // automation hook (packaged e2e passes the path; the native picker is skipped)
  (window as unknown as { __lensFile?: unknown }).__lensFile = { importVideo, status: () => status };
  return (
    <div className="file-menu-wrap" onClick={(e) => e.stopPropagation()}>
      <button className="btn ghost" data-testid="editor-file-menu" aria-haspopup="true" onClick={() => setOpen(!open)}>File ▾</button>
      {open && (
        <div className="file-menu" role="menu" data-testid="editor-file-items">
          <button role="menuitem" data-testid="editor-import" disabled={busy} onClick={() => void importVideo()}>Import Video…</button>
          <button role="menuitem" data-testid="editor-history" onClick={() => { setOpen(false); void desktopFile!.history().then(setHistory); }}>History…</button>
          <button role="menuitem" data-testid="editor-new-recording" onClick={() => { setOpen(false); void desktopFile!.newRecording(); }}>New Recording</button>
        </div>
      )}
      {status && (
        <span className="file-status" data-testid="editor-file-status">
          {status}
          {busy && <button className="btn ghost" data-testid="editor-import-cancel" onClick={() => void desktopFile!.importCancel()}>Cancel</button>}
          {!busy && <button className="btn ghost" aria-label="Dismiss" onClick={() => setStatus(null)}>×</button>}
        </span>
      )}
      {history && (
        <div className="sheet-backdrop" onClick={() => setHistory(null)}>
          <div className="sheet history-sheet" role="dialog" aria-label="History" data-testid="editor-history-sheet" onClick={(e) => e.stopPropagation()}>
            <header><h2>History</h2></header>
            {!history.length && <p className="note">No recordings yet.</p>}
            <ul className="history-list">
              {history.map((it) => (
                <li key={it.dir} data-testid="editor-history-item" data-dir={it.dir}>
                  {it.thumbnail ? <img src={it.thumbnail} alt="" /> : <span className="noimg" />}
                  <span className="meta"><b>{it.name.replace(/^Lens-/, "")}{it.imported ? " (imported)" : ""}</b><br />{new Date(it.createdMs).toLocaleString()} · {fmt(it.durationMs)}</span>
                  <button className="btn" onClick={() => { setHistory(null); void desktopFile!.historyOpen(it.dir); }}>Open</button>
                </li>
              ))}
            </ul>
            <div className="sheet-actions"><button className="btn" onClick={() => setHistory(null)}>Close</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
