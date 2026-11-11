/**
 * Share tab (demand #13): bring-your-own storage (S3, Cloudflare R2, Supabase Storage, any
 * S3-compatible service) and one button that uploads the export, a poster and a viewer page and
 * copies the link. The keys are typed here once and kept by Lens outside the project (OS keychain on
 * the desktop); the form never shows them again, only the last 4 characters of the key ID.
 */
import { useEffect, useState } from "react";
import { store, useEditor } from "../state/store";
import { PROVIDERS, viewerChapters, type ShareProvider, type ShareSettings } from "../state/share";
import { Section, Toggle } from "./Controls";

const field = { display: "grid", gap: 3, fontSize: 12, color: "var(--text-2)", marginBottom: 8 } as const;
const input = { background: "var(--panel-2)", border: "1px solid var(--line-2)", borderRadius: 7, color: "var(--text)", padding: "6px 8px", font: "inherit", minWidth: 0 } as const;

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label style={field} title={hint}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function ShareTab() {
  const share = useEditor((s) => s.share);
  const name = useEditor((s) => s.bundle?.name ?? "");
  const exporting = useEditor((s) => s.exporting);
  const project = useEditor((s) => s.project);
  const plan = useEditor((s) => s.plan);
  const cfg = share.config;
  const [edit, setEdit] = useState(false);
  const [title, setTitle] = useState("");
  useEffect(() => {
    if (!cfg) void store.loadShareConfig();
  }, [cfg]);
  useEffect(() => setTitle((t) => t || name.replace(/\.lens$/i, "")), [name]);
  if (!cfg) return <p className="note" style={{ padding: 12 }}>Loading…</p>;
  const showForm = edit || !cfg.configured;
  const chapters = viewerChapters(project, plan);
  const job = share.job;
  const pct = job && job.total ? Math.min(100, Math.round((job.sent / job.total) * 100)) : 0;
  const stage =
    share.busy === "export" ? `Exporting… ${exporting?.total ? Math.round(((exporting.done ?? 0) / exporting.total) * 100) : 0}%`
    : share.busy === "upload" ? `${job?.stage ?? "Uploading"}… ${pct}%`
    : null;
  return (
    <>
      <Section title="Share link" aside={cfg.configured ? <span className="stat">{PROVIDERS[cfg.settings.provider].label}</span> : undefined}>
        {!cfg.configured ? (
          <p className="note">Connect your own storage below to get a link: the video, a poster and a small player page go to your bucket. Nothing goes to Lens servers.</p>
        ) : (
          <>
            <Field label="Title">
              <input style={input} data-testid="share-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Recording title" />
            </Field>
            <p className="note" data-testid="share-chapters">
              {chapters.length ? `${chapters.length} chapter${chapters.length === 1 ? "" : "s"} on the player page.` : "No chapters in this project."}{" "}
              Exports the video first unless this version was already exported.
            </p>
            <div className="sheet-actions" style={{ justifyContent: "flex-start", marginTop: 8 }}>
              <button className="btn primary" data-testid="share-go" disabled={!!share.busy} onClick={() => void store.shareLink(title.trim() || name)}>
                {share.busy === "export" || share.busy === "upload" ? "Sharing…" : "Upload & copy link"}
              </button>
            </div>
            {stage && (
              <div data-testid="share-progress" style={{ marginTop: 8 }}>
                <div className="note">{stage}</div>
                <div style={{ height: 4, background: "var(--line-2)", borderRadius: 2, marginTop: 4 }}>
                  <div style={{ height: 4, width: `${share.busy === "upload" ? pct : 0}%`, background: "var(--accent)", borderRadius: 2 }} />
                </div>
              </div>
            )}
            {job?.state === "done" && job.url && (
              <div style={{ marginTop: 10 }}>
                <Field label={share.copied ? "Link (copied)" : "Link"}>
                  <input style={input} readOnly data-testid="share-url" value={job.url} onFocus={(e) => e.currentTarget.select()} />
                </Field>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn small" data-testid="share-copy" onClick={() => void store.copyShareLink()}>Copy</button>
                  <a className="btn small ghost" data-testid="share-open" href={job.url} target="_blank" rel="noreferrer">Open</a>
                </div>
                {!cfg.settings.publicBaseUrl && <p className="note">Private bucket: the link is presigned and stops working after {cfg.settings.linkDays} day{cfg.settings.linkDays === 1 ? "" : "s"}.</p>}
              </div>
            )}
          </>
        )}
        {share.error && <p className="note warn" data-testid="share-error">{share.error}</p>}
      </Section>
      <Section title="Storage" aside={cfg.configured && !showForm ? <button className="btn small ghost" data-testid="share-edit" onClick={() => setEdit(true)}>Edit</button> : undefined}>
        {showForm ? (
          <StorageForm key={JSON.stringify(cfg.settings)} onDone={() => setEdit(false)} />
        ) : (
          <>
            <p className="note" data-testid="share-summary">
              {cfg.settings.bucket} at {cfg.settings.endpoint}
              {cfg.settings.publicBaseUrl ? ` · public URL ${cfg.settings.publicBaseUrl}` : " · presigned links"} · key {cfg.keyHint}
            </p>
            <p className="note">{cfg.storage.kind === "os-keychain" ? "Keys are encrypted with your system keychain." : "Keys are kept in a local file only your user can read."} They are never saved in projects.</p>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="btn small" data-testid="share-test" disabled={!!share.busy} onClick={() => void store.testShareConfig()}>{share.busy === "test" ? "Testing…" : "Test connection"}</button>
              <button className="btn small ghost" data-testid="share-forget" disabled={!!share.busy} onClick={() => void store.forgetShareConfig()}>Forget storage</button>
            </div>
            {share.tested && <p className="note" data-testid="share-test-ok">Connection works: Lens can write to this bucket.</p>}
          </>
        )}
      </Section>
    </>
  );
}

