/**
 * Transition and enter / exit controls (demand #14): the project's cut transition default (Look tab),
 * a cut's own transition (selection card), and the enter / exit pickers shared by text slides, brand
 * title cards and the webcam.
 */
import { CAMERA_ANIM_KINDS, CUT_TRANSITION_KINDS, EASINGS, SLIDE_ANIM_KINDS, type CameraAnimKind, type CutTransitionKind, type Easing, type ElementAnim, type ProjectConfig, type SlideAnimKind } from "@lens/engine";
import { store } from "../state/store";
import { EASING_LABELS, effectiveCutTransition, projectTransitions, setCutTransition, setProjectTransitions, TRANSITION_LABELS } from "../state/transitionOps";
import { Section, Select, Slider, Toggle } from "./Controls";

const secs = (v: number) => `${(v / 1000).toFixed(2)} s`;
const EASING_OPTS = EASINGS.map((e) => ({ value: e, label: EASING_LABELS[e] }));

/** Look tab: the transition every cut gets unless it has its own. */
export function TransitionsSection({ p }: { p: ProjectConfig }) {
  const t = projectTransitions(p);
  const set = (label: string, patch: Parameters<typeof setProjectTransitions>[1], drag = false) =>
    (drag ? store.tweak : store.edit).call(store, label, (q: ProjectConfig) => setProjectTransitions(q, patch));
  const n = p.edits.cuts.length;
  return (
    <Section title="Cut transitions" aside={<span className="stat" data-testid="tr-stat">{n} cut{n === 1 ? "" : "s"}</span>}>
      <Select<CutTransitionKind>
        label="Style"
        value={t.kind}
        testId="tr-kind"
        options={CUT_TRANSITION_KINDS.map((k) => ({ value: k, label: TRANSITION_LABELS[k] }))}
        onChange={(v) => set(`Cut transitions: ${TRANSITION_LABELS[v]}`, { kind: v })}
      />
      <Slider defaultValue={500} label="Length" value={t.durationMs} min={100} max={2000} step={20} format={secs} testId="tr-duration" disabled={t.kind === "none"} onChange={(v) => set("Transition length", { durationMs: v }, true)} />
      <Select<Easing> label="Easing" value={t.easing} testId="tr-easing" disabled={t.kind === "none"} options={EASING_OPTS} onChange={(v) => set("Transition easing", { easing: v })} />
      <Toggle label="Also on cleanup & retake cuts" value={t.scope === "all"} testId="tr-scope" disabled={t.kind === "none"} onChange={(v) => set(v ? "Transitions on every cut" : "Transitions on my cuts only", { scope: v ? "all" : "manual" })} />
      <p className="note">Centred on each cut; the other side holds still while they blend, so nothing that was cut shows and the length stays the same. Pick a different one per cut with the dot on its timeline block.</p>
    </Section>
  );
}

/** Selection card body for a cut: its own transition or the project default. */
export function CutTransitionControls({ p, index }: { p: ProjectConfig; index: number }) {
  const eff = effectiveCutTransition(p, index);
  const own = p.edits.cuts[index]?.transition ?? null;
  const def = projectTransitions(p);
  type Opt = CutTransitionKind | "default";
  return (
    <>
      <Select<Opt>
        label="Transition"
        value={own?.kind ?? "default"}
        testId="sel-cut-transition"
        options={[{ value: "default", label: `Project default (${TRANSITION_LABELS[def.kind]})` }, ...CUT_TRANSITION_KINDS.map((k) => ({ value: k as Opt, label: TRANSITION_LABELS[k] }))]}
        onChange={(v) => store.edit(v === "default" ? "Cut transition: project default" : `Cut transition: ${TRANSITION_LABELS[v]}`, (q) => setCutTransition(q, index, v === "default" ? null : { kind: v }))}
      />
      <Slider
        defaultValue={def.durationMs}
        label="Length"
        value={eff.durationMs}
        min={100}
        max={2000}
        step={20}
        format={secs}
        testId="sel-cut-tr-duration"
        disabled={eff.kind === "none"}
        onChange={(v) => store.tweak("Cut transition length", (q) => setCutTransition(q, index, { durationMs: v }))}
      />
      <Select<Easing> label="Easing" value={eff.easing} testId="sel-cut-tr-easing" disabled={eff.kind === "none"} options={EASING_OPTS} onChange={(v) => store.edit("Cut transition easing", (q) => setCutTransition(q, index, { easing: v }))} />
    </>
  );
}

