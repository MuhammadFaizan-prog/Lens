/**
 * Export > Title & chapters (demand #27, docs/Chapters.md): draft a title, a description and chapters
 * from the transcript on this device (engine chapters.ts, no model, no network), edit them, copy them,
 * and export the chapters as a YouTube list, a WebVTT chapters file and chapter markers in the MP4.
 */
import { useEffect, useMemo, useState } from "react";
import { chaptersVtt, youtubeChapterIssues, youtubeChapterList, ytTime } from "@lens/engine";
import { store, useEditor } from "../state/store";
import { frameForSource } from "../state/timelineOps";
import { Icon } from "./Icon";

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // no clipboard permission (http, some webviews): select-and-copy fallback
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  store.notify(`${what} copied`);
}

function download(name: string, text: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Text box that edits live (one undo step per pause) and keeps the cursor while typing. */
function LiveText({ value, onChange, testId, rows, placeholder, max }: { value: string; onChange: (v: string) => void; testId: string; rows?: number; placeholder?: string; max: number }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const props = { value: v, placeholder, maxLength: max, "data-testid": testId, onChange: (e: { target: { value: string } }) => { setV(e.target.value); onChange(e.target.value); } };
  return rows ? <textarea rows={rows} {...props} /> : <input {...props} />;
}

export function ChaptersTab() {
  const ch = useEditor((s) => s.project.chapters);
  const hasWords = useEditor((s) => (s.bundle?.transcript?.words.length ?? 0) > 0);
  const plan = useEditor((s) => s.plan);
  const frame = useEditor((s) => s.frame);
  const out = plan?.chapters?.items;
  const dur = plan?.output.durationMs ?? 0;
  const texts = useMemo(() => (out && out.length ? { youtube: youtubeChapterList(out, dur), vtt: chaptersVtt(out, dur), issues: youtubeChapterIssues(out, dur) } : null), [out, dur]);
  // a chapter's start on the exported video (null: inside a cut, it moves to where the video resumes)
  const outOf = (srcMs: number): number | null => {
    if (!plan || plan.cuts.some((c) => srcMs >= c.startMs && srcMs < c.endMs)) return null;
    return (frameForSource(plan, srcMs) * 1000) / plan.output.fps;
  };
  return (
    <div className="ex-body ex-chapters">
      <div className="ex-toolbar">
        <button className="btn primary" data-testid="chapters-generate" disabled={!hasWords} onClick={() => store.generateChapters()}>
          <Icon name="sparkle" /> {ch?.items.length ? "Draft again from transcript" : "Draft from transcript"}
        </button>
        <span className="stat">On this device: no model download, nothing leaves the computer.</span>
      </div>
      {!hasWords && (
        <p className="note warn" data-testid="chapters-no-transcript">
          No transcript yet. Transcribe the recording first.{" "}
          <button className="btn ghost" onClick={() => { store.closeExportDialog(); store.setLeftPanel("transcript"); }}>Open Transcript</button>
        </p>
      )}
      {ch && (
        <>
          <label className="field">
            <span className="field-head">Title <span className="stat">{ch.title.length} / 100</span>
              <button className="btn ghost small" data-testid="chapters-copy-title" onClick={() => void copy(ch.title, "Title")}>Copy</button></span>
            <LiveText testId="chapters-title" value={ch.title} max={100} placeholder="Video title" onChange={(t) => store.editChapters("Edit title", (c) => ({ ...c, title: t }), true)} />
          </label>
          <label className="field">
            <span className="field-head">Description
              <button className="btn ghost small" data-testid="chapters-copy-description" onClick={() => void copy(texts ? `${ch.description}\n\n${texts.youtube}` : ch.description, "Description with chapters")}>Copy with chapters</button></span>
            <LiveText testId="chapters-description" rows={4} value={ch.description} max={5000} placeholder="Description" onChange={(t) => store.editChapters("Edit description", (c) => ({ ...c, description: t }), true)} />
          </label>
          <div className="field-head">
            <b>Chapters</b>
            <span className="stat">start · title (times on the exported video)</span>
            <button className="btn ghost small" data-testid="chapters-add" onClick={() => store.addChapterAtPlayhead()}>+ At playhead ({ytTime((frame * 1000) / (plan?.output.fps ?? 30))})</button>
          </div>
          <ol className="ch-list" data-testid="chapters-list">
            {ch.items.map((it, i) => {
              const o = outOf(it.srcMs);
              return (
                <li key={it.id} data-testid="chapter-row">
                  <button className="ch-time" title="Go to this chapter" data-testid="chapter-seek" onClick={() => store.seekSource(it.srcMs)}>
                    {o === null ? "in a cut" : ytTime(i === 0 ? 0 : o, dur >= 3_600_000)}
                  </button>
                  <LiveText testId="chapter-title" value={it.title} max={100} onChange={(t) => store.editChapters("Edit chapter title", (c) => ({ ...c, items: c.items.map((x) => (x.id === it.id ? { ...x, title: t } : x)) }), true)} />
                  <button className="btn ghost small" title="Move the start to the playhead" data-testid="chapter-move" onClick={() => store.setChapterStartAtPlayhead(it.id)}>Set start</button>
                  <button className="icon-btn" aria-label="Remove chapter" data-testid="chapter-remove" onClick={() => store.removeChapter(it.id)}><Icon name="close" /></button>
                </li>
              );
            })}
          </ol>
          {texts && texts.issues.length > 0 && (
            <ul className="ex-checks" data-testid="chapters-issues">{texts.issues.map((t) => <li key={t} className="note warn">{t}</li>)}</ul>
          )}
          {texts && (
            <>
              <label className="field">
                <span className="field-head">YouTube chapters
                  <button className="btn ghost small" data-testid="chapters-copy-youtube" onClick={() => void copy(texts.youtube, "YouTube chapters")}>Copy</button>
                  <button className="btn ghost small" data-testid="chapters-download-txt" onClick={() => download("chapters.txt", texts.youtube + "\n")}>.txt</button>
                  <button className="btn ghost small" data-testid="chapters-download-vtt" onClick={() => download("chapters.vtt", texts.vtt, "text/vtt")}>WebVTT</button></span>
                <textarea readOnly rows={Math.min(8, (out?.length ?? 0) + 1)} value={texts.youtube} data-testid="chapters-youtube" />
              </label>
              <label className="field check">
                <input type="checkbox" data-testid="chapters-embed" checked={ch.embed} onChange={(e) => store.editChapters("Chapter markers in MP4", (c) => ({ ...c, embed: e.target.checked }))} />
                Put chapter markers, title and description in the exported MP4
              </label>
            </>
          )}
        </>
      )}
    </div>
  );
}
