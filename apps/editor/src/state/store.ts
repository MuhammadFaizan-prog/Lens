/**
 * Editor state: the project document (with undo history), the render plan built from it, the
 * playhead (an output frame index), playback, selection and export. A tiny external store read
 * through useEditor(selector) so the preview can redraw at 60 fps without re-rendering React.
 */
import { useSyncExternalStore } from "react";
import { applyPrivacyScan, applyStepDrafts, applyZoomPreset, cutsForDeletedWords, editStepLabel, isFiller, privacyCounts, resolveProject, reviewPrivacy, reviewSteps, setPrivacyMaskKind, withTakeChoice } from "@lens/engine";
import type { Annotation, PrivacyDetection, PrivacySettings, PrivacyState, ProjectConfig, RenderPlan, StepDraft, TakeSettings, TakeStrategy, TextSlide, ZoomPresetName } from "@lens/engine";
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

export interface PrivacyScanState {
  id: string;
  state: "starting" | "running" | "done" | "error";
  stage: string;
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
  /**
   * A/B preview of one take: the plan is built as if that take were kept (no history entry) and
   * plays from the take's start; anything else ends it and restores the project's own plan.
   */
  audition: { group: number; take: number; endFrame: number } | null;
  /** The on-device privacy scan in progress (or its last outcome). */
  privacyScan: PrivacyScanState | null;
  /** Export asked while privacy detections are unreviewed: the sheet asks first. */
  exportWarning: { pending: number } | null;
  /** Which panel the left column shows. */
  leftPanel: "transcript" | "privacy" | "steps";
  /** Annotation tool on the preview (select = pick / move / resize existing items). */
  tool: AnnotationTool;
  /** Anchor for newly drawn items: follow the screen (zoom / pan) or stay fixed on the frame. */
  newAnchor: "screen" | "frame";
  /** Annotation whose text is being edited inline on the preview. */
  editingText: string | null;
  /** The step-label run in progress (or its last outcome). */
  stepRun: { id: string; state: "starting" | "running" | "done" | "error"; error?: string; seconds?: number } | null;
}

