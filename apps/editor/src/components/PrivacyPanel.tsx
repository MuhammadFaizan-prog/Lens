import { PRIVACY_LABELS, PRIVACY_TYPES, privacyCounts } from "@lens/engine";
import type { PrivacyDetection, PrivacyType } from "@lens/engine";
import { store, useEditor } from "../state/store";
import { timecode } from "../state/timelineOps";
import { Icon } from "./Icon";

/**
 * Automatic privacy redaction (demand #3): run the on-device scan, review what it found grouped by
 * type, accept (hide) or dismiss items one at a time or all at once. Accepted items are tracked blur
 * or pixelate masks in the Masks lane; every review step is one undo step.
 */
function thumbUrl(name: string): string {
  const d = new URLSearchParams(location.search).get("dir");
  return `/api/privacy/thumb/${encodeURIComponent(name)}${d ? `?dir=${encodeURIComponent(d)}` : ""}`;
}

const STAGES: Record<string, string> = { start: "Starting", analyse: "Reading frames", ocr: "Reading text (OCR)", track: "Following text", cached: "Cached" };

function Item({ d, fps }: { d: PrivacyDetection; fps: number }) {
  const shown = d.tracks.length;
  return (
    <li className={`pv-item ${d.state}`} data-testid={`pv-item-${d.id}`} data-state={d.state}>
      <button className="pv-main" onClick={() => store.showDetection(d.id)} title="Show it in the preview" data-testid={`pv-show-${d.id}`}>
        {d.thumb ? <img className="pv-thumb" src={thumbUrl(d.thumb)} alt="" loading="lazy" /> : <span className="pv-thumb none" />}
        <span className="pv-text">
          <span className="pv-preview mono">{d.preview}</span>
          <span className="pv-meta">
            {timecode(d.firstMs, fps)}
            {shown > 1 ? ` · seen ${shown}×` : ""}
            {d.state !== "pending" && <b className={`pv-badge ${d.state}`}>{d.state === "accepted" ? "hidden" : "dismissed"}</b>}
          </span>
        </span>
      </button>
      <span className="pv-actions">
        {d.state === "pending" ? (
          <>
            <button className="icon-btn ok" title="Hide it (blur)" aria-label={`Hide ${d.preview}`} data-testid={`pv-accept-${d.id}`} onClick={() => store.reviewPrivacy([d.id], "accepted")}>
              <Icon name="check" />
            </button>
            <button className="icon-btn danger" title="Not sensitive: dismiss" aria-label={`Dismiss ${d.preview}`} data-testid={`pv-dismiss-${d.id}`} onClick={() => store.reviewPrivacy([d.id], "dismissed")}>
              <Icon name="close" />
            </button>
          </>
        ) : (
          <button className="icon-btn" title="Back to the review list" aria-label={`Review ${d.preview} again`} data-testid={`pv-reset-${d.id}`} onClick={() => store.reviewPrivacy([d.id], "pending")}>
            <Icon name="restore" />
          </button>
        )}
      </span>
    </li>
  );
}

export function PrivacyPanel() {
  const privacy = useEditor((s) => s.project.privacy);
  const scan = useEditor((s) => s.privacyScan);
  const fps = useEditor((s) => s.plan?.output.fps ?? 30);
  const counts = privacyCounts({ privacy });
  const running = scan && (scan.state === "starting" || scan.state === "running");
  const pct = scan && scan.total ? Math.round((scan.done / scan.total) * 100) : 0;
  const groups = PRIVACY_TYPES.map((t) => ({ t, items: privacy.detections.filter((d) => d.type === t) })).filter((g) => g.items.length);

  return (
    <aside className="transcript privacy" data-testid="privacy-panel">
      <header className="tr-head">
        <h2>Privacy</h2>
        <span className="stat" data-testid="pv-count">
          {privacy.scannedAt || counts.total ? `${counts.total} found · ${counts.pending} to review` : "not scanned"}
        </span>
      </header>
      <div className="pv-scan">
        <button className="btn primary pv-scan-btn" disabled={!!running} data-testid="pv-scan" onClick={() => void store.scanPrivacy(!!privacy.scannedAt)}>
          <Icon name="sparkle" /> {running ? "Scanning…" : privacy.scannedAt ? "Scan again" : "Scan for sensitive info"}
        </button>
        {running && (
          <div className="pv-progress" data-testid="pv-progress">
            <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div style={{ width: `${pct}%` }} />
            </div>
            <span className="stat">{STAGES[scan!.stage] ?? "Reading text"}{scan!.total ? ` · ${pct}%` : ""}</span>
          </div>
        )}
        {scan?.state === "error" && <pre className="error" data-testid="pv-error">{scan.error}</pre>}
        <p className="note">Emails, phone and card numbers, API keys, tokens, JWTs, IP addresses and notification banners, found on this machine with OCR. Nothing leaves it.</p>
      </div>
      {counts.total > 0 && (
        <div className="tr-actions pv-bulk">
          <button className="chip-btn accent" disabled={!counts.pending} data-testid="pv-accept-all" onClick={() => store.reviewPrivacy(privacy.detections.filter((d) => d.state === "pending").map((d) => d.id), "accepted")}>
            <Icon name="check" /> Hide all {counts.pending || ""}
          </button>
          <button className="chip-btn" disabled={!counts.pending} data-testid="pv-dismiss-all" onClick={() => store.reviewPrivacy(privacy.detections.filter((d) => d.state === "pending").map((d) => d.id), "dismissed")}>
            Dismiss all
          </button>
          <div className="pv-kind-row">
            <span className="stat">Hide with</span>
          <div className="segmented pv-kind" role="radiogroup" aria-label="How to hide">
            {(["blur", "pixelate"] as const).map((k) => (
              <button key={k} role="radio" aria-checked={privacy.maskKind === k} className={privacy.maskKind === k ? "on" : ""} data-testid={`pv-kind-${k}`} onClick={() => store.setPrivacyMaskKind(k)}>
                {k === "blur" ? "Blur" : "Pixelate"}
              </button>
            ))}
          </div>
          </div>
        </div>
      )}
      <div className="pv-list" data-testid="pv-list">
        {groups.map((g) => (
          <section key={g.t} className="pv-group" data-testid={`pv-group-${g.t}`}>
            <h3>
              {PRIVACY_LABELS[g.t as PrivacyType]} <span className="stat">{g.items.length}</span>
            </h3>
            <ul>
              {g.items.map((d) => (
                <Item key={d.id} d={d} fps={fps} />
              ))}
            </ul>
          </section>
        ))}
        {privacy.scannedAt && !counts.total && <p className="note pv-empty">Nothing sensitive found.</p>}
      </div>
      <p className="tr-hint">Hidden items are tracked masks in the Masks lane; they follow scrolling and zooms. ⌘Z undoes any step.</p>
    </aside>
  );
}
