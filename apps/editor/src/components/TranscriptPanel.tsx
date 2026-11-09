import { useMemo, useRef, useState } from "react";
import { isFiller } from "@lens/engine";
import { store, useEditor } from "../state/store";
import { timecode } from "../state/timelineOps";
import { Icon } from "./Icon";

/**
 * Transcript editing: words from lens-transcribe JSON. Click a word to seek, shift-click to select
 * a run, Delete to cut it, Restore to bring it back. Fillers are marked and removable in one click.
 */
export function TranscriptPanel() {
  const words = useEditor((s) => s.bundle?.transcript?.words);
  const cuts = useEditor((s) => s.plan?.cuts);
  const frame = useEditor((s) => s.frame);
  const plan = useEditor((s) => s.plan);
  const selected = useEditor((s) => s.selectedWords);
  const fillersList = useEditor((s) => s.project.edits.cleanup.fillers);
  const takesCfg = useEditor((s) => s.project.edits.takes);
  const audition = useEditor((s) => s.audition);
  const wordEdits = useEditor((s) => s.project.captions.wordEdits);
  const [editing, setEditing] = useState<number | null>(null);
  const fps = plan?.output.fps ?? 30;
  const src = plan?.frames[frame]?.src ?? 0;

  const takeCuts = plan?.takeCuts;
  const groups = plan?.takes;
  const info = useMemo(
    () =>
      (words ?? []).map((w, i) => {
        const mid = (w.startMs + w.endMs) / 2;
        const altTake = (takeCuts ?? []).some((c) => mid >= c.startMs && mid < c.endMs);
        const keptTake = !altTake && (groups ?? []).some((g) => { const t = g.takes[g.kept]!; return i >= t.firstWord && i <= t.lastWord; });
        return { deleted: (cuts ?? []).some((c) => mid >= c.startMs && mid < c.endMs), filler: isFiller(w, fillersList), altTake, keptTake };
      }),
    [words, cuts, fillersList, takeCuts, groups],
  );
  // word index -> [group, take] where a take starts (a chip there swaps / previews it)
  const takeStarts = useMemo(() => {
    const m = new Map<number, Array<{ g: number; k: number }>>();
    (groups ?? []).forEach((g, gi) => g.takes.forEach((t, k) => {
      const at = k === 0 ? Math.min(t.firstWord, g.takes[0]!.firstWord) : t.firstWord;
      m.set(at, [...(m.get(at) ?? []), { g: gi, k }]);
    }));
    return m;
  }, [groups]);
  const activeIdx = useMemo(() => {
    if (!words) return -1;
    let a = -1;
    words.forEach((w, i) => {
      if (src >= w.startMs && src < w.endMs + 120) a = i;
    });
    return a;
  }, [words, src]);
  const pendingFillers = info.filter((x, i) => x.filler && !x.deleted && !words?.[i]?.inferred).length;

  if (!words || !words.length) {
    return (
      <aside className="transcript empty">
        <h2>Transcript</h2>
        <p className="note">No transcript in this bundle. Run lens-transcribe on the mic track to edit by text.</p>
      </aside>
    );
  }

  const selSet = new Set(selected);
  const selDeleted = selected.length > 0 && selected.every((i) => info[i]?.deleted);
  const onWord = (i: number, e: React.MouseEvent) => {
    if (e.shiftKey && selected.length) {
      const a = Math.min(selected[0]!, i);
      const b = Math.max(selected[selected.length - 1]!, i);
      store.selectWords(Array.from({ length: b - a + 1 }, (_, k) => a + k));
    } else if (e.metaKey || e.ctrlKey) {
      store.selectWords(selSet.has(i) ? selected.filter((x) => x !== i) : [...selected, i].sort((x, y) => x - y));
    } else {
      store.selectWords([i]);
      store.pause();
      store.seekSource(words[i]!.startMs);
    }
  };

  return (
    <aside className="transcript" data-testid="transcript">
      <header className="tr-head">
        <h2>Transcript</h2>
        <span className="stat">{words.filter((w) => !w.inferred).length} words</span>
      </header>
      <div className="tr-takes" data-testid="takes-controls">
        <label className="toggle-inline">
          <input type="checkbox" checked={takesCfg.enabled} data-testid="takes-enabled" onChange={(e) => store.setTakesEnabled(e.target.checked)} /> Takes
        </label>
        <select value={takesCfg.strategy} disabled={!takesCfg.enabled} data-testid="takes-strategy" aria-label="Which take to keep" onChange={(e) => store.setTakeStrategy(e.target.value as "last" | "best")}>
          <option value="last">Keep last</option>
          <option value="best">Keep best</option>
        </select>
        <span className="stat" data-testid="takes-count">{groups?.length ? `${groups.length} retake${groups.length > 1 ? "s" : ""}` : takesCfg.enabled ? "no retakes" : ""}</span>
      </div>
      {audition && groups?.[audition.group] && (
        <div className="audition-bar" data-testid="audition-bar">
          A/B: playing take {audition.take + 1} of {groups[audition.group]!.takes.length}
          <button className="chip-btn" data-testid="audition-keep" onClick={() => store.keepTake(audition.group, audition.take)}>Keep it</button>
          <button className="chip-btn" data-testid="audition-stop" onClick={() => store.endAudition()}>Back</button>
        </div>
      )}
      <div className="tr-actions">
        <button className="chip-btn accent" disabled={!pendingFillers} data-testid="remove-fillers" onClick={() => store.removeFillers()} title="Cut every filler word (one undo step)">
          <Icon name="sparkle" /> {pendingFillers ? `Remove ${pendingFillers} filler${pendingFillers === 1 ? "" : "s"}` : "No fillers left"}
        </button>
        {selected.length > 0 && !selDeleted && (
          <button className="chip-btn danger" data-testid="delete-words" onClick={() => store.deleteWords(selected)} title="Cut the selected words (Del)">
            <Icon name="scissors" /> Cut {selected.length}
          </button>
        )}
        {selected.length > 0 && !selDeleted && (
          <button className="chip-btn" data-testid="mark-retake" onClick={() => store.markRetake(selected)} title="These words are a fumbled take: cut them and keep what follows (reversible)">
            Mark retake
          </button>
        )}
        {selected.length > 0 && selDeleted && (
          <button className="chip-btn" data-testid="restore-words" onClick={() => store.restoreWords(selected)}>
            <Icon name="restore" /> Restore
          </button>
        )}
      </div>
      <div className="tr-words" role="list">
        {words.map((w, i) => {
          if (w.inferred) return null;
          const st = info[i]!;
          const gapBefore = i > 0 && w.startMs - words[i - 1]!.endMs > 900;
          return (
            <span key={i} className="tr-wrap">
              {gapBefore && <span className="tr-pause" title={`pause ${((w.startMs - words[i - 1]!.endMs) / 1000).toFixed(1)} s`}>⋯</span>}
              {(takeStarts.get(i) ?? []).map(({ g, k }) => {
                const grp = groups![g]!;
                const on = grp.kept === k;
                return (
                  <button
                    key={`chip-${g}-${k}`}
                    className={`take-chip ${on ? "on" : ""}`}
                    data-testid={`take-chip-${g}-${k}`}
                    title={on ? `Take ${k + 1} of ${grp.takes.length} is kept · click to preview` : `Take ${k + 1} of ${grp.takes.length} · click to keep this take`}
                    onClick={() => (on ? store.audition(g, k) : store.keepTake(g, k))}
                  >
                    {on ? "✓" : "⇄"} {k + 1}/{grp.takes.length}
                  </button>
                );
              })}
              {editing === i ? (
                <WordEditor
                  initial={wordEdits?.[String(i)] ?? w.text}
                  onDone={(v) => {
                    setEditing(null);
                    if (v === null) return;
                    const t = v.replace(/\s+/g, " ").trim();
                    store.setWordEdit(i, t === w.text ? null : t);
                  }}
                />
              ) : (
              <button
                role="listitem"
                className={`word ${st.deleted && !st.altTake ? "deleted" : ""} ${st.altTake ? "alt-take" : ""} ${st.keptTake ? "take-kept" : ""} ${st.filler ? "filler" : ""} ${selSet.has(i) ? "sel" : ""} ${i === activeIdx ? "active" : ""}`}
                data-testid={`word-${i}`}
                data-start={w.startMs}
                title={`${timecode(w.startMs, fps)}${st.filler ? " · filler" : ""}${st.altTake ? " · alt take (not used)" : st.deleted ? " · cut" : ""}`}
                onClick={(e) => onWord(i, e)}
                onDoubleClick={(e) => {
                  e.preventDefault();
                  setEditing(i);
                }}
              >
                {wordEdits?.[String(i)] !== undefined ? <span className="word-edited" title={`was “${w.text}”`}>{wordEdits[String(i)] || "∅"}</span> : w.text}
              </button>
              )}
            </span>
          );
        })}
      </div>
      <p className="tr-hint">Click to jump · Double-click to fix a word · Shift-click to select · Del cuts · ⌘/Ctrl-click to add</p>
    </aside>
  );
}

/** Inline word correction: Enter keeps, Esc cancels, empty hides the word from captions. */
function WordEditor({ initial, onDone }: { initial: string; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const finish = (x: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(x);
  };
  return (
    <input
      className="word-input"
      data-testid="word-input"
      autoFocus
      value={v}
      size={Math.max(3, v.length + 1)}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => finish(v)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(v);
        else if (e.key === "Escape") finish(null);
      }}
    />
  );
}