export type AnnotationTool = "select" | "arrow" | "rect" | "ellipse" | "text" | "badge" | "callout";

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
    audition: null,
    privacyScan: null,
    exportWarning: null,
    leftPanel: "transcript",
    tool: "select",
    newAnchor: "screen",
    editingText: null,
    stepRun: null,
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
      // frames come from the opened bundle (?dir=...), not the server's default one
      const q = this.dirQuery();
      this.screen = new FrameStore("screen", bundle.screen.frames, bundle.screen.fps, q, maxBitmaps);
      this.cam = bundle.camera ? new FrameStore("cam", bundle.camera.frames, bundle.camera.fps, q, maxBitmaps) : null;
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

  private rebuild(project: ProjectConfig, planProject: ProjectConfig = project): void {
    const b = this.s.bundle;
    if (!b) {
      this.set({ project });
      return;
    }
    if (planProject === project && this.s.audition) this.s = { ...this.s, audition: null };
    const t0 = performance.now();
    const plan = buildPlan(b, planProject);
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
    if (this.s.audition) this.endAudition();
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
    this.endAudition();
    this.flushGesture();
    const label = this.history.undoLabel;
    if (this.history.undo()) {
      this.rebuild(this.history.doc);
      this.set({ selection: null });
      this.notify(`Undo ${label ?? ""}`.trim());
    }
  }

  redo(): void {
    this.endAudition();
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

  // ------------------------------------------------------------------ takes (multi-take)

  private takesEdit(label: string, fn: (t: TakeSettings) => TakeSettings): void {
    this.endAudition();
    this.edit(label, (p) => ({ ...p, edits: { ...p.edits, takes: fn(p.edits.takes) } }));
  }

  setTakesEnabled(on: boolean): void {
    this.takesEdit(on ? "Turn on takes" : "Turn off takes", (t) => ({ ...t, enabled: on }));
  }

  setTakeStrategy(strategy: TakeStrategy): void {
    this.takesEdit(`Takes: keep ${strategy}`, (t) => ({ ...t, strategy }));
  }

  /** Keep take `take` of group `group` (one undo step). The playhead moves to that take. */
  keepTake(group: number, take: number): void {
    const g = this.s.plan?.takes[group];
    if (!g || take < 0 || take >= g.takes.length || take === g.kept) return;
    this.takesEdit(`Keep take ${take + 1} of ${g.takes.length}`, (t) => withTakeChoice(t, g, take));
    this.pause();
    this.seekSource(g.takes[take]!.startMs);
    this.notify(`Kept take ${take + 1} of ${g.takes.length}`);
  }

  /** The selected transcript words become a rejected take; the speech after them is kept. */
  markRetake(idx: number[]): void {
    const words = this.s.bundle?.transcript?.words ?? [];
    if (!idx.length || !words.length) return;
    const a = words[Math.min(...idx)]!;
    const b = words[Math.max(...idx)]!;
    this.takesEdit(`Mark retake`, (t) => ({ ...t, enabled: true, marked: [...t.marked, { startMs: a.startMs, endMs: b.endMs }] }));
    this.set({ selectedWords: [] });
  }

  /** "Not a retake": dismiss a detected group, or remove a user-marked one. */
  dismissTakeGroup(group: number): void {
    const g = this.s.plan?.takes[group];
    if (!g) return;
    this.takesEdit("Not a retake", (t) =>
      g.manual
        ? { ...t, marked: t.marked.filter((r) => !(r.startMs < g.endMs && r.endMs > g.startMs)) }
        : { ...t, ignored: [...t.ignored, g.startMs] },
    );
  }

  /** A/B preview: play take `take` of group `group` as if it were kept, without editing the project. */
  audition(group: number, take: number): void {
    const plan = this.s.plan;
    const g = plan?.takes[group];
    if (!g || !this.s.bundle) return;
    this.pause();
    const p = this.history.doc;
    const trial: ProjectConfig = { ...p, edits: { ...p.edits, takes: withTakeChoice(p.edits.takes, g, take) } };
    this.rebuild(p, trial);
    const np = this.s.plan!;
    const t = g.takes[take]!;
    const start = Math.max(0, frameForSource(np, t.startMs) - Math.round(np.output.fps * 0.25));
    const endFrame = Math.min(np.frames.length - 1, frameForSource(np, t.endMs) + Math.round(np.output.fps * 0.6));
    this.set({ audition: { group, take, endFrame }, frame: start });
    this.play(1);
  }

  endAudition(): void {
    if (!this.s.audition) return;
    this.pause();
    this.s = { ...this.s, audition: null };
    this.rebuild(this.history.doc);
  }

  // ------------------------------------------------------------------ privacy (demand #3)

  setLeftPanel(leftPanel: EditorState["leftPanel"]): void {
    this.set({ leftPanel });
  }

  /** Run the on-device scan (dev server: redact/lens-redact) and put its detections in the project (one undo step). */
  async scanPrivacy(force = false): Promise<void> {
    if (this.s.privacyScan && ["starting", "running"].includes(this.s.privacyScan.state)) return;
    this.set({ privacyScan: { id: "", state: "starting", stage: "start", done: 0, total: 0 } });
    const q = this.dirQuery();
    const r = await fetch(`/api/privacy/scan${q}${force ? `${q ? "&" : "?"}force=1` : ""}`, { method: "POST" });
    const j = await r.json();
    if (!r.ok) {
      this.set({ privacyScan: { id: "", state: "error", stage: "", done: 0, total: 0, error: j.error } });
      return;
    }
    const id = j.id as string;
    await new Promise<void>((resolve) => {
      const poll = async () => {
        const st = await (await fetch(`/api/privacy/scan/${id}${q}`)).json();
        this.set({ privacyScan: { id, state: st.state, stage: st.stage, done: st.done, total: st.total, error: st.error, seconds: st.seconds } });
        if (st.state === "running") {
          setTimeout(poll, 300);
          return;
        }
        if (st.state === "done") {
          const res = st.result as { detections: PrivacyDetection[] };
          const n = res.detections.length;
          this.edit(`Scan for sensitive info`, (p) => applyPrivacyScan(p, res, new Date().toISOString()));
          this.notify(n ? `Found ${n} sensitive item${n > 1 ? "s" : ""} to review` : "Nothing sensitive found");
        }
        resolve();
      };
      setTimeout(poll, 150);
    });
  }

  /** Accept / dismiss / un-review detections (ids null = all of them); one undo step. */
  reviewPrivacy(ids: string[] | null, state: PrivacyState): void {
    const dets = this.history.doc.privacy.detections.filter((d) => !ids || ids.includes(d.id));
    if (!dets.length) return;
    const verb = state === "accepted" ? "Hide" : state === "dismissed" ? "Dismiss" : "Unreview";
    const what = ids === null ? `all ${dets.length}` : dets.length === 1 ? dets[0]!.preview : `${dets.length} items`;
    this.edit(`${verb} ${what}`, (p) => reviewPrivacy(p, ids, state));
  }

  setPrivacyMaskKind(kind: PrivacySettings["maskKind"]): void {
    this.edit(`Privacy masks: ${kind}`, (p) => setPrivacyMaskKind(p, kind, null));
  }

  /** Jump to a detection's first appearance. */
  showDetection(id: string): void {
    const d = this.s.project.privacy.detections.find((x) => x.id === id);
    if (!d || !this.s.plan) return;
    this.pause();
    const t = d.tracks[0]!;
    this.seekSource(Math.min(t.endMs - 1, t.startMs + Math.min(400, (t.endMs - t.startMs) / 2)));
  }

  // ------------------------------------------------------------------ annotations (demand #4)

  setTool(tool: AnnotationTool): void {
    this.set({ tool, editingText: null });
  }

  setNewAnchor(newAnchor: "screen" | "frame"): void {
    this.set({ newAnchor });
  }

  /** Index of an annotation by id in the current project, or -1. */
  annotationIndex(id: string): number {
    return this.history.doc.annotations.findIndex((a) => a.id === id);
  }

  selectAnnotation(id: string | null): void {
    const i = id ? this.annotationIndex(id) : -1;
    this.set({ selection: i >= 0 ? { track: "annotation", index: i } : null, selectedWords: [] });
  }

  selectedAnnotation(): Annotation | null {
    const sel = this.s.selection;
    return sel?.track === "annotation" ? this.s.project.annotations[sel.index] ?? null : null;
  }

  /** Add an annotation (one undo step) and select it. */
  addAnnotation(a: Annotation, label = `Add ${a.kind}`): void {
    this.edit(label, (p) => ({ ...p, annotations: [...p.annotations, a] }));
    this.selectAnnotation(a.id);
  }

  /** Change one annotation: live (during a drag, one step at endGesture), tweak (sliders) or one step. */
  updateAnnotation(id: string, fn: (a: Annotation) => Annotation, mode: "edit" | "preview" | "tweak" = "edit", label = "Edit annotation"): void {
    const apply = (p: ProjectConfig) => ({ ...p, annotations: p.annotations.map((a) => (a.id === id ? fn(a) : a)) });
    if (mode === "preview") this.preview(apply);
    else if (mode === "tweak") this.tweak(label, apply);
    else this.edit(label, apply);
  }

  deleteAnnotation(id: string): void {
    const a = this.history.doc.annotations.find((x) => x.id === id);
    if (!a) return;
    this.edit(`Delete ${a.kind}`, (p) => {
      const q = { ...p, annotations: p.annotations.filter((x) => x.id !== id) };
      // a step badge deleted by hand sends its draft back to review
      return a.stepId ? { ...q, stepLabels: { ...q.stepLabels, drafts: q.stepLabels.drafts.map((d) => (d.id === a.stepId ? { ...d, state: "pending" as const } : d)) } } : q;
    });
    this.set({ selection: null, editingText: null });
  }

  startTextEdit(id: string | null): void {
    this.set({ editingText: id });
  }

  addSlide(sl: TextSlide): void {
    this.edit("Add text slide", (p) => ({ ...p, slides: [...p.slides, sl] }));
    this.set({ selection: { track: "slide", index: this.history.doc.slides.length - 1 } });
  }

  updateSlide(index: number, patch: Partial<TextSlide>, live = false): void {
    const fn = (p: ProjectConfig) => ({ ...p, slides: p.slides.map((s, i) => (i === index ? { ...s, ...patch } : s)) });
    if (live) this.tweak("Edit slide", fn);
    else this.edit("Edit slide", fn);
  }

  /** Draft step labels from the clicks + on-device OCR (dev server: lens-redact steps), as one undo step. */
  async generateSteps(): Promise<void> {
    if (this.s.stepRun && ["starting", "running"].includes(this.s.stepRun.state)) return;
    this.set({ stepRun: { id: "", state: "starting" } });
    const q = this.dirQuery();
    const r = await fetch(`/api/steps${q}`, { method: "POST" });
    const j = await r.json();
    if (!r.ok) {
      this.set({ stepRun: { id: "", state: "error", error: j.error } });
      return;
    }
    const id = j.id as string;
    await new Promise<void>((resolve) => {
      const poll = async () => {
        const st = await (await fetch(`/api/steps/${id}${q}`)).json();
        this.set({ stepRun: { id, state: st.state, error: st.error, seconds: st.seconds } });
        if (st.state === "running") {
          setTimeout(poll, 300);
          return;
        }
        if (st.state === "done") {
          const drafts = (st.result as { drafts: StepDraft[] }).drafts;
          this.edit("Generate step labels", (p) => applyStepDrafts(p, drafts, new Date().toISOString()));
          this.notify(drafts.length ? `${drafts.length} step label${drafts.length > 1 ? "s" : ""} to review` : "No clicks found");
        }
        resolve();
      };
      setTimeout(poll, 150);
    });
  }

  reviewSteps(ids: string[] | null, state: StepDraft["state"]): void {
    const ds = this.history.doc.stepLabels.drafts.filter((d) => !ids || ids.includes(d.id));
    if (!ds.length) return;
    const verb = state === "accepted" ? "Accept" : state === "dismissed" ? "Dismiss" : "Unreview";
    this.edit(`${verb} ${ids === null ? `all ${ds.length} steps` : ds.length === 1 ? `step "${ds[0]!.label}"` : `${ds.length} steps`}`, (p) => reviewSteps(p, ids, state));
  }

  editStepLabel(id: string, label: string): void {
    this.edit("Edit step label", (p) => editStepLabel(p, id, label));
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
      const au = this.s.audition;
      if (au && f >= au.endFrame) {
        // the A/B preview played its take: back to the project's own plan, at that take
        const t = p.takes[au.group]?.takes[au.take];
        this.set({ frame: au.endFrame });
        this.endAudition();
        if (t) this.seekSource(t.startMs);
        return;
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

  /** Export; while privacy detections are unreviewed the sheet asks first (force skips the question). */
  async exportVideo(force = false): Promise<void> {
    const pending = privacyCounts(this.s.project).pending;
    if (pending && !force) {
      this.set({ exportWarning: { pending } });
      return;
    }
    this.set({ exportWarning: null });
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

  closeExportWarning(review = false): void {
    this.set({ exportWarning: null, ...(review ? { leftPanel: "privacy" as const } : {}) });
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
