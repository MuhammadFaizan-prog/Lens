/**
 * Export dialog (demand #7): format tabs (Video / Interactive demo / Step guide), a live preview of
 * the exported demo in an iframe, and a hotspot editor: drag a step's hotspot on its still and edit
 * its tooltip text. Hotspot and tooltip edits are project data (project.demo.hotspots, one undo step
 * each) and reach the preview at once through postMessage; call-to-action and step changes need a
 * rebuild (the preview says so). The Video tab picks a platform preset (demand #24, docs/ExportPresets.md):
 * size, frame rate, bitrate, size cap or GIF, with warnings against the platform's limits.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { buildRenderPlan, demoSteps, FRAMING_MODES, projectForTarget, type DemoStep, type FramingMode } from "@lens/engine";
import { encodeSettings, estimateBytes, EXPORT_PRESETS, exportChecks, exportPreset, fmtBytes } from "@lens/engine";
import { FRAMING_LABELS } from "../state/layoutOps";
import { store, useEditor, type ExportTab } from "../state/store";
import { ChaptersTab } from "./ChaptersTab";
import { Icon } from "./Icon";

interface DemoJson {
  image: { width: number; height: number };
  steps: Array<{ n: number; stepId: string; image: string; width: number; height: number; map: [number, number, number, number] }>;
}

type Tab = ExportTab;

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
              ["chapters", "Title & chapters"],
            ] as Array<[Tab, string]>
          ).map(([t, label]) => (
            <button key={t} role="tab" aria-selected={dlg.tab === t} className={dlg.tab === t ? "on" : ""} data-testid={`export-tab-${t}`} onClick={() => store.setExportTab(t)}>
              {label}
            </button>
          ))}
        </nav>
        {dlg.tab === "video" ? <VideoTab /> : dlg.tab === "demo" ? <DemoTab /> : dlg.tab === "guide" ? <GuideTab /> : <ChaptersTab />}
      </div>
    </div>
  );
}

/** Video tab: platform preset picker (demand #24), its overrides and the checks against its limits. */
function VideoTab() {
  const frames = useEditor((s) => s.plan?.frames.length ?? 0);
  const out = useEditor((s) => s.plan?.output);
  const hasAudio = useEditor((s) => !!s.plan?.audio);
  const project = useEditor((s) => s.project);
  const v = project.export.video;
  const pr = exportPreset(v?.preset ?? "custom");
  const enc = encodeSettings(project);
  const checks = out ? exportChecks(project, out, hasAudio) : [];
  const est = out ? estimateBytes(out.durationMs, enc, hasAudio) : null;
  const gif = pr.format === "gif";
  const groups = [...new Set(EXPORT_PRESETS.map((p) => p.group))];
  const targets = useEditor((s) => s.project.exportTargets);
  const enabled = targets?.items.filter((t) => t.enabled).length ?? 0;
  return (
    <div className="ex-body ex-video">
      <label className="field">
        Preset
        <select data-testid="export-preset" value={v?.preset ?? "custom"}
          onChange={(e) => { const p = exportPreset(e.target.value); store.setExportPreset(p.id, p.label); }}>
          {groups.map((g) => (
            <optgroup key={g} label={g}>
              {EXPORT_PRESETS.filter((p) => p.group === g).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </optgroup>
          ))}
        </select>
      </label>
      <p className="note" data-testid="export-preset-note">{pr.note}</p>
      <p className="note" data-testid="export-output">
        {gif ? "Animated GIF" : "MP4 (H.264)"} with every edit, zoom, caption and mask
        {out ? `: ${gif ? `${enc.gif.width} px wide, ${enc.gif.fps} fps` : `${out.width}×${out.height}, ${out.fps} fps`}, ${(out.durationMs / 1000).toFixed(1)} s, ${frames} frames` : ""}.
      </p>
      {gif ? (
        <div className="ex-grid">
          <label className="field">Frame rate (fps)
            <NumInput testId="export-gif-fps" value={enc.gif.fps} min={1} max={50} step={1} onCommit={(n) => n !== null && store.setExportGif("GIF frame rate", { fps: Math.round(n) })} />
          </label>
          <label className="field">Width (px)
            <NumInput testId="export-gif-width" value={enc.gif.width} min={16} max={3840} step={2} onCommit={(n) => n !== null && store.setExportGif("GIF width", { width: Math.round(n / 2) * 2 })} />
          </label>
          <label className="field check">
            <input type="checkbox" data-testid="export-gif-loop" checked={enc.gif.loop} onChange={(e) => store.setExportGif("GIF loop", { loop: e.target.checked })} /> Loop forever
          </label>
        </div>
      ) : (
        <div className="ex-grid">
          <label className="field">Bitrate (Mbps)
            <NumInput testId="export-bitrate" value={v?.bitrateMbps ?? null} placeholder={pr.bitrateMbps ? `${pr.bitrateMbps} (preset)` : "auto (crf 18)"} min={0.1} max={200} step={0.5}
              onCommit={(n) => store.setExportVideo("Export bitrate", { bitrateMbps: n })} />
          </label>
          <label className="field">Size cap (MB)
            <NumInput testId="export-size-cap" value={v?.maxSizeMB ?? null} placeholder={pr.maxSizeMB ? `${pr.maxSizeMB} (preset)` : "none"} min={0.1} max={100000} step={1}
              onCommit={(n) => store.setExportVideo("Export size cap", { maxSizeMB: n })} />
          </label>
          <div className="field">Estimated size
            <span className="stat" data-testid="export-estimate">{est !== null ? `up to ≈ ${fmtBytes(est)}${enc.maxBytes ? ` (cap ${fmtBytes(enc.maxBytes)})` : ""}` : enc.maxBytes ? `depends on content (cap ${fmtBytes(enc.maxBytes)})` : "depends on content"}</span>
          </div>
        </div>
      )}
      {checks.length > 0 && (
        <ul className="ex-checks" data-testid="export-checks">
          {checks.map((c) => <li key={c.code} className={c.level === "warn" ? "note warn" : "note"} data-testid={`export-check-${c.code}`}>{c.text}</li>)}
        </ul>
      )}
      <SizesSection />
      <div className="sheet-actions">
        <button className={`btn ${targets ? "" : "primary"}`} data-testid="export-video-go" onClick={() => { store.closeExportDialog(); void store.exportVideo(); }}>
          <Icon name="export" /> Export {gif ? "GIF" : "MP4"}{targets ? ` (${targets.items.find((t) => t.id === targets.active)?.aspect ?? "shown"} only)` : ""}
        </button>
        {targets && (
          <button className="btn primary" data-testid="export-batch-go" disabled={!enabled} onClick={() => { store.closeExportDialog(); void store.exportAllTargets(); }}>
            <Icon name="export" /> Export {enabled} {enabled === 1 ? "size" : "sizes"}
          </button>
        )}
      </div>
    </div>
  );
}

/** A number box that commits on blur / Enter; empty = null (the preset's value). */
function NumInput({ value, onCommit, testId, placeholder, min, max, step }: { value: number | null; onCommit: (n: number | null) => void; testId: string; placeholder?: string; min: number; max: number; step: number }) {
  const [text, setText] = useState(value === null ? "" : String(value));
  useEffect(() => setText(value === null ? "" : String(value)), [value]);
  const commit = () => {
    const t = text.trim();
    if (t === "") return value === null ? undefined : onCommit(null);
    const n = Number(t);
    if (!Number.isFinite(n)) return setText(value === null ? "" : String(value));
    const c = Math.min(max, Math.max(min, n));
    if (c !== value) onCommit(c);
    else setText(String(c));
  };
  return (
    <input type="number" inputMode="decimal" data-testid={testId} value={text} placeholder={placeholder} min={min} max={max} step={step}
      onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
  );
}

/**
 * Several sizes from one recording (demand #15, docs/MultiAspect.md): one row per shape with its own
 * framing; Show makes it the size the preview, the toolbar and Look > Output edit (its Custom window
 * and crop keyframes too); every ticked size is exported in one batch.
 */
function SizesSection() {
  const targets = useEditor((s) => s.project.exportTargets);
  const bundle = useEditor((s) => s.bundle);
  const project = useEditor((s) => s.project);
  const sizes = useMemo(() => {
    if (!bundle || !targets) return {} as Record<string, string>;
    const r: Record<string, string> = {};
    for (const t of targets.items) {
      const o = buildRenderPlan({ meta: bundle.meta, events: bundle.events, project: projectForTarget(project, t.id), onlyFrames: [0] }).output;
      r[t.id] = `${o.width}×${o.height}`;
    }
    return r;
  }, [bundle, targets, project]);
  if (!targets?.items.length)
    return (
      <div className="ex-sizes" data-testid="export-sizes">
        <p className="note">Need a vertical or square cut too? Lens can export 16:9, 9:16, 1:1 and 4:5 from this project in one go, each framed on its own.</p>
        <button className="btn ghost" data-testid="sizes-enable" onClick={() => store.enableExportTargets()}>Several sizes…</button>
      </div>
    );
  return (
    <div className="ex-sizes" data-testid="export-sizes">
      <div className="ex-sizes-head">
        <span className="ctl-label">Sizes</span>
        <button className="btn ghost small" data-testid="sizes-disable" title="Back to one size (the one shown)" onClick={() => store.disableExportTargets()}>One size</button>
      </div>
      <ul className="ex-size-list">
        {targets.items.map((t) => {
          const shown = t.id === targets.active;
          const framing = shown ? (project.output.framing ?? (project.output.fit === "fill" ? "follow" : "fit")) : t.framing;
          const keys = shown ? project.output.framingKeys?.length ?? 0 : t.framingKeys?.length ?? 0;
          const tid = t.aspect.replace(":", "x");
          return (
            <li key={t.id} className={shown ? "on" : ""} data-testid={`size-${tid}`}>
              <label className="ex-size-on">
                <input type="checkbox" checked={t.enabled} data-testid={`size-enabled-${tid}`} onChange={(e) => store.setExportTargetEnabled(t.id, e.target.checked)} />
                <b>{t.aspect}</b>
                <span className="stat">{sizes[t.id] ?? ""}</span>
              </label>
              <select className="tb-select" value={framing} aria-label={`${t.aspect} framing`} data-testid={`size-framing-${tid}`} onChange={(e) => store.setExportTargetFraming(t.id, e.target.value as FramingMode)}>
                {FRAMING_MODES.map((m) => <option key={m} value={m}>{FRAMING_LABELS[m]}</option>)}
              </select>
              {keys > 0 && <span className="stat" data-testid={`size-keys-${tid}`}>{keys} keys</span>}
              {shown ? (
                <span className="chip-btn on" data-testid={`size-shown-${tid}`}>Shown</span>
              ) : (
                <button className="chip-btn" data-testid={`size-show-${tid}`} title="Preview and frame this size (Look > Output edits it)" onClick={() => { store.showExportTarget(t.id); store.closeExportDialog(); }}>Show</button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="note">Follow keeps the cursor and zoom target in the frame; Custom shows a window you place (Look &gt; Output), with keyframes to move it over time.</p>
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
