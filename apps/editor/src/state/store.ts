/**
 * Editor state: the project document (with undo history), the render plan built from it, the
 * playhead (an output frame index), playback, selection and export. A tiny external store read
 * through useEditor(selector) so the preview can redraw at 60 fps without re-rendering React.
 */
import { useSyncExternalStore } from "react";
import { applyPreset, presetFromProject, serializePreset, themedNewStyle, PRESET_SECTIONS, SECTION_LABELS, parseTranscript } from "@lens/engine";
import type { BrandKit, DemoSettings, Preset, PresetSection } from "@lens/engine";
import { setDemoHotspot } from "@lens/engine";
import { ensurePlanAssets, setAssetBundle } from "../render/assets";
import * as lib from "./presetLibrary";
import { mergeCues, parseSubtitles, splitCue, type CaptionCue } from "@lens/engine";
import { buildRenderPlan, editSegment, toSrt, toVtt, upsertTrack, type CaptionTrack } from "@lens/engine";
import { applyPrivacyScan, applyStepDrafts, applyZoomPreset, cutsForDeletedWords, editStepLabel, isFiller, privacyCounts, resolveProject, reviewPrivacy, reviewSteps, setPrivacyMaskKind, withTakeChoice } from "@lens/engine";
import type { Annotation, PrivacyDetection, PrivacySettings, PrivacyState, ProjectConfig, RenderPlan, StepDraft, TakeSettings, TakeStrategy, TextSlide, ZoomPresetName, ZoomSegment } from "@lens/engine";
import { AudioEngine } from "../media/audio";
import { FrameStore } from "../media/frames";
import { makeCanvas, PlanRenderer } from "../render/renderer";
import { History } from "./history";
import { buildPlan, fetchBundle, planPauses, type Bundle } from "./bundle";
import { addBlock, blocksOf, createRange, deleteBlocks, duplicateBlocks, frameForSource, freezeAutoZooms, MIN_BLOCK_MS, moveBlocks, normalizeCuts, subtractRange, TRACK_KINDS, zoomDocIndex, zoomPlanIndex, type BlockRef, type TrackKind } from "./timelineOps";
import * as m3dLib from "./motion3dLib";
import { addKeyAt, applyTemplate, deleteKey, keyCount, keyPose, mapSegment, setKeyPose, type Axis3D } from "./motion3dOps";
import { templateFromSegment, type Motion3DSegment, type Motion3DTemplate, type Pose3D } from "@lens/engine";

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
  /** "browser": frames drawn by the editor's renderer (desktop app); "compositor": compositor/render.py. */
  path?: "browser" | "compositor";
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
  /**
   * Primary selected block (the one the inspector shows); always part of multi when set. Zoom
   * indices are into plan.zoomSegments (what the timeline draws); the project segment is found by
   * id (selectedZoomDocIndex / zoomDocIndex), never by position.
   */
  selection: Selection | null;
  /** Every selected timeline block (zoom indices into plan.zoomSegments, like selection). */
  multi: Selection[];
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
  leftPanel: "transcript" | "privacy" | "steps" | "brand";
  /** Built-in and saved style presets (demand #9), and the default for new projects. */
  presets: Preset[];
  defaultPresetId: string | null;
  /** Annotation tool on the preview (select = pick / move / resize existing items). */
  tool: AnnotationTool;
  /** Anchor for newly drawn items: follow the screen (zoom / pan) or stay fixed on the frame. */
  newAnchor: "screen" | "frame";
  /** Annotation whose text is being edited inline on the preview. */
  editingText: string | null;
  /** The step-label run in progress (or its last outcome). */
  stepRun: { id: string; state: "starting" | "running" | "done" | "error"; error?: string; seconds?: number } | null;
  /** In-app speech-to-text (Windows #5); auto: started by itself on a new recording with a mic. */
  transcribeRun: { id: string; state: "starting" | "running" | "done" | "error"; done: number; error?: string; seconds?: number; auto?: boolean } | null;
  /** Export dialog (format tabs); null = closed. */
  exportDialog: { tab: "video" | "demo" | "guide" } | null;
  /** Last interactive demo / step guide build per kind (demand #7). */
  stepsExport: Partial<Record<"demo" | "guide", StepsExportRun>>;
  /** The caption translation run in progress (or its last outcome), demand #8. */
  translateRun: TranslateRunState | null;
  /** A just-added zoom waits for a click on the preview to aim it (Z / Zoom lane "+"). */
  zoomPlacing: boolean;
  /** Selected canvas overlay that is not a timeline block (Windows bug #12). */
  canvasSel: "screen" | "logo" | "webcam" | "caption" | null;
  /** Selected keyframe of the selected 3D motion block (0 = from, n + 1 = to; see motion3dOps). */
  m3dKey: number;
  /** Built-in 3D motion templates followed by the user's saved ones. */
  motion3dTemplates: Motion3DTemplate[];
}

export interface TranslateRunState {
  id: string;
  state: "starting" | "running" | "done" | "error";
  stage: string;
  language: string;
  index: number;
  languages: number;
  done: number;
  total: number;
  error?: string;
  seconds?: number;
}

