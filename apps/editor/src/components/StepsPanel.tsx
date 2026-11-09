import { useState } from "react";
import type { StepDraft } from "@lens/engine";
import { store, useEditor } from "../state/store";
import { timecode } from "../state/timelineOps";
import { Icon } from "./Icon";

/**
 * Auto step labels (demand #4): draft "Click Save" / "Open Settings" labels from the clicks plus
 * on-device OCR around each click, review and edit them, and accept them as numbered badges
 * (1, 2, 3 in click order) next to each click. Every review step is one undo step.
 */
function Row({ d, n, fps }: { d: StepDraft; n: number | null; fps: number }) {
  const [val, setVal] = useState(d.label);
  const [prev, setPrev] = useState(d.label);
  if (d.label !== prev) {
    setPrev(d.label);
    setVal(d.label);
  }
  const commit = () => {
    const v = val.trim();
    if (v && v !== d.label) store.editStepLabel(d.id, v);
    else setVal(d.label);
  };
  return (
    <li className={`st-item ${d.state}`} data-testid={`st-item-${d.id}`} data-state={d.state}>
      <button className="st-num" title="Show the click" data-testid={`st-show-${d.id}`} onClick={() => { store.pause(); store.seekSource(d.clickMs); }}>
        {n ?? "·"}
      </button>
      <span className="st-body">
        <input
          className="st-label"
          value={val}
          aria-label={`Label for the click at ${timecode(d.clickMs, fps)}`}
          data-testid={`st-label-${d.id}`}
          onChange={(e) => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setVal(d.label);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        <span className="pv-meta">
          {timecode(d.clickMs, fps)} · {d.target ? `read “${d.target}”` : "no text near the click"}
          {d.confidence < 0.6 && <b className="pv-badge low"> check</b>}
        </span>
      </span>
      <span className="pv-actions">
        {d.state === "pending" ? (
          <>
            <button className="icon-btn ok" title="Accept as a numbered badge" aria-label={`Accept ${d.label}`} data-testid={`st-accept-${d.id}`} onClick={() => store.reviewSteps([d.id], "accepted")}>
              <Icon name="check" />
            </button>
            <button className="icon-btn danger" title="Dismiss" aria-label={`Dismiss ${d.label}`} data-testid={`st-dismiss-${d.id}`} onClick={() => store.reviewSteps([d.id], "dismissed")}>
              <Icon name="close" />
            </button>
          </>
        ) : (
          <button className="icon-btn" title="Back to review" aria-label={`Review ${d.label} again`} data-testid={`st-reset-${d.id}`} onClick={() => store.reviewSteps([d.id], "pending")}>
            <Icon name="restore" />
          </button>
        )}
      </span>
    </li>
  );
}

export function StepsPanel() {
  const steps = useEditor((s) => s.project.stepLabels);
  const run = useEditor((s) => s.stepRun);
  const fps = useEditor((s) => s.plan?.output.fps ?? 30);
  const running = run && (run.state === "starting" || run.state === "running");
  const drafts = steps.drafts;
  const pending = drafts.filter((d) => d.state === "pending");
  const accepted = drafts.filter((d) => d.state === "accepted").sort((a, b) => a.clickMs - b.clickMs);
  const num = new Map(accepted.map((d, i) => [d.id, i + 1]));
  return (
    <aside className="transcript steps" data-testid="steps-panel">
      <header className="tr-head">
        <h2>Step labels</h2>
        <span className="stat" data-testid="st-count">
          {steps.generatedAt ? `${drafts.length} clicks · ${pending.length} to review` : "not generated"}
        </span>
      </header>
      <div className="pv-scan">
        <button className="btn primary pv-scan-btn" disabled={!!running} data-testid="st-generate" onClick={() => void store.generateSteps()}>
          <Icon name="sparkle" /> {running ? "Reading clicks…" : steps.generatedAt ? "Generate again" : "Generate step labels"}
        </button>
        {run?.state === "error" && <pre className="error" data-testid="st-error">{run.error}</pre>}
        <p className="note">One draft per click, from the text OCR reads around it on this machine. Accepted steps become badges numbered 1, 2, 3 in click order.</p>
      </div>
      {drafts.length > 0 && (
        <div className="tr-actions pv-bulk">
          <button className="chip-btn accent" disabled={!pending.length} data-testid="st-accept-all" onClick={() => store.reviewSteps(pending.map((d) => d.id), "accepted")}>
            <Icon name="check" /> Accept all {pending.length || ""}
          </button>
          <button className="chip-btn" disabled={!pending.length} data-testid="st-dismiss-all" onClick={() => store.reviewSteps(pending.map((d) => d.id), "dismissed")}>
            Dismiss all
          </button>
        </div>
      )}
      <ul className="st-list" data-testid="st-list">
        {drafts.map((d) => (
          <Row key={d.id} d={d} n={num.get(d.id) ?? null} fps={fps} />
        ))}
      </ul>
      <p className="tr-hint">Edit a label before or after accepting it; the badge follows. ⌘Z undoes any step.</p>
    </aside>
  );
}