function StorageForm({ onDone }: { onDone: () => void }) {
  const cfg = useEditor((s) => s.share.config)!;
  const busy = useEditor((s) => s.share.busy);
  const [s, setS] = useState<ShareSettings>(cfg.settings);
  const [akid, setAkid] = useState("");
  const [secret, setSecret] = useState("");
  const p = PROVIDERS[s.provider];
  const pick = (provider: ShareProvider) => setS((x) => ({ ...x, provider, region: PROVIDERS[provider].region, pathStyle: PROVIDERS[provider].pathStyle }));
  const set = <K extends keyof ShareSettings>(k: K, v: ShareSettings[K]) => setS((x) => ({ ...x, [k]: v }));
  return (
    <form
      data-testid="share-form"
      autoComplete="off"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await store.saveShareConfig(s, { accessKeyId: akid, secretAccessKey: secret })) {
          setAkid("");
          setSecret("");
          onDone();
        }
      }}
    >
      <Field label="Provider">
        <select style={{ width: "100%" }} data-testid="share-provider" value={s.provider} onChange={(e) => pick(e.target.value as ShareProvider)}>
          {(Object.keys(PROVIDERS) as ShareProvider[]).map((k) => (
            <option key={k} value={k}>{PROVIDERS[k].label}</option>
          ))}
        </select>
      </Field>
      <p className="note" style={{ marginBottom: 8 }}>{p.note}</p>
      <Field label="Endpoint">
        <input style={input} data-testid="share-endpoint" value={s.endpoint} placeholder={p.endpointHint} onChange={(e) => set("endpoint", e.target.value)} />
      </Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <Field label="Bucket">
          <input style={input} data-testid="share-bucket" value={s.bucket} onChange={(e) => set("bucket", e.target.value)} />
        </Field>
        <Field label="Region">
          <input style={input} data-testid="share-region" value={s.region} onChange={(e) => set("region", e.target.value)} />
        </Field>
      </div>
      <Field label={`Access key ID${cfg.keyHint ? ` (saved ${cfg.keyHint}; blank keeps it)` : ""}`}>
        <input style={input} data-testid="share-akid" value={akid} autoComplete="off" spellCheck={false} onChange={(e) => setAkid(e.target.value)} />
      </Field>
      <Field label={`Secret access key${cfg.hasSecret ? " (saved; blank keeps it)" : ""}`}>
        <input style={input} type="password" data-testid="share-secret" value={secret} autoComplete="new-password" spellCheck={false} onChange={(e) => setSecret(e.target.value)} />
      </Field>
      <Field label="Public URL (optional)" hint="Where the bucket is served publicly. Empty: presigned links that expire.">
        <input style={input} data-testid="share-public" value={s.publicBaseUrl} placeholder={p.publicHint} onChange={(e) => set("publicBaseUrl", e.target.value)} />
      </Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <Field label="Folder in bucket">
          <input style={input} data-testid="share-prefix" value={s.prefix} onChange={(e) => set("prefix", e.target.value)} />
        </Field>
        <Field label="Link lifetime (days, private)">
          <input style={input} type="number" min={1} max={7} data-testid="share-days" value={s.linkDays} disabled={!!s.publicBaseUrl} onChange={(e) => set("linkDays", Number(e.target.value))} />
        </Field>
      </div>
      <Toggle label="Path-style addressing" hint="endpoint/bucket/key (R2, Supabase, MinIO). Off: bucket.endpoint/key (AWS default)." value={s.pathStyle} testId="share-pathstyle" onChange={(v) => set("pathStyle", v)} />
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button className="btn primary small" type="submit" data-testid="share-save" disabled={!!busy}>{busy === "save" ? "Saving…" : "Save"}</button>
        {cfg.configured && <button className="btn small ghost" type="button" data-testid="share-cancel" onClick={onDone}>Cancel</button>}
      </div>
      <p className="note">
        {cfg.storage.kind === "os-keychain" ? "Keys are encrypted with your system keychain" : `Keys are saved in ${cfg.storage.path} (readable only by you)`}, never in the project.
      </p>
    </form>
  );
}