/** Languages the bundled on-device models translate English into (translate/lens_translate/models.py). */
export const TRANSLATE_LANGUAGES: Array<{ code: string; name: string; english: string }> = [
  { code: "es", name: "Español", english: "Spanish" },
  { code: "fr", name: "Français", english: "French" },
  { code: "de", name: "Deutsch", english: "German" },
  { code: "ur", name: "اردو", english: "Urdu" },
  { code: "ar", name: "العربية", english: "Arabic" },
];

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
    multi: [],
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
    presets: [],
    defaultPresetId: null,
    tool: "select",
    newAnchor: "screen",
    editingText: null,
    stepRun: null,
    transcribeRun: null,
    exportDialog: null,
    stepsExport: {},
    translateRun: null,
    zoomPlacing: false,
    canvasSel: null,
    m3dKey: 0,
    motion3dTemplates: m3dLib.allMotion3dTemplates(),
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
    // a plain selection change (select(), selectAnnotation(), undo ...) resets the group to it
    if ("selection" in patch && !("multi" in patch)) patch = { ...patch, multi: patch.selection ? [patch.selection] : [] };
    this.s = { ...this.s, ...patch };
    for (const l of this.listeners) l();
  }

  // ------------------------------------------------------------------ loading

  private loading: Promise<void> | null = null;
  /** ms from page start: bundle answered / first source frame painted (open-time measurements) */
  readyMs: number | null = null;
  firstPaintMs: number | null = null;

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
      setAssetBundle(q);
      this.refreshPresets();
      // a new recording (no project.json yet) starts from the user's default preset
      const def = bundle.isNew ? this.s.presets.find((x) => x.id === this.s.defaultPresetId) : undefined;
      if (def) bundle.project = resolveProject(applyPreset(bundle.project, def));
      this.screen = new FrameStore("screen", bundle.screen.frames, bundle.screen.fps, q, maxBitmaps);
      this.cam = bundle.camera ? new FrameStore("cam", bundle.camera.frames, bundle.camera.fps, q, maxBitmaps) : null;
      this.history.reset(bundle.project);
      this.readyMs = Math.round(performance.now());
      this.set({ bundle, status: "ready", error: null, frame: 0, selection: null, selectedWords: [], savedAt: null, dirty: false });
      this.rebuild(bundle.project);
      void this.audio.load(bundle.project.audio.tracks.find((t) => !t.muted)?.path ?? null);
      if (def) this.notify(`New project: default preset ${def.name} applied`);
      // a camera the recorder could not save is said out loud, not only in the Webcam tab
      else if (bundle.cameraWarning && !bundle.camera) this.notify(`No camera in this recording: ${bundle.cameraWarning}`);
      // a new recording with the mic on: transcribe it on-device right away (Windows #5)
      if (bundle.autoTranscribe && !bundle.transcript) void this.transcribe(true);
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
    // fonts and logo images the plan uses: redraw once they have loaded
    void ensurePlanAssets(plan).then((changed) => {
      if (changed && this.s.plan === plan) this.set({ revision: this.s.revision + 1 });
    });
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
    try {
      this.rebuild(this.history.doc);
    } catch (e) {
      // never leave an edit half-applied and silent: roll it back and say why
      this.history.undo();
      this.rebuild(this.history.doc);
      this.notify(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
      console.error(e);
    }
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
    const same = sel && this.s.selection && sel.track === this.s.selection.track && sel.index === this.s.selection.index;
    this.set({ m3dKey: same ? this.s.m3dKey : 0, selection: sel, selectedWords: sel ? [] : this.s.selectedWords, canvasSel: sel ? null : this.s.canvasSel, zoomPlacing: sel?.track === "zoom" ? this.s.zoomPlacing : false });
  }

  // ------------------------------------------------------------------ zoom selection index

  /** The plan's zoom list, the index space of every zoom Selection (the project's before a plan exists). */
  private planZooms(): ZoomSegment[] {
    return this.s.plan?.zoomSegments ?? this.history.doc.zoom.segments;
  }

  /** Project segment index of plan zoom `planIndex` (by id); -1 for a live auto zoom. */
  zoomDocIndex(planIndex: number): number {
    return zoomDocIndex(this.history.doc, this.planZooms(), planIndex);
  }

  /** Select project zoom segment `docIndex`, by its plan index (same space as multi-select). */
  selectZoom(docIndex: number): void {
    const i = zoomPlanIndex(this.history.doc, this.planZooms(), docIndex);
    this.select(i >= 0 ? { track: "zoom", index: i } : null);
  }

  // ------------------------------------------------------------------ multi-select (timeline groups)

  private blockCount(track: TrackKind): number {
    return track === "zoom" ? (this.s.plan?.zoomSegments ?? this.history.doc.zoom.segments).length : blocksOf(this.history.doc, track).length;
  }

  private uiRange(sel: Selection): { startMs: number; endMs: number } | null {
    return (sel.track === "zoom" ? (this.s.plan?.zoomSegments ?? this.history.doc.zoom.segments) : blocksOf(this.history.doc, sel.track))[sel.index] ?? null;
  }

  private valid(sel: Selection): boolean {
    return Number.isInteger(sel.index) && sel.index >= 0 && sel.index < this.blockCount(sel.track);
  }

  /** Replace the group; the primary is `primary` when given (and in the group), else the last item. */
  setSelection(items: Selection[], primary?: Selection | null): void {
    const seen = new Set<string>();
    const multi = items.filter((x) => this.valid(x) && !seen.has(`${x.track}:${x.index}`) && (seen.add(`${x.track}:${x.index}`), true)).map((x) => ({ track: x.track, index: x.index }));
    const prim = primary && multi.find((x) => x.track === primary.track && x.index === primary.index);
    const selection = prim ?? multi[multi.length - 1] ?? null;
    const cur = this.s.selection;
    const same = !!selection && !!cur && selection.track === cur.track && selection.index === cur.index;
    this.set({ multi, selection, m3dKey: same ? this.s.m3dKey : 0, ...(selection ? { selectedWords: [], canvasSel: null } : {}), zoomPlacing: selection?.track === "zoom" ? this.s.zoomPlacing : false });
  }

  isSelected(sel: Selection): boolean {
    return this.s.multi.some((x) => x.track === sel.track && x.index === sel.index);
  }

  /** Ctrl/Cmd-click: add a block to the group (it becomes primary) or take it out. */
  toggleSelect(sel: Selection): void {
    if (this.isSelected(sel)) {
      const multi = this.s.multi.filter((x) => !(x.track === sel.track && x.index === sel.index));
      const keep = this.s.selection && !(this.s.selection.track === sel.track && this.s.selection.index === sel.index) ? this.s.selection : null;
      this.setSelection(multi, keep);
    } else this.setSelection([...this.s.multi, sel], sel);
  }

  /**
   * Shift-click: every block of the primary's track between it and `sel` in time (both included) is
   * added to the group; on another track (or with nothing selected) `sel` is just added.
   */
  selectRange(sel: Selection): void {
    const a = this.s.selection;
    const ra = a && this.uiRange(a);
    const rb = this.uiRange(sel);
    if (!a || !ra || !rb || a.track !== sel.track) return this.setSelection([...this.s.multi, sel], sel);
    const lo = Math.min(ra.startMs, rb.startMs);
    const hi = Math.max(ra.startMs, rb.startMs);
    const blocks = sel.track === "zoom" ? this.s.plan?.zoomSegments ?? this.history.doc.zoom.segments : blocksOf(this.history.doc, sel.track);
    const span: Selection[] = [];
    blocks.forEach((b, index) => {
      if (b.startMs >= lo && b.startMs <= hi) span.push({ track: sel.track, index });
    });
    this.setSelection([...this.s.multi, ...span], a);
  }

  /** Select every block of one track (or of every track). */
  selectAll(track?: TrackKind): void {
    const out: Selection[] = [];
    for (const t of track ? [track] : TRACK_KINDS) for (let index = 0; index < this.blockCount(t); index++) out.push({ track: t, index });
    this.setSelection(out);
  }

  /** The group (or the single selection) as doc refs on `p`: zoom plan indices become p.zoom.segments indices. */
  private groupItems(): Selection[] {
    return this.s.multi.length ? this.s.multi : this.s.selection ? [this.s.selection] : [];
  }

  /**
   * Doc refs for UI items. Zoom items point at plan.zoomSegments; when auto zoom is on they are
   * frozen into the project first (inside the same edit, so one undo restores auto zoom too).
   */
  private toDoc(p: ProjectConfig, items: Selection[]): { doc: ProjectConfig; refs: BlockRef[] } {
    const zooms = items.filter((x) => x.track === "zoom");
    const planZ = this.s.plan?.zoomSegments ?? p.zoom.segments;
    const doc = zooms.length && p.zoom.auto && this.s.plan ? freezeAutoZooms(p, this.s.plan.zoomSegments) : p;
    const refs: BlockRef[] = [];
    for (const x of items) {
      if (x.track !== "zoom") {
        refs.push({ track: x.track, index: x.index });
        continue;
      }
      const z = planZ[x.index];
      if (!z) continue;
      let i = doc.zoom.segments.findIndex((s) => s.id === z.id);
      if (i < 0) i = doc.zoom.segments.findIndex((s) => Math.abs(s.startMs - z.startMs) < 0.5 && Math.abs(s.endMs - z.endMs) < 0.5);
      if (i >= 0) refs.push({ track: "zoom", index: i });
    }
    return { doc, refs };
  }

  /** Doc refs back to UI selections after the plan rebuilt (zoom via segment id). */
  private toUi(p: ProjectConfig, refs: BlockRef[]): Selection[] {
    const planZ = this.s.plan?.zoomSegments ?? p.zoom.segments;
    const out: Selection[] = [];
    for (const r of refs) {
      if (r.track !== "zoom") out.push({ track: r.track, index: r.index });
      else {
        const id = p.zoom.segments[r.index]?.id;
        const i = planZ.findIndex((z) => z.id === id);
        if (i >= 0) out.push({ track: "zoom", index: i });
      }
    }
    return out;
  }

  private duration(): number {
    return this.s.bundle?.meta.durationMs ?? Infinity;
  }

  private noun(n: number): string {
    return n === 1 ? "block" : `${n} blocks`;
  }

  /** Delete every selected block: one undo step. Returns how many were deleted. */
  deleteSelected(): number {
    const items = this.groupItems();
    if (!items.length) return 0;
    let n = 0;
    this.edit(`Delete ${this.noun(items.length)}`, (p) => {
      const { doc, refs } = this.toDoc(p, items);
      n = refs.length;
      return deleteBlocks(doc, refs);
    });
    this.set({ selection: null, editingText: null });
    return n;
  }

  /** Move every selected block by deltaMs (clamped as a group): one undo step. Returns the delta applied. */
  moveSelected(deltaMs: number, label?: string): number {
    const items = this.groupItems();
    if (!items.length || !deltaMs) return 0;
    let applied = 0;
    let moved: BlockRef[] = [];
    const prim = this.primaryAt();
    this.edit(label ?? `Move ${this.noun(items.length)}`, (p) => {
      const { doc, refs } = this.toDoc(p, items);
      const r = moveBlocks(doc, refs, deltaMs, this.duration());
      applied = r.deltaMs;
      moved = r.items;
      return applied ? r.project : p;
    });
    if (applied) this.reselect(moved, prim && { track: prim.track, atMs: prim.startMs + applied });
    return applied;
  }

  /** Arrow-key nudge: one output frame (or a second with big), as one undo step. */
  nudge(dir: -1 | 1, big = false): number {
    const fps = this.s.plan?.output.fps ?? this.s.bundle?.meta.fps ?? 30;
    return this.moveSelected(dir * (big ? 1000 : 1000 / fps), "Nudge");
  }

  private dragBase: { doc: ProjectConfig; refs: BlockRef[]; items: Selection[]; moved: BlockRef[]; delta: number; prim: { track: TrackKind; startMs: number } | null } | null = null;

  /** Group drag: begin (auto zooms freeze inside the gesture), preview(total delta), end = one undo step. */
  beginMoveSelected(): void {
    const items = this.groupItems();
    if (!items.length) return;
    this.beginGesture();
    const { doc, refs } = this.toDoc(this.history.doc, items);
    if (doc !== this.history.doc) this.preview(() => doc);
    this.dragBase = { doc, refs, items, moved: refs, delta: 0, prim: this.primaryAt() };
  }

  previewMoveSelected(totalDeltaMs: number): number {
    const b = this.dragBase;
    if (!b) return 0;
    const r = moveBlocks(b.doc, b.refs, totalDeltaMs, this.duration(), false);
    b.moved = r.items;
    b.delta = r.deltaMs;
    this.preview(() => r.project);
    return r.deltaMs;
  }

  endMoveSelected(): void {
    const b = this.dragBase;
    if (!b) return;
    this.dragBase = null;
    let refs = b.moved;
    this.endGesture(`Move ${this.noun(b.items.length)}`, (p) => {
      if (!refs.some((r) => r.track === "cut")) return p;
      const r = moveBlocks(p, refs, 0, this.duration());
      refs = r.items;
      return r.project;
    });
    this.reselect(refs, b.prim && { track: b.prim.track, atMs: b.prim.startMs + b.delta });
  }

  /** Duplicate every selected block right after the group: one undo step; the copies become the selection. */
  duplicateSelected(): number {
    const items = this.groupItems();
    if (!items.length) return 0;
    let copies: BlockRef[] = [];
    let skipped = 0;
    this.edit(`Duplicate ${this.noun(items.length)}`, (p) => {
      const { doc, refs } = this.toDoc(p, items);
      const r = duplicateBlocks(doc, refs, this.duration());
      copies = r.items;
      skipped = r.skipped;
      return copies.length ? r.project : p;
    });
    if (copies.length) this.reselect(copies, null);
    if (skipped) this.notify(`${skipped} block${skipped > 1 ? "s" : ""} had no room to duplicate`);
    return copies.length;
  }

  /** The primary block's track and start, to find it again after an edit. */
  private primaryAt(): { track: TrackKind; startMs: number } | null {
    const sel = this.s.selection;
    const r = sel && this.uiRange(sel);
    return sel && r ? { track: sel.track, startMs: r.startMs } : null;
  }

  /** Select `refs` (doc space) after an edit; the block holding `primary.atMs` on its track stays primary. */
  private reselect(refs: BlockRef[], primary: { track: TrackKind; atMs: number } | null): void {
    const ui = this.toUi(this.history.doc, refs);
    const prim = primary
      ? ui.find((x) => {
          const r = x.track === primary.track ? this.uiRange(x) : null;
          return !!r && primary.atMs >= r.startMs - 0.5 && primary.atMs <= r.endMs + 0.5;
        })
      : null;
    this.setSelection(ui, prim ?? null);
  }

  selectCanvas(which: EditorState["canvasSel"]): void {
    this.set({ canvasSel: which, selection: which ? null : this.s.selection });
  }

  setZoomPlacing(on: boolean): void {
    this.set({ zoomPlacing: on });
  }

  // ------------------------------------------------------------------ hand-written captions (Windows bug #15)

  private cueList(): CaptionCue[] {
    return this.history.doc.captions.cues ?? [];
  }

  private setCues(label: string, fn: (cues: CaptionCue[]) => CaptionCue[]): void {
    this.edit(label, (p) => ({ ...p, captions: { ...p.captions, enabled: true, cues: fn(p.captions.cues ?? []).sort((a, b) => a.startMs - b.startMs) } }));
  }

  updateCue(id: string, patch: Partial<CaptionCue>, label = "Edit caption"): void {
    this.setCues(label, (cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  deleteCue(id: string): void {
    this.setCues("Delete caption", (cs) => cs.filter((c) => c.id !== id));
    this.set({ selection: null });
  }

  /** Split a cue at the playhead (or its middle when the playhead is outside it). */
  splitCueAt(id: string, srcMs?: number): void {
    const c = this.cueList().find((x) => x.id === id);
    if (!c) return;
    const t = srcMs !== undefined && srcMs > c.startMs + 50 && srcMs < c.endMs - 50 ? srcMs : (c.startMs + c.endMs) / 2;
    const parts = splitCue(c, t, [c.id, `${c.id}-b${Date.now().toString(36)}`]);
    if (!parts) return;
    this.setCues("Split caption", (cs) => cs.flatMap((x) => (x.id === id ? parts : [x])));
  }

  /** Merge a cue with the next one in time. */
  mergeCueWithNext(id: string): void {
    const cs = [...this.cueList()].sort((a, b) => a.startMs - b.startMs);
    const i = cs.findIndex((x) => x.id === id);
    if (i < 0 || i >= cs.length - 1) {
      this.notify("No next caption to merge with");
      return;
    }
    const m = mergeCues(cs[i]!, cs[i + 1]!);
    const drop = cs[i + 1]!.id;
    this.setCues("Merge captions", (all) => all.filter((x) => x.id !== drop).map((x) => (x.id === id ? m : x)));
  }

  /** Turn an auto caption block into an editable cue (same timing and text). */
  cueFromBlock(startMs: number, endMs: number, text: string): void {
    const c: CaptionCue = { id: `cue-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`, startMs: Math.round(startMs), endMs: Math.round(endMs), text };
    this.setCues("Edit caption", (cs) => [...cs.filter((x) => !(x.startMs < c.endMs && c.startMs < x.endMs)), c]);
    const i = this.cueList().findIndex((x) => x.id === c.id);
    this.select({ track: "caption", index: i });
  }

  /** Import SRT / VTT: cue times are on the output clock, mapped back to source time through the plan. */
  importSubtitles(text: string, replace = true): number {
    let n = 0;
    const plan = this.s.plan;
    const toSrc = (ms: number) => {
      if (!plan || !plan.frames.length) return ms;
      const i = Math.max(0, Math.min(plan.frames.length - 1, Math.round((ms * plan.output.fps) / 1000)));
      const f = plan.frames[i]!;
      return f.src + (ms - f.t); // sub-frame remainder
    };
    const cues = parseSubtitles(text, () => `cue-${Date.now().toString(36)}${n++}`).map((c) => ({ ...c, startMs: Math.round(toSrc(c.startMs)), endMs: Math.round(toSrc(c.endMs)) })).filter((c) => c.endMs > c.startMs);
    if (!cues.length) {
      this.notify("No captions found in that file");
      return 0;
    }
    this.setCues(`Import ${cues.length} captions`, (cs) => (replace ? cues : [...cs, ...cues]));
    this.notify(`Imported ${cues.length} captions`);
    return cues.length;
  }

  /** Inline correction of transcript word i ("" hides it in captions; null restores the recognised text). */
  setWordEdit(i: number, text: string | null): void {
    this.edit("Edit word", (p) => {
      const we = { ...(p.captions.wordEdits ?? {}) };
      if (text === null) delete we[String(i)];
      else we[String(i)] = text;
      return { ...p, captions: { ...p.captions, wordEdits: we } };
    });
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

  // ------------------------------------------------------------------ 3D motion (feat/motion-3d)

  private durationMs(): number {
    return this.s.bundle?.meta.durationMs ?? Math.max(60_000, ...this.history.doc.motion3d.map((m) => m.endMs + 10_000));
  }

  /** Source time under the playhead. */
  playheadSrc(): number {
    return this.s.plan?.frames[this.s.frame]?.src ?? 0;
  }

  refreshMotion3dTemplates(): void {
    this.set({ motion3dTemplates: m3dLib.allMotion3dTemplates() });
  }

  /** The selected 3D block, or null. */
  selectedMotion3d(): { index: number; seg: Motion3DSegment } | null {
    const sel = this.s.selection;
    if (sel?.track !== "motion3d") return null;
    const seg = this.history.doc.motion3d[sel.index];
    return seg ? { index: sel.index, seg } : null;
  }

  /** Add a 3D block from a template at srcMs (default: playhead), selected. Returns its index or -1. */
  addMotion3d(templateId = "tilt-in", srcMs = this.playheadSrc()): number {
    const t = m3dLib.findMotion3dTemplate(templateId) ?? m3dLib.findMotion3dTemplate("tilt-in")!;
    const blocks = this.history.doc.motion3d;
    const duration = this.durationMs();
    let at = Math.max(0, srcMs);
    let r = null as { startMs: number; endMs: number } | null;
    for (let k = 0; k < 50 && !r; k++) {
      r = createRange(blocks, at, t.durationMs, duration, MIN_BLOCK_MS.motion3d);
      const inside = blocks.find((b) => at >= b.startMs && at < b.endMs);
      if (!r && inside) at = inside.endMs;
      else break;
    }
    if (!r) {
      this.notify("No room for a 3D block there");
      return -1;
    }
    const range = { startMs: Math.round(r.startMs), endMs: Math.round(r.endMs) };
    let index = -1;
    this.edit(`Add 3D ${t.name}`, (p) => {
      const out = addBlock(p, "motion3d", range, undefined, undefined, t);
      index = out.index;
      return out.project;
    });
    if (index >= 0) this.select({ track: "motion3d", index });
    return index;
  }

  /** Patch a 3D block's settings (easing, perspective, hold, ...): one undo step, or a live slider tweak. */
  updateMotion3d(index: number, patch: Partial<Motion3DSegment>, live = false, label = "Edit 3D motion"): void {
    const fn = (p: ProjectConfig) => mapSegment(p, index, (s) => {
      const out = { ...s, ...patch };
      for (const k of Object.keys(patch) as Array<keyof Motion3DSegment>) if (patch[k] === undefined) delete out[k];
      return out;
    });
    if (live) this.tweak(label, fn);
    else this.edit(label, fn);
  }

  deleteMotion3d(index: number): void {
    this.edit("Delete 3D motion", (p) => ({ ...p, motion3d: p.motion3d.filter((_, j) => j !== index) }));
    this.set({ selection: null, m3dKey: 0 });
  }

  /** Replace a block's motion with a template's (keeps its start). */
  applyMotion3dTemplate(index: number, templateId: string): void {
    const t = m3dLib.findMotion3dTemplate(templateId);
    const seg = this.history.doc.motion3d[index];
    if (!t || !seg) return;
    const next = this.history.doc.motion3d.filter((m, j) => j !== index && m.startMs >= seg.endMs).reduce((lo, m) => Math.min(lo, m.startMs), Infinity);
    // the template's length, up to the next 3D block or the end of the recording
    const maxEnd = Math.min(this.durationMs(), next);
    this.edit(`3D template ${t.name}`, (p) => mapSegment(p, index, (s) => applyTemplate(s, t, maxEnd)));
    this.set({ m3dKey: 0 });
  }

  selectMotion3dKey(k: number): void {
    const s = this.selectedMotion3d();
    if (!s) return;
    this.set({ m3dKey: Math.max(0, Math.min(keyCount(s.seg) - 1, k)) });
  }

  /** Edit the pose of keyframe k (default: the selected one) of block index. */
  setMotion3dPose(index: number, patch: Partial<Pose3D>, live = false, k = this.s.m3dKey): void {
    const fn = (p: ProjectConfig) => mapSegment(p, index, (s) => setKeyPose(s, k, patch));
    if (live) this.tweak("Edit 3D pose", fn);
    else this.edit("Edit 3D pose", fn);
  }

  /** Add a keyframe at srcMs (default: playhead) inside block index and select it. False when there is no room. */
  addMotion3dKey(index: number, srcMs = this.playheadSrc()): boolean {
    const seg = this.history.doc.motion3d[index];
    if (!seg) return false;
    if (seg.easing === "loop") {
      this.notify("Loop easing swings between the first and last pose: keyframes are not used");
      return false;
    }
    const res = addKeyAt(seg, srcMs);
    if (!res) {
      this.notify("Move the playhead inside the 3D block, away from its other keyframes, to add one");
      return false;
    }
    this.edit("Add 3D keyframe", (p) => mapSegment(p, index, () => res.seg));
    this.set({ m3dKey: res.key });
    return true;
  }

  deleteMotion3dKey(index: number, k = this.s.m3dKey): void {
    const seg = this.history.doc.motion3d[index];
    if (!seg || k <= 0 || k >= keyCount(seg) - 1) return;
    this.edit("Delete 3D keyframe", (p) => mapSegment(p, index, (s) => deleteKey(s, k)));
    this.set({ m3dKey: Math.max(0, k - 1) });
  }

  /** Alt+Arrow: turn the selected keyframe of the selected 3D block about an axis. False when no 3D block is selected. */
  nudgeMotion3d(axis: Axis3D, deg: number): boolean {
    const s = this.selectedMotion3d();
    if (!s) return false;
    const cur = keyPose(s.seg, this.s.m3dKey)[axis];
    this.tweak("Nudge 3D rotation", (p) => mapSegment(p, s.index, (x) => setKeyPose(x, this.s.m3dKey, { [axis]: Math.round(cur + deg) })));
    return true;
  }

  /** Save block index as a user template (localStorage). Returns the stored template. */
  saveMotion3dTemplate(index: number, name: string): Motion3DTemplate | null {
    const seg = this.history.doc.motion3d[index];
    const n = name.trim();
    if (!seg || !n) return null;
    const t = m3dLib.saveMotion3dTemplate(templateFromSegment(seg, n, n));
    this.refreshMotion3dTemplates();
    this.notify(`Saved 3D template ${t.name}`);
    return t;
  }

  deleteMotion3dTemplate(id: string): void {
    m3dLib.deleteMotion3dTemplate(id);
    this.refreshMotion3dTemplates();
  }

  // ------------------------------------------------------------------ style presets + brand kit (demand #9)

  refreshPresets(): void {
    this.set({ presets: lib.allPresets(), defaultPresetId: lib.defaultPresetId() });
  }

  /** Apply a style preset, whole or by section: one undo step. */
  applyStylePreset(id: string, sections: PresetSection[] = PRESET_SECTIONS): void {
    const pr = this.s.presets.find((x) => x.id === id);
    if (!pr || !sections.length) return;
    const partial = sections.length < PRESET_SECTIONS.filter((k) => pr.sections[k] !== undefined).length;
    const label = partial ? `Apply ${pr.name} (${sections.map((k) => SECTION_LABELS[k]).join(", ")})` : `Apply preset ${pr.name}`;
    this.edit(label, (p) => resolveProject(applyPreset(p, pr, sections)));
    this.notify(partial ? `Applied ${pr.name}: ${sections.map((k) => SECTION_LABELS[k].toLowerCase()).join(", ")}` : `Applied preset ${pr.name}`);
  }

  saveCurrentAsPreset(name: string): Preset | null {
    if (!name.trim()) return null;
    const pr = lib.addPreset(presetFromProject(this.history.doc, name.trim()));
    this.refreshPresets();
    this.notify(`Saved preset ${pr.name}`);
    return pr;
  }

  renameStylePreset(id: string, name: string): void {
    if (lib.renamePreset(id, name)) this.refreshPresets();
  }

  duplicateStylePreset(id: string): void {
    const pr = lib.duplicatePreset(id);
    this.refreshPresets();
    if (pr) this.notify(`Duplicated as ${pr.name}`);
  }

  deleteStylePreset(id: string): void {
    const name = this.s.presets.find((x) => x.id === id)?.name;
    if (lib.deletePreset(id)) {
      this.refreshPresets();
      this.notify(`Deleted preset ${name}`);
    }
  }

  setDefaultStylePreset(id: string | null): void {
    lib.setDefaultPreset(id);
    this.refreshPresets();
    this.notify(id ? `New projects start with ${this.s.presets.find((x) => x.id === id)?.name}` : "New projects start with Lens defaults");
  }

  /** The .lenspreset text of a preset (for Export). */
  presetFile(id: string): { name: string; text: string } | null {
    const pr = this.s.presets.find((x) => x.id === id);
    return pr ? { name: `${pr.id}.lenspreset`, text: serializePreset(pr) } : null;
  }

  importStylePreset(text: string, fileName = "preset"): Preset | null {
    try {
      const pr = lib.importPresetText(text);
      this.refreshPresets();
      this.notify(`Imported preset ${pr.name}`);
      return pr;
    } catch (e) {
      this.notify(`Could not import ${fileName}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** Brand kit edit: one undo step, or a live slider / colour tweak. */
  editBrand(label: string, fn: (b: BrandKit) => BrandKit, live = false): void {
    const f = (p: ProjectConfig) => ({ ...p, brand: fn(p.brand) });
    if (live) this.tweak(label, f);
    else this.edit(label, f);
  }

  private async upload(file: File): Promise<string> {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    const q = this.dirQuery();
    const r = await fetch(`/api/asset${q}${q ? "&" : "?"}name=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: btoa(bin) }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? String(r.status));
    return j.path as string;
  }

  /** Upload a logo image into the bundle (brand/) and use it (its aspect read from the file). */
  async uploadLogo(file: File): Promise<void> {
    try {
      const bm = await createImageBitmap(file);
      const aspect = Math.round((bm.width / bm.height) * 10000) / 10000;
      bm.close();
      const path = await this.upload(file);
      this.editBrand("Brand logo", (b) => ({ ...b, logo: { ...b.logo, path, aspect } }));
    } catch (e) {
      this.notify(`Could not use ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Upload an image into the bundle and use it as the backdrop (Windows bug #20; stays offline, in the bundle). */
  async uploadBackground(file: File): Promise<void> {
    try {
      const bm = await createImageBitmap(file);
      bm.close();
      const path = await this.upload(file);
      this.edit("Backdrop image", (p) => ({ ...p, background: { ...p.background, kind: "image", imagePath: path, fit: p.background.fit ?? "cover", inherit: false } }));
    } catch (e) {
      this.notify(`Could not use ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Add the user's own font files (regular, and bold if given) and make it the brand font. */
  async addBrandFont(files: File[]): Promise<void> {
    if (!files.length) return;
    try {
      const sorted = [...files].sort((a, b) => Number(/bold/i.test(a.name)) - Number(/bold/i.test(b.name)));
      const paths = await Promise.all(sorted.map((f) => this.upload(f)));
      const regular = paths[0]!;
      const bold = paths[1] ?? regular;
      const family = sorted[0]!.name.replace(/\.(ttf|otf)$/i, "").replace(/[-_ ](regular|bold|medium|book)$/i, "").replace(/[-_]/g, " ");
      this.editBrand(`Add font ${family}`, (b) => ({ ...b, font: family, customFonts: [...b.customFonts.filter((f) => f.family !== family), { family, regular, bold }] }));
    } catch (e) {
      this.notify(`Could not add the font: ${e instanceof Error ? e.message : String(e)}`);
    }
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
    // new items start from the applied preset's annotation styles (titles / lower-thirds keep their role sizes)
    const roleText = a.kind === "text" && (a.role === "title" || a.role === "lower-third");
    if (!roleText) a = { ...a, style: themedNewStyle(this.history.doc, a.kind, a.style) };
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

  /** Transcribe the mic track on-device (whisper.cpp, base.en); the words replace the bundle transcript. */
  async transcribe(auto = false): Promise<void> {
    if (this.s.transcribeRun && ["starting", "running"].includes(this.s.transcribeRun.state)) return;
    this.set({ transcribeRun: { id: "", state: "starting", done: 0, auto } });
    const q = this.dirQuery();
    const r = await fetch(`/api/transcribe${q}${auto ? (q ? "&" : "?") + "auto=1" : ""}`, { method: "POST" });
    const j = await r.json();
    if (!r.ok || j.state === "error") {
      this.set({ transcribeRun: { id: "", state: "error", done: 0, error: j.error, auto } });
      return;
    }
    const id = j.id as string;
    await new Promise<void>((resolve) => {
      const poll = async () => {
        const st = await (await fetch(`/api/transcribe/${id}${q}`)).json();
        this.set({ transcribeRun: { id, state: st.state, done: st.done, error: st.error, seconds: st.seconds, auto } });
        if (st.state === "running") {
          setTimeout(poll, 400);
          return;
        }
        if (st.state === "done" && this.s.bundle) {
          const transcript = parseTranscript(st.result);
          this.set({ bundle: { ...this.s.bundle, transcript } });
          this.rebuild(this.history.doc);
          this.notify(`Transcribed ${transcript.words.length} words`);
        }
        resolve();
      };
      setTimeout(poll, 200);
    });
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

  // ------------------------------------------------------------------ caption translation (demand #8)

  /** Caption language for the preview and the burned-in captions (null = source transcript); one undo step. */
  setCaptionLanguage(language: string | null): void {
    if ((this.history.doc.translations.language ?? null) === language) return;
    const name = language ? this.history.doc.translations.tracks.find((t) => t.language === language)?.name ?? language : "source";
    this.edit(`Captions: ${name}`, (p) => ({ ...p, translations: { ...p.translations, language } }));
  }

  /** Translate the transcript on-device (dev server: translate/lens-translate); adds one track per language, one undo step. */
  async translateCaptions(langs: string[], select = true): Promise<void> {
    if (this.s.translateRun && ["starting", "running"].includes(this.s.translateRun.state)) return;
    this.set({ translateRun: { id: "", state: "starting", stage: "start", language: langs[0] ?? "", index: 0, languages: langs.length, done: 0, total: 0 } });
    const q = this.dirQuery();
    const r = await fetch(`/api/translate${q}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ langs }) });
    const j = await r.json();
    if (!r.ok || j.state === "error") {
      this.set({ translateRun: { id: "", state: "error", stage: "", language: "", index: 0, languages: langs.length, done: 0, total: 0, error: j.error } });
      return;
    }
    const id = j.id as string;
    await new Promise<void>((resolve) => {
      const poll = async () => {
        const st = await (await fetch(`/api/translate/${id}${q}`)).json();
        this.set({ translateRun: { id, state: st.state, stage: st.stage, language: st.language, index: st.index, languages: st.languages, done: st.done, total: st.total, error: st.error, seconds: st.seconds } });
        if (st.state === "running") {
          setTimeout(poll, 250);
          return;
        }
        if (st.state === "done") {
          const tracks = st.result.tracks as CaptionTrack[];
          const names = tracks.map((t) => t.name ?? t.language).join(", ");
          this.edit(`Translate captions to ${names}`, (p) => {
            let tr = p.translations;
            for (const t of tracks) tr = upsertTrack(tr, t);
            return { ...p, translations: { ...tr, language: select ? tracks[0]!.language : tr.language } };
          });
          this.notify(`Translated ${tracks[0]?.segments.length ?? 0} segments to ${names}`);
        }
        resolve();
      };
      setTimeout(poll, 150);
    });
  }

  /** Side-by-side editing: replace one segment's translation (re-timed by the engine), one undo step per commit. */
  editTranslation(language: string, segmentId: string, text: string): void {
    const tr = this.history.doc.translations.tracks.find((t) => t.language === language);
    const seg = tr?.segments.find((s) => s.id === segmentId);
    if (!tr || !seg || seg.text === text.replace(/\s+/g, " ").trim()) return;
    this.edit(`Edit ${tr.name ?? language} caption`, (p) => ({
      ...p,
      translations: { ...p.translations, tracks: p.translations.tracks.map((t) => (t.language === language ? editSegment(t, segmentId, text) : t)) },
    }));
  }

  removeTranslation(language: string): void {
    const tr = this.history.doc.translations.tracks.find((t) => t.language === language);
    if (!tr) return;
    this.edit(`Remove ${tr.name ?? language} captions`, (p) => ({
      ...p,
      translations: { language: p.translations.language === language ? null : p.translations.language, tracks: p.translations.tracks.filter((t) => t.language !== language) },
    }));
  }

  /** SRT or WebVTT of the captions in one language on the output clock (cuts, speed and slides applied). */
  subtitleFile(language: string | null, kind: "srt" | "vtt"): { name: string; text: string } | null {
    const b = this.s.bundle;
    if (!b) return null;
    const p = this.history.doc;
    const proj = { ...p, captions: { ...p.captions, enabled: true }, translations: { ...p.translations, language } };
    const plan = buildRenderPlan({ meta: b.meta, events: b.events, project: proj, words: b.transcript?.words ?? [], pauses: planPauses(b), onlyFrames: [0] });
    const lang = language ?? (b.transcript?.language || "en");
    return { name: `captions.${lang}.${kind}`, text: kind === "srt" ? toSrt(plan.subtitles) : toVtt(plan.subtitles, lang) };
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
    if ((await this.exportPath()) === "browser") return this.exportInBrowser();
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

  private exportPathP: Promise<"browser" | "compositor"> | null = null;
  /** Which export path the server offers (/api/capabilities; older servers: the compositor). */
  exportPath(): Promise<"browser" | "compositor"> {
    if (!this.exportPathP)
      this.exportPathP = fetch("/api/capabilities")
        .then((r) => (r.ok ? r.json() : {}))
        .then((j: { export?: string }) => (j.export === "browser" ? "browser" : "compositor"))
        .catch(() => "compositor" as const);
    return this.exportPathP;
  }

  /**
   * Export without the Python compositor (desktop app): every plan frame is drawn with the preview's
   * renderer into an offscreen canvas and posted as a JPEG; the server pipes them into ffmpeg and
   * mixes the plan's audio (server/browserExport.ts).
   */
  private exportWorker: Worker | null = null;
  private exportCancel = false;

  /** Stop a running export (Windows bug #11): the worker stops between frames and ffmpeg is killed. */
  async cancelExport(): Promise<void> {
    const ex = this.s.exporting;
    if (!ex || (ex.state !== "running" && ex.state !== "starting")) return;
    this.exportCancel = true;
    this.exportWorker?.postMessage({ type: "cancel" });
    this.exportWorker?.terminate();
    this.exportWorker = null;
    if (ex.id) await fetch(`/api/export-browser/${ex.id}/cancel${this.dirQuery()}`, { method: "POST" }).catch(() => undefined);
    this.set({ exporting: { ...ex, state: "error", error: "Export cancelled" } });
    this.notify("Export cancelled");
  }

  private async exportInBrowser(): Promise<void> {
    const b = this.s.bundle;
    if (!b || !this.screen) return;
    this.exportCancel = false;
    const plan = buildPlan(b, this.s.project);
    const total = plan.frames.length;
    const t0 = performance.now();
    const fail = (error: string, id = "", done = 0) => this.set({ exporting: { id, state: "error", done, total, error, path: "browser" } });
    this.set({ exporting: { id: "", state: "starting", done: 0, total, path: "browser" } });
    const r = await fetch(`/api/export-browser${this.dirQuery()}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: this.s.project }) });
    const j = await r.json();
    if (!r.ok) return fail(j.error);
    const id = j.id as string;
    if (j.total !== total) return fail(`plan mismatch: server ${j.total} frames, editor ${total}`, id);
    if (this.exportCancel) return;
    this.set({ exporting: { id, state: "running", done: 0, total, path: "browser", seconds: 0 } });
    const q = this.dirQuery();
    const rendered = (globalThis as { __lensNoExportWorker?: boolean }).__lensNoExportWorker || typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined"
      ? await this.renderOnPage(plan, id, q, t0)
      : await this.renderInWorker(plan, id, q, t0);
    if (!rendered) return;
    const poll = async () => {
      const s = await (await fetch(`/api/export/${id}${q}`)).json();
      if (this.exportCancel) return;
      if (s.state === "running") return void setTimeout(poll, 300);
      this.set({ exporting: { id, state: s.state, done: s.done, total: s.total, error: s.error, seconds: (performance.now() - t0) / 1000, path: "browser" } });
      if (s.state === "done") this.notify("Export finished");
    };
    setTimeout(poll, 200);
  }

  /** Frames drawn and encoded in a Web Worker: the editor stays responsive during a long export. */
  private renderInWorker(plan: RenderPlan, id: string, q: string, t0: number): Promise<boolean> {
    return new Promise((resolve) => {
      const w = new Worker(new URL("../export/exportWorker.ts", import.meta.url), { type: "module" });
      this.exportWorker = w;
      const total = plan.frames.length;
      w.onmessage = (e: MessageEvent) => {
        const m = e.data as { type: string; done?: number; error?: string };
        if (this.exportCancel) return;
        if (m.type === "progress") this.set({ exporting: { id, state: "running", done: m.done ?? 0, total, path: "browser", seconds: (performance.now() - t0) / 1000 } });
        else {
          w.terminate();
          this.exportWorker = null;
          if (m.type === "rendered") resolve(true);
          else {
            if (m.type === "error") this.set({ exporting: { id, state: "error", done: m.done ?? 0, total, error: m.error, path: "browser" } });
            resolve(false);
          }
        }
      };
      w.onerror = (e) => {
        this.exportWorker = null;
        this.set({ exporting: { id, state: "error", done: 0, total, error: `export worker: ${e.message}`, path: "browser" } });
        resolve(false);
      };
      const scr = this.screen!;
      const cam = this.cam && this.s.project.camera.enabled ? this.cam : null;
      w.postMessage({ type: "start", id, plan, query: q, screen: { count: scr.count, fps: scr.fps }, cam: cam ? { count: cam.count, fps: cam.fps } : null });
    });
  }

  /** Fallback without workers / OffscreenCanvas: the same loop on the page, yielding between frames. */
  private async renderOnPage(plan: RenderPlan, id: string, q: string, t0: number): Promise<boolean> {
    const total = plan.frames.length;
    await ensurePlanAssets(plan);
    const renderer = new PlanRenderer();
    const canvas = makeCanvas(plan.output.width, plan.output.height);
    const g = canvas.getContext("2d") as CanvasRenderingContext2D;
    const sep = q ? "&" : "?";
    const scrStore = new FrameStore("screen", this.screen!.count, this.screen!.fps, q, 6, true);
    const camStore = this.cam && this.s.project.camera.enabled ? new FrameStore("cam", this.cam.count, this.cam.fps, q, 6, true) : null;
    for (let i = 0; i < total; i++) {
      if (this.exportCancel) return false;
      const f = plan.frames[i]!;
      const si = scrStore.indexAt(f.src);
      const ci = camStore ? camStore.indexAt(f.src) : 0;
      const [scr, cam] = await Promise.all([scrStore.load(si), camStore ? camStore.load(ci) : Promise.resolve(null)]);
      renderer.draw(g, plan, i, { screen: scr, cam });
      scrStore.releaseBelow(si);
      camStore?.releaseBelow(ci);
      const blob = "convertToBlob" in canvas ? await canvas.convertToBlob({ type: "image/jpeg", quality: 0.95 }) : await new Promise<Blob>((res) => (canvas as HTMLCanvasElement).toBlob((x) => res(x!), "image/jpeg", 0.95));
      const fr = await fetch(`/api/export-browser/${id}/frame${q}${sep}i=${i}`, { method: "POST", body: blob });
      if (!fr.ok) {
        this.set({ exporting: { id, state: "error", done: i, total, error: (await fr.json()).error ?? `frame ${i} failed`, path: "browser" } });
        return false;
      }
      if (i % 5 === 0 || i === total - 1) this.set({ exporting: { id, state: "running", done: i + 1, total, path: "browser", seconds: (performance.now() - t0) / 1000 } });
      await new Promise((res) => setTimeout(res, 0)); // let input and paint through
    }
    await fetch(`/api/export-browser/${id}/finish${q}`, { method: "POST" });
    return true;
  }

  // ------------------------------------------------------------------ interactive demo / step guide (demand #7)

  openExportDialog(tab: "video" | "demo" | "guide" = "video"): void {
    this.set({ exportDialog: { tab } });
  }

  setExportTab(tab: "video" | "demo" | "guide"): void {
    this.set({ exportDialog: { tab } });
  }

  closeExportDialog(): void {
    this.set({ exportDialog: null });
  }

  editDemo(label: string, fn: (d: DemoSettings) => DemoSettings, live = false): void {
    const f = (p: ProjectConfig) => ({ ...p, demo: fn(p.demo) });
    if (live) this.tweak(label, f);
    else this.edit(label, f);
  }

  /** Hotspot editor: move a step's hotspot (source px) and / or change its tooltip; null clears. */
  setHotspot(stepId: string, patch: { x?: number | null; y?: number | null; tooltip?: string | null } | null, label = "Move hotspot"): void {
    this.edit(label, (p) => setDemoHotspot(p, stepId, patch));
  }

  stepsExportUrl(kind: "demo" | "guide", file: string): string | null {
    const run = this.s.stepsExport[kind];
    if (!run || run.state !== "done") return null;
    return `/api/steps-export/${run.id}/file/${file}${this.dirQuery()}`;
  }

  /** Build the interactive demo or the step guide from the current project (dev server: compositor/export_steps.py). */
  async buildStepsExport(kind: "demo" | "guide"): Promise<void> {
    const cur = this.s.stepsExport[kind];
    if (cur && ["starting", "running"].includes(cur.state)) return;
    const builtFrom = JSON.stringify({ steps: this.s.project.stepLabels, demo: { ...this.s.project.demo, hotspots: [] } });
    const put = (run: StepsExportRun) => this.set({ stepsExport: { ...this.s.stepsExport, [kind]: run } });
    put({ id: "", state: "starting", builtFrom });
    const q = this.dirQuery();
    const r = await fetch(`/api/steps-export${q}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: this.s.project, kind }) });
    const j = await r.json();
    if (!r.ok) {
      put({ id: "", state: "error", error: j.error, builtFrom });
      return;
    }
    const id = j.id as string;
    await new Promise<void>((resolve) => {
      const poll = async () => {
        const st = await (await fetch(`/api/steps-export/${id}${q}`)).json();
        put({ id, state: st.state, error: st.error, seconds: st.seconds, builtFrom });
        if (st.state === "running") {
          setTimeout(poll, 300);
          return;
        }
        if (st.state === "done") this.notify(kind === "demo" ? "Interactive demo ready" : "Step guide ready");
        resolve();
      };
      setTimeout(poll, 200);
    });
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

export interface StepsExportRun {
  id: string;
  state: "starting" | "running" | "done" | "error";
  error?: string;
  seconds?: number;
  /** Changes to the project since this build (tooltips / hotspots apply live; CTA / steps need a rebuild). */
  builtFrom?: string;
}

export const store = new EditorStore();

/**
 * Project segment index of the selected zoom (selection indices are plan.zoomSegments indices,
 * mapped by segment id); -1 when no zoom is selected or it is a live auto zoom. Pure on the state,
 * so it works as a useEditor selector.
 */
export function selectedZoomDocIndex(s: EditorState): number {
  const sel = s.selection;
  if (sel?.track !== "zoom") return -1;
  return zoomDocIndex(s.project, s.plan?.zoomSegments ?? s.project.zoom.segments, sel.index);
}

export function useEditor<T>(sel: (s: EditorState) => T): T {
  return useSyncExternalStore(store.subscribe, () => sel(store.get()));
}
