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
import { buildRenderPlan, editSegment, toSrt, toVtt, upsertTrack, type CaptionTrack } from "@lens/engine";
import { applyPrivacyScan, applyStepDrafts, applyZoomPreset, cutsForDeletedWords, editStepLabel, isFiller, privacyCounts, resolveProject, reviewPrivacy, reviewSteps, setPrivacyMaskKind, withTakeChoice } from "@lens/engine";
import type { Annotation, PrivacyDetection, PrivacySettings, PrivacyState, ProjectConfig, RenderPlan, StepDraft, TakeSettings, TakeStrategy, TextSlide, ZoomPresetName } from "@lens/engine";
import { AudioEngine } from "../media/audio";
import { FrameStore } from "../media/frames";
import { makeCanvas, PlanRenderer } from "../render/renderer";
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
      setAssetBundle(q);
      this.refreshPresets();
      // a new recording (no project.json yet) starts from the user's default preset
      const def = bundle.isNew ? this.s.presets.find((x) => x.id === this.s.defaultPresetId) : undefined;
      if (def) bundle.project = resolveProject(applyPreset(bundle.project, def));
      this.screen = new FrameStore("screen", bundle.screen.frames, bundle.screen.fps, q, maxBitmaps);
      this.cam = bundle.camera ? new FrameStore("cam", bundle.camera.frames, bundle.camera.fps, q, maxBitmaps) : null;
      this.history.reset(bundle.project);
      this.set({ bundle, status: "ready", error: null, frame: 0, selection: null, selectedWords: [], savedAt: null, dirty: false });
      this.rebuild(bundle.project);
      void this.audio.load(bundle.project.audio.tracks.find((t) => !t.muted)?.path ?? null);
      if (def) this.notify(`New project: default preset ${def.name} applied`);
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
    const plan = buildRenderPlan({ meta: b.meta, events: b.events, project: proj, words: b.transcript?.words ?? [], pauses: b.transcript?.pauses, onlyFrames: [0] });
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
  private async exportInBrowser(): Promise<void> {
    const b = this.s.bundle;
    if (!b || !this.screen) return;
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
    await ensurePlanAssets(plan);
    const renderer = new PlanRenderer();
    const canvas = makeCanvas(plan.output.width, plan.output.height);
    const g = canvas.getContext("2d") as CanvasRenderingContext2D;
    const q = this.dirQuery();
    const sep = q ? "&" : "?";
    // own frame stores with a small window, released behind the playhead, so a long export does not
    // keep every source frame in memory (the preview's stores are left alone)
    const scrStore = new FrameStore("screen", this.screen.count, this.screen.fps, q, 6);
    const camStore = this.cam && this.s.project.camera.enabled ? new FrameStore("cam", this.cam.count, this.cam.fps, q, 6) : null;
    for (let i = 0; i < total; i++) {
      const f = plan.frames[i]!;
      const si = scrStore.indexAt(f.src);
      const ci = camStore ? camStore.indexAt(f.src) : 0;
      const [scr, cam] = await Promise.all([scrStore.load(si), camStore ? camStore.load(ci) : Promise.resolve(null)]);
      renderer.draw(g, plan, i, { screen: scr, cam });
      scrStore.releaseBelow(si);
      camStore?.releaseBelow(ci);
      const blob = "convertToBlob" in canvas ? await canvas.convertToBlob({ type: "image/jpeg", quality: 0.95 }) : await new Promise<Blob>((res) => (canvas as HTMLCanvasElement).toBlob((x) => res(x!), "image/jpeg", 0.95));
      const fr = await fetch(`/api/export-browser/${id}/frame${q}${sep}i=${i}`, { method: "POST", body: blob });
      if (!fr.ok) return fail((await fr.json()).error ?? `frame ${i} failed`, id, i);
      if (i % 5 === 0 || i === total - 1) this.set({ exporting: { id, state: "running", done: i + 1, total, path: "browser", seconds: (performance.now() - t0) / 1000 } });
    }
    await fetch(`/api/export-browser/${id}/finish${q}`, { method: "POST" });
    const poll = async () => {
      const s = await (await fetch(`/api/export/${id}${q}`)).json();
      if (s.state === "running") return void setTimeout(poll, 300);
      this.set({ exporting: { id, state: s.state, done: s.done, total: s.total, error: s.error, seconds: (performance.now() - t0) / 1000, path: "browser" } });
      if (s.state === "done") this.notify("Export finished");
    };
    setTimeout(poll, 200);
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

export function useEditor<T>(sel: (s: EditorState) => T): T {
  return useSyncExternalStore(store.subscribe, () => sel(store.get()));
}
