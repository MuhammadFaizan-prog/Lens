/**
 * Editor state: the project document (with undo history), the render plan built from it, the
 * playhead (an output frame index), playback, selection and export. A tiny external store read
 * through useEditor(selector) so the preview can redraw at 60 fps without re-rendering React.
 */
import { useSyncExternalStore } from "react";
import { applyZoomPreset, cutsForDeletedWords, isFiller, resolveProject } from "@lens/engine";
import type { ProjectConfig, RenderPlan, ZoomPresetName } from "@lens/engine";
import { AudioEngine } from "../media/audio";
import { FrameStore } from "../media/frames";
import { History } from "./history";
import { buildPlan, fetchBundle, type Bundle } from "./bundle";
import { frameForSource, freezeAutoZooms, normalizeCuts, subtractRange, type TrackKind } from "./timelineOps";

export interface Selection {
  track: TrackKind;
  index: number;
}

export interface ExportState {
  id: string;
  state: "starting" | "running" | "done" | "error";
  done: number;
  total: number;
  error?: string;
  seconds?: number;
}

export interface EditorState {
  status: "loading" | "ready" | "error";
  error: string | null;
  bundle: Bundle | null;
  project: ProjectConfig;
  plan: RenderPlan | null;
  planMs: number;
  frame: number;
  playing: boolean;
  /** Playback direction and speed for J/K/L: -4..4, never 0 while playing. */
  rate: number;
  loop: boolean;
  selection: Selection | null;
  selectedWords: number[];
  toast: { text: string; id: number } | null;
  exporting: ExportState | null;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  savedAt: number | null;
  dirty: boolean;
  /** Bumped by any plan change, so views can memo on it. */
  revision: number;
}

type Listener = () => void;

export class EditorStore {
  private s: EditorState = {
    status: "loading",
    error: null,
    bundle: null,
    project: resolveProject({}),
    plan: null,
    planMs: 0,
    frame: 0,
    playing: false,
    rate: 1,
    loop: false,
    selection: null,
    selectedWords: [],
    toast: null,
    exporting: null,
    canUndo: false,
    canRedo: false,
    undoLabel: null,
    redoLabel: null,
    savedAt: null,
    dirty: false,
    revision: 0,
  };
  private listeners = new Set<Listener>();
  private history = new History<ProjectConfig>(this.s.project);
  private raf = 0;
  private playStart = { t: 0, frame: 0 };
  private gestureTimer: ReturnType<typeof setTimeout> | null = null;
  private gestureLabel = "";
  screen: FrameStore | null = null;
  cam: FrameStore | null = null;
  readonly audio = new AudioEngine();

  get = (): EditorState => this.s;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(patch: Partial<EditorState>): void {
    this.s = { ...this.s, ...patch };
    for (const l of this.listeners) l();
  }

  // ------------------------------------------------------------------ loading

  private loading: Promise<void> | null = null;

  /** Open a bundle once (React StrictMode mounts effects twice in dev). */
  load(dir?: string): Promise<void> {
    if (!this.loading) this.loading = this.loadBundle(dir);
    return this.loading;
  }

