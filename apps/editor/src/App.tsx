import { FileMenu, desktopFile } from "./components/FileMenu";
import { useEffect, useRef, useState } from "react";
import { Inspector } from "./components/Inspector";
import { Icon, LensMark } from "./components/Icon";
import { Preview } from "./components/Preview";
import { addZoomAtPlayhead, deleteSelection, Timeline, timelineHasFocus } from "./components/Timeline";
import { canvasHasFocus, nudgeSelected, removeCanvasSelection } from "./components/CanvasOverlay";
import { TranscriptPanel } from "./components/TranscriptPanel";
import { PrivacyPanel } from "./components/PrivacyPanel";
import { StepsPanel } from "./components/StepsPanel";
import { AnnotationToolbar } from "./components/AnnotationToolbar";
import { BrandPanel } from "./components/BrandPanel";
import { PresetsMenu } from "./components/PresetsMenu";
import { ExportDialog } from "./components/ExportDialog";
import { UpdateBanner } from "./components/UpdateBanner";
import { exportPreset, fmtBytes, privacyCounts } from "@lens/engine";
import { Transport } from "./components/Transport";
import { loadCaptionFont } from "./state/bundle";
import { store, useEditor } from "./state/store";
import { ABOUT_NOTICES } from "./about";
import { Splitter } from "./components/Splitter";
import { ui, useUi } from "./state/uiLayout";

function TopBar() {
  const name = useEditor((s) => s.bundle?.name ?? "");
  const dirty = useEditor((s) => s.dirty);
  const canUndo = useEditor((s) => s.canUndo);
  const canRedo = useEditor((s) => s.canRedo);
  const undoLabel = useEditor((s) => s.undoLabel);
  const redoLabel = useEditor((s) => s.redoLabel);
  const exportVideo = useEditor((s) => s.project.export.video);
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
      <UpdateBanner />
      <div className="top-actions">
        <FileMenu />
        <button className="icon-btn" disabled={!canUndo} title={`Undo ${undoLabel ?? ""} (⌘Z)`} aria-label="Undo" data-testid="undo" onClick={() => store.undo()}>
          <Icon name="undo" />
        </button>
        <button className="icon-btn" disabled={!canRedo} title={`Redo ${redoLabel ?? ""} (⇧⌘Z)`} aria-label="Redo" data-testid="redo" onClick={() => store.redo()}>
          <Icon name="redo" />
        </button>
        <span className="divider" />
        <PresetsMenu />
        <input ref={file} type="file" accept=".json,application/json" hidden data-testid="open-input" onChange={(e) => onFile(e.target.files?.[0])} />
        <button className="btn ghost" data-testid="open" onClick={() => file.current?.click()}>
          <Icon name="open" /> <span className="btn-label">Open</span>
        </button>
        <button className="btn ghost" data-testid="save" onClick={() => store.save()}>
          <Icon name="save" /> <span className="btn-label">Save</span>
        </button>
        <button className="btn" data-testid="export-dialog-open" title="Video, interactive demo or step guide" onClick={() => store.openExportDialog("demo")}>
          Export…
        </button>
        <ExportPresetChip />
        <button className="btn primary" data-testid="export" onClick={() => store.exportVideo()}>
          <Icon name="export" /> <span className="btn-label">Export</span> {exportPreset(exportVideo?.preset).format === "gif" ? "GIF" : "MP4"}
        </button>
        <AboutButton />
      </div>
    </header>
  );
}

function AboutButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn ghost" data-testid="about" title="About Lens and third-party notices" onClick={() => setOpen(true)}>About</button>
      {open && (
        <div className="sheet-backdrop" onClick={() => setOpen(false)}>
          <div className="sheet about-sheet" role="dialog" aria-label="About Lens" data-testid="about-sheet" onClick={(e) => e.stopPropagation()}>
            <header>
              <h2>About Lens</h2>
            </header>
            <p className="note">Everything below runs on this computer. Third-party components and their licences:</p>
            <ul className="about-list">
              {ABOUT_NOTICES.map((n) => (
                <li key={n.what}>
                  <b>{n.what}</b> <span className="stat">({n.licence})</span>
                  <br />
                  {n.credit}
                </li>
              ))}
            </ul>
            <div className="sheet-actions">
              {desktopFile && <button className="btn ghost" data-testid="open-log-folder" onClick={() => void desktopFile?.openLogFolder()}>Open log folder</button>}
              <button className="btn" onClick={() => setOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function LeftPanel() {
  const panel = useEditor((s) => s.leftPanel);
  const pending = useEditor((s) => privacyCounts(s.project).pending);
  const steps = useEditor((s) => s.project.stepLabels.drafts.filter((d) => d.state === "pending").length);
  const brandOn = useEditor((s) => (s.project.brand.enabled ? s.project.brand.colors.primary : null));
  return (
    <div className="left-col">
      <nav className="left-tabs" role="tablist">
        <button role="tab" aria-selected={panel === "transcript"} className={panel === "transcript" ? "on" : ""} data-testid="left-tab-transcript" onClick={() => store.setLeftPanel("transcript")}>
          Transcript
        </button>
        <button role="tab" aria-selected={panel === "privacy"} className={panel === "privacy" ? "on" : ""} data-testid="left-tab-privacy" onClick={() => store.setLeftPanel("privacy")}>
          <Icon name="shield" size={14} /> Privacy
          {pending > 0 && <span className="tab-badge" data-testid="pv-pending-badge">{pending}</span>}
        </button>
        <button role="tab" aria-selected={panel === "steps"} className={panel === "steps" ? "on" : ""} data-testid="left-tab-steps" onClick={() => store.setLeftPanel("steps")}>
          Steps
          {steps > 0 && <span className="tab-badge" data-testid="st-pending-badge">{steps}</span>}
        </button>
        <button role="tab" aria-selected={panel === "brand"} className={panel === "brand" ? "on" : ""} data-testid="left-tab-brand" onClick={() => store.setLeftPanel("brand")}>
          Brand
          {brandOn && <span className="tab-dot" style={{ background: brandOn }} />}
        </button>
      </nav>
      {panel === "transcript" ? <TranscriptPanel /> : panel === "privacy" ? <PrivacyPanel /> : panel === "steps" ? <StepsPanel /> : <BrandPanel />}
    </div>
  );
}

function ExportWarning() {
  const w = useEditor((s) => s.exportWarning);
  if (!w) return null;
  return (
    <div className="sheet-backdrop" onClick={() => store.closeExportWarning()}>
      <div className="sheet" role="alertdialog" aria-label="Unreviewed sensitive items" data-testid="export-warning" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Sensitive items not reviewed</h2>
        </header>
        <p className="warn-text">
          {w.pending} item{w.pending > 1 ? "s" : ""} the privacy scan found {w.pending > 1 ? "are" : "is"} still pending. Pending items are <b>not</b> hidden in the export.
        </p>
        <div className="sheet-actions">
          <button className="btn" data-testid="export-warning-review" onClick={() => store.closeExportWarning(true)}>
            <Icon name="shield" /> Review
          </button>
          <button className="btn primary" data-testid="export-warning-anyway" onClick={() => void store.exportVideo(true)}>
            <Icon name="export" /> Export anyway
          </button>
        </div>
      </div>
    </div>
  );
}

/** The platform preset in use (demand #24); opens the Export dialog's Video tab to change it. */
function ExportPresetChip() {
  const v = useEditor((s) => s.project.export.video);
  const pr = exportPreset(v?.preset);
  return (
    <button className="btn ghost preset-chip" data-testid="export-preset-open" title="Platform preset: size, frame rate, bitrate, size cap or GIF" onClick={() => store.openExportDialog("video")}>
      {v ? pr.label : "Preset: none"}
    </button>
  );
}

function ExportSheet() {
  const ex = useEditor((s) => s.exporting);
  if (!ex) return null;
  const pct = ex.total ? Math.round((ex.done / ex.total) * 100) : 0;
  const dir = new URLSearchParams(location.search).get("dir");
  const fileUrl = `/api/export/${ex.id}/file${dir ? `?dir=${encodeURIComponent(dir)}` : ""}`;
  const gif = ex.format === "gif";
  const stageText = ex.stage === "gif" ? "Making the GIF…" : ex.stage === "cap" ? "Re-encoding to fit the size cap…" : null;
  return (
    <div className="sheet-backdrop" onClick={() => ex.state !== "running" && ex.state !== "starting" && store.closeExport()}>
      <div className="sheet" role="dialog" aria-label="Export" data-testid="export-sheet" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{ex.state === "done" ? "Export ready" : ex.state === "error" ? (ex.error === "Export cancelled" ? "Export cancelled" : "Export failed") : "Exporting"}</h2>
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
            {stageText && ex.state === "running" && <p className="note" data-testid="export-stage">{stageText}</p>}
            {ex.state === "done" && ex.bytes !== undefined && (
              <p className="note" data-testid="export-result">
                {gif ? "GIF" : "MP4"}, {fmtBytes(ex.bytes)}
                {ex.cap && ex.cap.passes > 0 ? ` (was ${fmtBytes(ex.cap.before)}; re-encoded at ${ex.cap.bitrateMbps.toFixed(2)} Mbps to fit the ${fmtBytes(ex.cap.maxBytes)} cap)` : ex.cap ? ` (under the ${fmtBytes(ex.cap.maxBytes)} cap)` : ""}
              </p>
            )}
            <p className="note">{ex.path === "browser" ? "Rendered in the app by the preview renderer from the same plan, encoded with ffmpeg, with audio mixed." : "Rendered by the reference compositor (compositor/render.py) from the same plan as the preview, with audio mixed."}</p>
          </>
        )}
        {ex.state === "error" && <pre className="error" data-testid="export-error">{ex.error}</pre>}
        {(ex.state === "running" || ex.state === "starting") && (
          <div className="sheet-actions">
            <button className="btn" data-testid="export-cancel" onClick={() => void store.cancelExport()}>Cancel export</button>
          </div>
        )}
        {ex.state === "done" && (
          <div className="export-done">
            {gif ? <img src={fileUrl} alt="Exported GIF" className="export-video" data-testid="export-gif" /> : <video src={fileUrl} controls muted className="export-video" data-testid="export-video" />}
            <a className="btn primary" href={fileUrl} download={gif ? "lens-export.gif" : "lens-export.mp4"} data-testid="export-download">
              <Icon name="export" /> Download {gif ? "GIF" : "MP4"}
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
      const mod = e.metaKey || e.ctrlKey;
      const type = el?.tagName === "INPUT" ? (el as HTMLInputElement).type : "";
      // Text fields keep their own keys; a focused checkbox only keeps its plain keys (Space), so
      // undo / redo / save still work right after toggling one.
      if (el && ((el.tagName === "INPUT" && type !== "range" && !((type === "checkbox" || type === "radio") && mod)) || el.tagName === "SELECT" || el.tagName === "TEXTAREA")) return;
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
      // Ctrl/Cmd+A with the timeline focused: select every block on every lane
      if (mod && k.toLowerCase() === "a" && timelineHasFocus()) {
        e.preventDefault();
        store.selectAll();
        return;
      }
      if (mod) return;
      // Alt+Arrow with a 3D block selected (also from its sliders): turn the selected keyframe 5
      // degrees: Up/Down about X, Left/Right about Y, Alt+Shift+Left/Right about Z
      if (e.altKey && k.startsWith("Arrow")) {
        const sign = k === "ArrowRight" || k === "ArrowUp" ? 1 : -1;
        const axis = k === "ArrowUp" || k === "ArrowDown" ? "rx" : e.shiftKey ? "rz" : "ry";
        if (store.nudgeMotion3d(axis, 5 * sign)) {
          e.preventDefault();
          return;
        }
      }
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
        case "ArrowRight":
        case "ArrowUp":
        case "ArrowDown": {
          e.preventDefault();
          const n = e.shiftKey ? 10 : 1;
          // timeline focused with blocks selected: Left/Right nudge them a frame (Shift: 1 s), one undo step
          if ((k === "ArrowLeft" || k === "ArrowRight") && timelineHasFocus() && (store.get().multi.length || store.get().selection)) {
            store.nudge(k === "ArrowLeft" ? -1 : 1, e.shiftKey);
            break;
          }
          // a canvas object picked on the preview: nudge it (output px); else step frames
          if (canvasHasFocus()) {
            const dx = k === "ArrowLeft" ? -n : k === "ArrowRight" ? n : 0;
            const dy = k === "ArrowUp" ? -n : k === "ArrowDown" ? n : 0;
            if (nudgeSelected(dx, dy)) break;
          }
          if (k === "ArrowLeft") store.step(-n);
          else if (k === "ArrowRight") store.step(n);
          break;
        }
        case "z":
        case "Z":
          e.preventDefault();
          addZoomAtPlayhead();
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
          // a 3D keyframe chip / timeline diamond has focus: Delete removes that keyframe, not the block
          const keyEl = (el as HTMLElement | null)?.closest?.("[data-m3d-key]") as HTMLElement | null;
          if (keyEl) {
            store.selectMotion3dKey(Number(keyEl.dataset.m3dKey));
            if (store.deleteSelectedMotion3dKey()) break;
          }
          if (deleteSelection()) break;
          if (removeCanvasSelection()) break;
          const sel = store.get().selectedWords;
          if (sel.length) store.deleteWords(sel);
          break;
        }
        case "f":
        case "F":
          e.preventDefault();
          ui.toggleFullscreen();
          break;
        case "Escape":
          if (ui.get().fullscreen) ui.setFullscreen(false);
          store.setZoomPlacing(false);
          store.selectCanvas(null);
          store.select(null);
          store.selectWords([]);
          store.setTool("select");
          break;
        case "v":
        case "V":
          store.setTool("select");
          break;
        case "a":
        case "A":
          store.setTool("arrow");
          break;
        case "b":
        case "B":
          store.setTool("rect");
          break;
        case "e":
        case "E":
          store.setTool("ellipse");
          break;
        case "t":
        case "T":
          store.setTool("text");
          break;
        case "c":
        case "C":
          store.setTool("callout");
          break;
        case "n":
        case "N":
          store.setTool("badge");
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
  const L = useUi((s) => s);
  useKeys();
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    void loadCaptionFont()
      .then(() => store.load(q.get("dir") ?? undefined))
      // desktop Settings > "Auto-play when entering the editor" (Windows #19)
      .then(() => {
        if (q.get("autoplay") === "1" && store.get().status === "ready") store.play();
      });
  }, []);
  return (
    <div
      className={`app ${L.fullscreen ? "preview-fs" : ""} ${L.leftOpen ? "" : "left-closed"} ${L.rightOpen ? "" : "right-closed"}`}
      data-status={status}
      data-fullscreen={L.fullscreen ? "1" : "0"}
      style={{ ["--left-w" as string]: `${L.leftOpen ? L.leftW : 0}px`, ["--right-w" as string]: `${L.rightOpen ? L.rightW : 0}px`, ["--tl-h" as string]: `${L.tlH}px` }}
    >
      <TopBar />
      {status === "error" && <div className="banner error" data-testid="load-error">Could not open the recording: {error}</div>}
      {status !== "ready" ? (
        // nothing of the project is shown until the bundle has loaded: no empty 00:00.01 project, no "no microphone track"
        <main className="workspace loading" data-testid="loading">
          <div className="loading-card">{status === "loading" ? <><span className="spinner" /> Opening the recording…</> : "The recording could not be opened. The reason is above; the log folder is in About."}</div>
        </main>
      ) : (
      <>
      <main className="workspace">
        {L.leftOpen ? <LeftPanel /> : <div className="panel-stub" />}
        <Splitter kind="left" />
        <section className="center" data-testid="stage">
          <AnnotationToolbar />
          <Preview />
          <Transport />
        </section>
        <Splitter kind="right" />
        {L.rightOpen ? <Inspector /> : <div className="panel-stub" />}
      </main>
      <Splitter kind="timeline" />
      <Timeline />
      </>
      )}
      <ExportSheet />
      <ExportDialog />
      <ExportWarning />
      <Toast />
    </div>
  );
}
