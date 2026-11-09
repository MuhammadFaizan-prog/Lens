/**
 * Export dialog (demand #7): format tabs (Video / Interactive demo / Step guide), a live preview of
 * the exported demo in an iframe, and a hotspot editor: drag a step's hotspot on its still and edit
 * its tooltip text. Hotspot and tooltip edits are project data (project.demo.hotspots, one undo step
 * each) and reach the preview at once through postMessage; call-to-action and step changes need a
 * rebuild (the preview says so).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { demoSteps, type DemoStep } from "@lens/engine";
import { store, useEditor } from "../state/store";
import { Icon } from "./Icon";

interface DemoJson {
  image: { width: number; height: number };
  steps: Array<{ n: number; stepId: string; image: string; width: number; height: number; map: [number, number, number, number] }>;
}

type Tab = "video" | "demo" | "guide";

export function ExportDialog() {
  const dlg = useEditor((s) => s.exportDialog);
  if (!dlg) return null;
  return (
    <div className="sheet-backdrop" onClick={() => store.closeExportDialog()}>
      <div className="sheet export-dialog" role="dialog" aria-label="Export" data-testid="export-dialog" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Export</h2>
          <button className="icon-btn" aria-label="Close" data-testid="export-dialog-close" onClick={() => store.closeExportDialog()}>
            <Icon name="close" />
          </button>
        </header>
        <nav className="ex-tabs" role="tablist">
          {(
            [
              ["video", "Video"],
              ["demo", "Interactive demo"],
              ["guide", "Step guide"],
            ] as Array<[Tab, string]>
          ).map(([t, label]) => (
            <button key={t} role="tab" aria-selected={dlg.tab === t} className={dlg.tab === t ? "on" : ""} data-testid={`export-tab-${t}`} onClick={() => store.setExportTab(t)}>
              {label}
            </button>
          ))}
        </nav>
        {dlg.tab === "video" ? <VideoTab /> : dlg.tab === "demo" ? <DemoTab /> : <GuideTab />}
      </div>
    </div>
  );
}

function VideoTab() {
  const frames = useEditor((s) => s.plan?.frames.length ?? 0);
  const out = useEditor((s) => s.plan?.output);
  return (
    <div className="ex-body">
      <p className="note">
        MP4 (H.264) with every edit, zoom, caption and mask{out ? `: ${out.width}×${out.height}, ${out.fps} fps, ${frames} frames` : ""}.
      </p>
      <div className="sheet-actions">
        <button className="btn primary" data-testid="export-video-go" onClick={() => { store.closeExportDialog(); void store.exportVideo(); }}>
          <Icon name="export" /> Export MP4
        </button>
      </div>
    </div>
  );
}

function useAccepted(): DemoStep[] {
  const steps = useEditor((s) => s.project.stepLabels);
  const demo = useEditor((s) => s.project.demo);
  return useMemo(() => demoSteps({ stepLabels: steps, demo }), [steps, demo]);
}

function NoSteps() {
  return (
    <p className="note" data-testid="export-no-steps">
      No accepted steps yet. Open the <b>Steps</b> panel, generate step labels from the clicks and accept the ones to show.{" "}
      <button className="btn ghost" onClick={() => { store.closeExportDialog(); store.setLeftPanel("steps"); }}>Open Steps</button>
    </p>
  );
}

function BuildButton({ kind }: { kind: "demo" | "guide" }) {
  const run = useEditor((s) => s.stepsExport[kind]);
  const busy = !!run && (run.state === "starting" || run.state === "running");
  return (
    <button className="btn primary" disabled={busy} data-testid={`export-build-${kind}`} onClick={() => void store.buildStepsExport(kind)}>
      <Icon name="export" /> {busy ? "Building…" : run?.state === "done" ? "Rebuild" : kind === "demo" ? "Build demo" : "Build guide"}
    </button>
  );
}

function DemoTab() {
  const steps = useAccepted();
  const run = useEditor((s) => s.stepsExport.demo);
  const project = useEditor((s) => s.project);
  const cta = project.demo.cta;
  const [sel, setSel] = useState(0);
  const [meta, setMeta] = useState<DemoJson | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const url = run?.state === "done" ? store.stepsExportUrl("demo", "index.html") : null;
  const stale = run?.state === "done" && run.builtFrom !== JSON.stringify({ steps: project.stepLabels, demo: { ...project.demo, hotspots: [] } });

  useEffect(() => {
    setMeta(null);
    const u = run?.state === "done" ? store.stepsExportUrl("demo", "demo.json") : null;
    if (!u) return;
    let off = false;
    void fetch(u).then((r) => r.json()).then((j: DemoJson) => !off && setMeta(j));
    return () => {
      off = true;
    };
  }, [run?.state, run?.id]);

  // live: push hotspot positions and tooltips into the preview iframe
  const live = useMemo(() => {
    if (!meta) return null;
    return steps.map((s) => {
      const m = meta.steps.find((x) => x.stepId === s.stepId);
      if (!m) return null;
      const [ax, kx, ay, ky] = m.map;
      return { fx: (ax + kx * s.x + 0.5) / m.width, fy: (ay + ky * s.y + 0.5) / m.height, label: s.label };
    });
  }, [meta, steps]);
  const post = (msg: unknown) => frame.current?.contentWindow?.postMessage(msg, "*");
  useEffect(() => {
    if (live) post({ type: "lens-demo:set", steps: live });
  }, [live]);
  useEffect(() => {
    if (meta) post({ type: "lens-demo:go", index: sel });
  }, [sel, meta]);

  if (!steps.length) return <div className="ex-body"><NoSteps /></div>;
  const cur = steps[Math.min(sel, steps.length - 1)]!;
  const setCta = (label: string, patch: Partial<typeof cta>) => store.editDemo(label, (d) => ({ ...d, cta: { ...d.cta, ...patch } }), true);
  return (
    <div className="ex-body ex-demo">
      <div className="ex-cols">
        <aside className="ex-steps">
          <h3>Steps</h3>
          <ol>
            {steps.map((s, i) => (
              <li key={s.stepId}>
                <button className={i === sel ? "on" : ""} data-testid="export-step" onClick={() => setSel(i)}>
                  <span className="num">{s.n}</span>
                  <span className="lbl">{s.label}</span>
                </button>
              </li>
            ))}
          </ol>
          <h3>Call to action</h3>
          <label className="field">Title<input data-testid="cta-title" value={cta.title} onChange={(e) => setCta("Demo CTA title", { title: e.target.value })} /></label>
          <label className="field">Text<input data-testid="cta-text" value={cta.text} onChange={(e) => setCta("Demo CTA text", { text: e.target.value })} /></label>
          <label className="field">Button<input data-testid="cta-button" value={cta.buttonLabel} onChange={(e) => setCta("Demo CTA button", { buttonLabel: e.target.value })} /></label>
          <label className="field">Link<input data-testid="cta-url" placeholder="https://" value={cta.url} onChange={(e) => setCta("Demo CTA link", { url: e.target.value.trim() })} /></label>
        </aside>
        <section className="ex-main">
          <div className="ex-toolbar">
            <BuildButton kind="demo" />
            {run?.state === "error" && <span className="error" data-testid="export-demo-error">{run.error}</span>}
            {stale && <span className="stat" data-testid="export-demo-stale">Steps or call to action changed — rebuild to update the preview</span>}
            {url && (
              <a className="btn ghost" href={url} download="interactive-demo.html" data-testid="export-demo-download">
                Download HTML
              </a>
            )}
          </div>
          {url ? (
            <iframe ref={frame} className="ex-frame" title="Interactive demo preview" data-testid="export-demo-frame" src={`${url}#lens-preview`}
              onLoad={() => { if (live) post({ type: "lens-demo:set", steps: live }); post({ type: "lens-demo:go", index: sel }); }} />
          ) : (
            <div className="ex-frame empty">{run && run.state !== "error" ? "Rendering stills…" : "Build the demo to preview it here."}</div>
          )}
          {meta && <HotspotEditor step={cur} meta={meta} />}
        </section>
      </div>
    </div>
  );
}

function HotspotEditor({ step, meta }: { step: DemoStep; meta: DemoJson }) {
  const m = meta.steps.find((x) => x.stepId === step.stepId);
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [text, setText] = useState(step.label);
  useEffect(() => setText(step.label), [step.stepId, step.label]);
  if (!m) return <p className="note">This step is not in the last build; rebuild the demo.</p>;
  const [ax, kx, ay, ky] = m.map;
  const src = store.stepsExportUrl("demo", m.image)!;
  const pos = drag ?? { x: step.x, y: step.y };
  const fx = (ax + kx * pos.x + 0.5) / m.width;
  const fy = (ay + ky * pos.y + 0.5) / m.height;
  const toSource = (e: { clientX: number; clientY: number }) => {
    const r = box.current!.getBoundingClientRect();
    const ix = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * m.width - 0.5;
    const iy = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) * m.height - 0.5;
    return { x: Math.round(((ix - ax) / kx) * 10) / 10, y: Math.round(((iy - ay) / ky) * 10) / 10 };
  };
  const commitText = () => {
    const t = text.trim();
    if (t === step.label) return;
    store.setHotspot(step.stepId, { tooltip: t || null }, "Edit tooltip");
  };
  return (
    <div className="hs-editor" data-testid="hotspot-editor">
      <div className="hs-head">
        <b>Step {step.n}</b>
        <span className="stat">drag the hotspot onto the control</span>
        <button className="btn ghost" data-testid="hotspot-reset" onClick={() => store.setHotspot(step.stepId, null, "Reset hotspot")}>Reset</button>
      </div>
      <div className="hs-stage" ref={box} style={{ aspectRatio: `${m.width} / ${m.height}` }} data-testid="hotspot-stage"
        onPointerMove={(e) => drag && setDrag(toSource(e))}
        onPointerUp={(e) => {
          if (!drag) return;
          const p = toSource(e);
          setDrag(null);
          store.setHotspot(step.stepId, p);
        }}>
        <img src={src} alt={`Step ${step.n} still`} draggable={false} />
        <button className="hs-dot" data-testid="hotspot-handle" aria-label="Hotspot" style={{ left: `${fx * 100}%`, top: `${fy * 100}%` }}
          onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); box.current?.setPointerCapture?.(e.pointerId); setDrag({ x: step.x, y: step.y }); }} />
      </div>
      <label className="field">
        Tooltip
        <input data-testid="hotspot-tooltip" value={text} onChange={(e) => setText(e.target.value)} onBlur={commitText}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
      </label>
    </div>
  );
}

function GuideTab() {
  const steps = useAccepted();
  const run = useEditor((s) => s.stepsExport.guide);
  if (!steps.length) return <div className="ex-body"><NoSteps /></div>;
  const html = store.stepsExportUrl("guide", "guide.html");
  return (
    <div className="ex-body">
      <p className="note">Numbered steps with a cropped screenshot, a highlight box around each click and the step label: Markdown, HTML and PDF ({steps.length} steps).</p>
      <div className="ex-toolbar">
        <BuildButton kind="guide" />
        {run?.state === "error" && <span className="error">{run.error}</span>}
        {html && (
          <>
            <a className="btn ghost" data-testid="guide-pdf" href={store.stepsExportUrl("guide", "guide.pdf")!} download="step-guide.pdf">PDF</a>
            <a className="btn ghost" data-testid="guide-md" href={store.stepsExportUrl("guide", "guide.md")!} download="step-guide.md">Markdown</a>
            <a className="btn ghost" href={html} download="step-guide.html">HTML</a>
          </>
        )}
      </div>
      {html ? <iframe className="ex-frame" title="Step guide preview" data-testid="guide-frame" src={html} /> : <div className="ex-frame empty">Build the guide to preview it here.</div>}
    </div>
  );
}