  private async loadBundle(dir?: string): Promise<void> {
    try {
      const bundle = await fetchBundle(dir);
      // Tests on small machines lower the decoded-bitmap LRU (window.__lensMaxBitmaps, set before load).
      const maxBitmaps = Number((globalThis as { __lensMaxBitmaps?: number }).__lensMaxBitmaps) || 24;
      this.screen = new FrameStore("screen", bundle.screen.frames, bundle.screen.fps, "", maxBitmaps);
      this.cam = bundle.camera ? new FrameStore("cam", bundle.camera.frames, bundle.camera.fps, "", maxBitmaps) : null;
      this.history.reset(bundle.project);
      this.set({ bundle, status: "ready", error: null, frame: 0, selection: null, selectedWords: [], savedAt: null, dirty: false });
      this.rebuild(bundle.project);
      void this.audio.load(bundle.project.audio.tracks.find((t) => !t.muted)?.path ?? null);
    } catch (e) {
      this.set({ status: "error", error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Replace the project (Open project.json). Validated by the engine first; throws on bad input. */
  openProject(raw: unknown, name = "project.json"): void {
    const p = resolveProject(raw);
    this.history.reset(p);
    this.rebuild(p);
    this.set({ selection: null, selectedWords: [], dirty: false });
    this.notify(`Opened ${name}`);
  }

  private rebuild(project: ProjectConfig): void {
    const b = this.s.bundle;
    if (!b) {
      this.set({ project });
      return;
    }
    const t0 = performance.now();
    const plan = buildPlan(b, project);
    const planMs = performance.now() - t0;
    const frame = Math.min(this.s.frame, plan.frames.length - 1);
    const h = this.history;
    this.set({
      project,
      plan,
      planMs,
      frame,
      revision: this.s.revision + 1,
      canUndo: h.canUndo,
      canRedo: h.canRedo,
      undoLabel: h.undoLabel,
      redoLabel: h.redoLabel,
      dirty: h.canUndo || this.s.dirty,
    });
  }

  // ------------------------------------------------------------------ editing

  /** One finished edit = one undo step. */
  edit(label: string, fn: (p: ProjectConfig) => ProjectConfig): void {
    this.flushGesture();
    const next = fn(this.history.doc);
    this.history.commit(next, label);
    this.rebuild(this.history.doc);
  }

  /** Live edit during a drag: the preview updates, history records one step at endGesture. */
  preview(fn: (p: ProjectConfig) => ProjectConfig): void {
    this.history.preview(fn(this.history.doc));
    this.rebuild(this.history.doc);
  }

  beginGesture(): void {
    this.flushGesture();
    this.history.beginGesture();
  }

  endGesture(label: string, finalize?: (p: ProjectConfig) => ProjectConfig): void {
    if (finalize) this.history.preview(finalize(this.history.doc));
    this.history.endGesture(label);
    this.rebuild(this.history.doc);
  }

  /** Slider edits: preview now, commit as one undo step once the control is idle for 400 ms. */
  tweak(label: string, fn: (p: ProjectConfig) => ProjectConfig): void {
    if (!this.history.inGesture) this.history.beginGesture();
    this.gestureLabel = label;
    this.preview(fn);
    if (this.gestureTimer) clearTimeout(this.gestureTimer);
    this.gestureTimer = setTimeout(() => this.flushGesture(), 400);
  }

  private flushGesture(): void {
    if (this.gestureTimer) {
      clearTimeout(this.gestureTimer);
      this.gestureTimer = null;
      this.history.endGesture(this.gestureLabel);
      this.rebuild(this.history.doc);
    }
  }

  undo(): void {
    this.flushGesture();
    const label = this.history.undoLabel;
    if (this.history.undo()) {
      this.rebuild(this.history.doc);
      this.set({ selection: null });
      this.notify(`Undo ${label ?? ""}`.trim());
    }
  }

  redo(): void {
    this.flushGesture();
    const label = this.history.redoLabel;
    if (this.history.redo()) {
      this.rebuild(this.history.doc);
      this.set({ selection: null });
      this.notify(`Redo ${label ?? ""}`.trim());
    }
  }

  select(sel: Selection | null): void {
    this.set({ selection: sel, selectedWords: sel ? [] : this.s.selectedWords });
  }

  /** Make auto zooms editable (see freezeAutoZooms); returns the index of `seg` after freezing. */
  freezeZoomsFor(start: number, end: number): number {
    const p = this.history.doc;
    if (p.zoom.auto && this.s.plan) {
      this.edit("Freeze auto zooms", (q) => freezeAutoZooms(q, this.s.plan!.zoomSegments));
      this.notify("Auto zooms are now editable blocks (turn Auto zoom on to regenerate)");
    }
    return this.history.doc.zoom.segments.findIndex((s) => Math.abs(s.startMs - start) < 0.5 && Math.abs(s.endMs - end) < 0.5);
  }

  applyPreset(name: ZoomPresetName): void {
    this.edit(`Zoom preset ${name}`, (p) => applyZoomPreset(p, name));
  }

  // ------------------------------------------------------------------ transcript

  selectWords(idx: number[]): void {
    this.set({ selectedWords: idx, selection: null });
  }

  deleteWords(idx: number[]): void {
    const words = this.s.bundle?.transcript?.words ?? [];
    if (!idx.length || !words.length) return;
    const cuts = cutsForDeletedWords(words, idx);
    this.edit(idx.length === 1 ? `Delete "${words[idx[0]!]!.text}"` : `Delete ${idx.length} words`, (p) => normalizeCuts({ ...p, edits: { ...p.edits, cuts: [...p.edits.cuts, ...cuts] } }));
    this.set({ selectedWords: [] });
  }

  restoreWords(idx: number[]): void {
    const words = this.s.bundle?.transcript?.words ?? [];
    if (!idx.length) return;
    const spans = cutsForDeletedWords(words, idx);
    this.edit(`Restore ${idx.length === 1 ? `"${words[idx[0]!]!.text}"` : `${idx.length} words`}`, (p) => {
      let cuts = p.edits.cuts;
      for (const s of spans) cuts = subtractRange(cuts, s);
      return { ...p, edits: { ...p.edits, cuts } };
    });
    this.set({ selectedWords: [] });
  }

  fillerIndices(): number[] {
    const words = this.s.bundle?.transcript?.words ?? [];
    const fillers = this.s.project.edits.cleanup.fillers;
    const cuts = this.s.plan?.cuts ?? [];
    return words
      .map((w, i) => ({ w, i }))
      .filter(({ w }) => !w.inferred && isFiller(w, fillers) && !cuts.some((c) => (w.startMs + w.endMs) / 2 >= c.startMs && (w.startMs + w.endMs) / 2 < c.endMs))
      .map(({ i }) => i);
  }

  removeFillers(): number {
    const idx = this.fillerIndices();
    if (!idx.length) return 0;
    const words = this.s.bundle!.transcript!.words;
    const cuts = cutsForDeletedWords(words, idx);
    this.edit(`Remove ${idx.length} filler${idx.length > 1 ? "s" : ""}`, (p) => normalizeCuts({ ...p, edits: { ...p.edits, cuts: [...p.edits.cuts, ...cuts] } }));
    this.notify(`Removed ${idx.length} filler${idx.length > 1 ? "s" : ""}`);
    return idx.length;
  }

  // ------------------------------------------------------------------ transport

  seek(frame: number): void {
    const n = this.s.plan?.frames.length ?? 1;
    const f = Math.max(0, Math.min(n - 1, Math.round(frame)));
    if (this.s.playing) {
      this.playStart = { t: performance.now(), frame: f };
      this.audio.restart(this.s.plan!, f, this.s.rate);
    }
    this.set({ frame: f });
  }

  seekSource(srcMs: number): void {
    if (this.s.plan) this.seek(frameForSource(this.s.plan, srcMs));
  }

  step(n: number): void {
    this.pause();
    this.seek(this.s.frame + n);
  }

  play(rate = 1): void {
    const plan = this.s.plan;
    if (!plan) return;
    let frame = this.s.frame;
    if (rate > 0 && frame >= plan.frames.length - 1) frame = 0;
    if (rate < 0 && frame <= 0) frame = plan.frames.length - 1;
    this.playStart = { t: performance.now(), frame };
    this.set({ playing: true, rate, frame });
    this.audio.restart(plan, frame, rate);
    cancelAnimationFrame(this.raf);
    const tick = () => {
      const p = this.s.plan;
      if (!this.s.playing || !p) return;
      const n = p.frames.length;
      const elapsed = (performance.now() - this.playStart.t) / 1000;
      let f = this.playStart.frame + Math.floor(elapsed * p.output.fps * this.s.rate);
      if (f >= n || f < 0) {
        if (this.s.loop) {
          f = ((f % n) + n) % n;
          this.playStart = { t: performance.now(), frame: f };
          this.audio.restart(p, f, this.s.rate);
        } else {
          this.set({ frame: f >= n ? n - 1 : 0 });
          this.pause();
          return;
        }
      }
      if (f !== this.s.frame) this.set({ frame: f });
      this.prefetch(f);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause(): void {
    cancelAnimationFrame(this.raf);
    this.audio.stop();
    if (this.s.playing) this.set({ playing: false, rate: 1 });
  }

  toggle(): void {
    if (this.s.playing) this.pause();
    else this.play(1);
  }

  /** J / K / L shuttle: L plays forward (again = faster), J backward, K pauses. */
  shuttle(dir: -1 | 0 | 1): void {
    if (dir === 0) return this.pause();
    const r = this.s.rate;
    const next = this.s.playing && Math.sign(r) === dir ? Math.max(-4, Math.min(4, r * 2)) : dir;
    this.play(next);
  }

  setLoop(loop: boolean): void {
    this.set({ loop });
  }

  private prefetch(f: number): void {
    const p = this.s.plan;
    if (!p || !this.screen) return;
    const ahead: number[] = [];
    const camAhead: number[] = [];
    const dir = this.s.rate < 0 ? -1 : 1;
    for (let k = 1; k <= 24; k++) {
      const fr = p.frames[f + k * dir * Math.max(1, Math.abs(this.s.rate))];
      if (!fr) break;
      ahead.push(this.screen.indexAt(fr.src));
      if (this.cam) camAhead.push(this.cam.indexAt(fr.src));
    }
    this.screen.prefetch([...new Set(ahead)]);
    this.cam?.prefetch([...new Set(camAhead)]);
  }

  // ------------------------------------------------------------------ files

  async save(): Promise<void> {
    const r = await fetch(`/api/project${this.dirQuery()}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(this.s.project) });
    const j = await r.json();
    if (!r.ok) {
      this.notify(`Save failed: ${j.error}`);
      return;
    }
    this.set({ savedAt: Date.now(), dirty: false });
    this.notify("Saved project.json");
  }

  private dirQuery(): string {
    const d = new URLSearchParams(location.search).get("dir");
    return d ? `?dir=${encodeURIComponent(d)}` : "";
  }

  async exportVideo(): Promise<void> {
    this.set({ exporting: { id: "", state: "starting", done: 0, total: this.s.plan?.frames.length ?? 0 } });
    const r = await fetch(`/api/export${this.dirQuery()}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: this.s.project }) });
    const j = await r.json();
    if (!r.ok) {
      this.set({ exporting: { id: "", state: "error", done: 0, total: 0, error: j.error } });
      return;
    }
    const id = j.id as string;
    this.set({ exporting: { id, state: "running", done: 0, total: j.total } });
    const poll = async () => {
      const s = await (await fetch(`/api/export/${id}${this.dirQuery()}`)).json();
      this.set({ exporting: { id, state: s.state, done: s.done, total: s.total, error: s.error, seconds: s.seconds } });
      if (s.state === "running") setTimeout(poll, 400);
      else if (s.state === "done") this.notify("Export finished");
    };
    setTimeout(poll, 300);
  }

  closeExport(): void {
    if (this.s.exporting?.state !== "running") this.set({ exporting: null });
  }

  notify(text: string): void {
    this.set({ toast: { text, id: (this.s.toast?.id ?? 0) + 1 } });
  }
}

export const store = new EditorStore();

export function useEditor<T>(sel: (s: EditorState) => T): T {
  return useSyncExternalStore(store.subscribe, () => sel(store.get()));
}