const SLIDE_LABELS: Record<SlideAnimKind, string> = { none: "None", fade: "Fade", "slide-up": "Slide up", "slide-down": "Slide down", "slide-left": "Slide left", "slide-right": "Slide right", zoom: "Zoom", blur: "Blur in" };
const CAMERA_LABELS: Record<CameraAnimKind, string> = { none: "None (instant)", fade: "Fade", pop: "Pop", slide: "Slide from the side", scale: "Grow" };

/**
 * One enter or exit picker: kind (plus "Default", which keeps the element's legacy look), duration and
 * easing. `onChange(null)` clears it back to the default.
 */
export function AnimPicker<K extends string>({ label, value, kinds, labels, defaultLabel, defaultMs, testId, onChange }: {
  label: string;
  value: ElementAnim<K> | null | undefined;
  kinds: readonly K[];
  labels: Record<K, string>;
  defaultLabel: string;
  defaultMs: number;
  testId: string;
  onChange: (v: ElementAnim<K> | null, label: string, drag?: boolean) => void;
}) {
  type Opt = K | "default";
  return (
    <div className="anim-picker" data-testid={testId}>
      <Select<Opt>
        label={label}
        value={(value?.kind ?? "default") as Opt}
        testId={`${testId}-kind`}
        options={[{ value: "default" as Opt, label: defaultLabel }, ...kinds.map((k) => ({ value: k as Opt, label: labels[k] }))]}
        onChange={(v) => onChange(v === "default" ? null : { ms: value?.ms ?? defaultMs, ...(value?.easing ? { easing: value.easing } : {}), kind: v as K }, `${label}: ${v === "default" ? defaultLabel : labels[v as K]}`)}
      />
      {value && value.kind !== "none" && (
        <>
          <Slider defaultValue={defaultMs} label="Length" value={value.ms} min={50} max={2000} step={10} format={secs} testId={`${testId}-ms`} onChange={(v) => onChange({ ...value, ms: v }, `${label} length`, true)} />
          <Select<Easing> label="Easing" value={value.easing ?? "ease-out"} testId={`${testId}-easing`} options={EASING_OPTS} onChange={(v) => onChange({ ...value, easing: v }, `${label} easing`)} />
        </>
      )}
    </div>
  );
}

export function SlideAnimPickers({ enter, exit, onChange, testPrefix }: {
  enter: ElementAnim<SlideAnimKind> | null | undefined;
  exit: ElementAnim<SlideAnimKind> | null | undefined;
  onChange: (side: "enter" | "exit", v: ElementAnim<SlideAnimKind> | null, label: string, drag?: boolean) => void;
  testPrefix: string;
}) {
  return (
    <>
      <AnimPicker label="Enter" value={enter} kinds={SLIDE_ANIM_KINDS} labels={SLIDE_LABELS} defaultLabel="Default (cross-fade)" defaultMs={400} testId={`${testPrefix}-enter`} onChange={(v, l, d) => onChange("enter", v, l, d)} />
      <AnimPicker label="Exit" value={exit} kinds={SLIDE_ANIM_KINDS} labels={SLIDE_LABELS} defaultLabel="Default (cross-fade)" defaultMs={400} testId={`${testPrefix}-exit`} onChange={(v, l, d) => onChange("exit", v, l, d)} />
    </>
  );
}

/** Webcam tab: how the overlay appears and leaves where a layout segment shows or hides it. */
export function CameraAnimSection({ p }: { p: ProjectConfig }) {
  const set = (side: "enter" | "exit") => (v: ElementAnim<CameraAnimKind> | null, label: string, drag?: boolean) =>
    (drag ? store.tweak : store.edit).call(store, `Webcam ${label.toLowerCase()}`, (q: ProjectConfig) => {
      const camera = { ...q.camera };
      if (v) camera[side] = v;
      else delete camera[side];
      return { ...q, camera };
    });
  return (
    <Section title="Enter / exit">
      <AnimPicker label="Enter" value={p.camera.enter} kinds={CAMERA_ANIM_KINDS} labels={CAMERA_LABELS} defaultLabel="Default (grow)" defaultMs={450} testId="cam-enter" onChange={set("enter")} />
      <AnimPicker label="Exit" value={p.camera.exit} kinds={CAMERA_ANIM_KINDS} labels={CAMERA_LABELS} defaultLabel="Default (shrink)" defaultMs={350} testId="cam-exit" onChange={set("exit")} />
      <p className="note">Plays where a webcam layout segment shows or hides the camera.</p>
    </Section>
  );
}
