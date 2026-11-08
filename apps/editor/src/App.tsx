import { useEffect, useRef } from "react";
import { Inspector } from "./components/Inspector";
import { Icon, LensMark } from "./components/Icon";
import { Preview } from "./components/Preview";
import { deleteSelection, Timeline } from "./components/Timeline";
import { TranscriptPanel } from "./components/TranscriptPanel";
import { Transport } from "./components/Transport";
import { loadCaptionFont } from "./state/bundle";
import { store, useEditor } from "./state/store";

function TopBar() {
  const name = useEditor((s) => s.bundle?.name ?? "");
  const dirty = useEditor((s) => s.dirty);
  const canUndo = useEditor((s) => s.canUndo);
  const canRedo = useEditor((s) => s.canRedo);
  const undoLabel = useEditor((s) => s.undoLabel);
  const redoLabel = useEditor((s) => s.redoLabel);
  const file = useRef<HTMLInputElement>(null);
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      store.openProject(JSON.parse(await f.text()), f.name);
    } catch (e) {
      store.notify(`Could not open ${f.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (file.current) file.current.value = "";
  };
  return (
    <header className="topbar">
      <div className="brand">
        <LensMark />
        <span className="wordmark">Lens</span>
        <span className="crumb">/</span>
        <span className="doc-name" data-testid="doc-name">
          {name || "…"}
          {dirty && <i className="dirty-dot" title="Unsaved changes" />}
        </span>
      </div>
      <div className="top-actions">
        <button className="icon-btn" disabled={!canUndo} title={`Undo ${undoLabel ?? ""} (⌘Z)`} aria-label="Undo" data-testid="undo" onClick={() => store.undo()}>
          <Icon name="undo" />
        </button>
        <button className="icon-btn" disabled={!canRedo} title={`Redo ${redoLabel ?? ""} (⇧⌘Z)`} aria-label="Redo" data-testid="redo" onClick={() => store.redo()}>
          <Icon name="redo" />
        </button>
        <span className="divider" />
        <input ref={file} type="file" accept=".json,application/json" hidden data-testid="open-input" onChange={(e) => onFile(e.target.files?.[0])} />
        <button className="btn ghost" data-testid="open" onClick={() => file.current?.click()}>
          <Icon name="open" /> Open
        </button>
        <button className="btn ghost" data-testid="save" onClick={() => store.save()}>
          <Icon name="save" /> Save
        </button>
        <button className="btn primary" data-testid="export" onClick={() => store.exportVideo()}>
          <Icon name="export" /> Export MP4
        </button>
      </div>
    </header>
  );
}

function ExportSheet() {
  const ex = useEditor((s) => s.exporting);
  if (!ex) return null;
  const pct = ex.total ? Math.round((ex.done / ex.total) * 100) : 0;
  const dir = new URLSearchParams(location.search).get("dir");
  const fileUrl = `/api/export/${ex.id}/file${dir ? `?dir=${encodeURIComponent(dir)}` : ""}`;
  return (
    <div className="sheet-backdrop" onClick={() => store.closeExport()}>
      <div className="sheet" role="dialog" aria-label="Export" data-testid="export-sheet" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{ex.state === "done" ? "Export ready" : ex.state === "error" ? "Export failed" : "Exporting"}</h2>
          {ex.state !== "running" && (
            <button className="icon-btn" aria-label="Close" onClick={() => store.closeExport()}>
              <Icon name="close" />
            </button>
          )}
        </header>
        {ex.state !== "error" && (
          <>
            <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} data-testid="export-progress">
              <div style={{ width: `${pct}%` }} />
            </div>
            <div className="progress-meta">
              <span>{ex.state === "done" ? "100%" : `${pct}%`}</span>
              <span>
                frame {ex.done} / {ex.total}
                {ex.seconds ? ` · ${ex.seconds.toFixed(1)} s` : ""}
              </span>
            </div>
            <p className="note">Rendered by the reference compositor (compositor/render.py) from the same plan as the preview, with audio mixed.</p>
          </>
        )}
        {ex.state === "error" && <pre className="error" data-testid="export-error">{ex.error}</pre>}
        {ex.state === "done" && (
          <div className="export-done">
            <video src={fileUrl} controls muted className="export-video" data-testid="export-video" />
            <a className="btn primary" href={fileUrl} download="lens-export.mp4" data-testid="export-download">
              <Icon name="export" /> Download MP4
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

function Toast() {
  const toast = useEditor((s) => s.toast);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!toast || !ref.current) return;
    const el = ref.current;
    el.classList.remove("show");
    void el.offsetWidth;
    el.classList.add("show");
    const t = setTimeout(() => el.classList.remove("show"), 2600);
    return () => clearTimeout(t);
  }, [toast]);
  return (
    <div className="toast" ref={ref} role="status" data-testid="toast">
      {toast?.text}
    </div>
  );
}

function useKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el && (el.tagName === "INPUT" && (el as HTMLInputElement).type !== "range" || el.tagName === "SELECT" || el.tagName === "TEXTAREA")) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key;
      if (mod && k.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if (mod && k.toLowerCase() === "y") {
        e.preventDefault();
        store.redo();
        return;
      }
      if (mod && k.toLowerCase() === "s") {
        e.preventDefault();
        void store.save();
        return;
      }
      if (mod) return;
      if (el?.tagName === "INPUT") return; // sliders keep arrow keys
      switch (k) {
        case " ":
          e.preventDefault();
          store.toggle();
          break;
        case "j":
        case "J":
          store.shuttle(-1);
          break;
        case "k":
        case "K":
          store.shuttle(0);
          break;
        case "l":
        case "L":
          store.shuttle(1);
          break;
        case "ArrowLeft":
          e.preventDefault();
          store.step(e.shiftKey ? -10 : -1);
          break;
        case "ArrowRight":
          e.preventDefault();
          store.step(e.shiftKey ? 10 : 1);
          break;
        case "Home":
          store.step(-1e9);
          break;
        case "End":
          store.step(1e9);
          break;
        case "Delete":
        case "Backspace": {
          e.preventDefault();
          if (deleteSelection()) break;
          const sel = store.get().selectedWords;
          if (sel.length) store.deleteWords(sel);
          break;
        }
        case "Escape":
          store.select(null);
          store.selectWords([]);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function App() {
  const status = useEditor((s) => s.status);
  const error = useEditor((s) => s.error);
  useKeys();
  useEffect(() => {
    void loadCaptionFont().then(() => store.load(new URLSearchParams(location.search).get("dir") ?? undefined));
  }, []);
  return (
    <div className="app" data-status={status}>
      <TopBar />
      {status === "error" && <div className="banner error">Could not open the recording: {error}</div>}
      <main className="workspace">
        <TranscriptPanel />
        <section className="center">
          <Preview />
          <Transport />
        </section>
        <Inspector />
      </main>
      <Timeline />
      <ExportSheet />
      <Toast />
    </div>
  );
}
