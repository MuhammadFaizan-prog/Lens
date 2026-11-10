/**
 * Inspector controls for 3D motion (feat/motion-3d): the selected block's card (template grid,
 * keyframes, pose sliders, timing) and the "3D motion" section of the Look tab that adds a block.
 * Every control goes through the store's motion3d methods, so each change is one undo step.
 *
 * fix/3d-inspector-014: every control has a reset (↺, or double-click its slider) and a typed value
 * field; "Reset keyframe" / "Reset all"; an editable time per interior keyframe; the template list is
 * a tile grid with a small 3D thumbnail of each template's pose (Motion3dTemplateGrid), shared by
 * the Look tab and the block's card.
 */
import { useState } from "react";
import { DEFAULT_PERSPECTIVE, EASINGS_3D, type Easing3D, type Motion3DSegment, type Pose3D } from "@lens/engine";
import { store, useEditor } from "../state/store";
import { keyAt, keyAtRange, keyCount, keyPose } from "../state/motion3dOps";
import { timecode } from "../state/timelineOps";
import { Section, Segmented, Select, Slider, Toggle } from "./Controls";
import { Icon } from "./Icon";

const EASING_LABEL: Record<Easing3D, string> = { spring: "Spring", "ease-in-out": "Ease in-out", "ease-out": "Ease out", "ease-in": "Ease in", linear: "Linear", loop: "Loop" };
const deg = (v: number) => `${Math.round(v)}°`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const px = (v: number) => `${Math.round(v)} px`;
const sec = (v: number) => `${(v / 1000).toFixed(1)} s`;
const sec2 = (v: number) => `${(v / 1000).toFixed(2)} s`;

/** Template id as segments record it ("user:<id>" for saved ones). */
const tplKey = (t: { id: string; user?: boolean }) => (t.user ? `user:${t.id}` : t.id);

function keyName(s: Motion3DSegment, k: number): string {
  if (k === 0) return "Start";
  if (k === keyCount(s) - 1) return "End";
  return `Key ${k}`;
}

/** Pose sliders: typed values may go past the slider (angles to +-3600, the engine takes any). */
const POSE_CTL: Array<{ k: keyof Pose3D; label: string; min: number; max: number; step: number; f: (v: number) => string; lo: number; hi: number; def: number }> = [
  { k: "rx", label: "Rotate X", min: -180, max: 180, step: 1, f: deg, lo: -3600, hi: 3600, def: 0 },
  { k: "ry", label: "Rotate Y", min: -180, max: 180, step: 1, f: deg, lo: -3600, hi: 3600, def: 0 },
  { k: "rz", label: "Rotate Z", min: -180, max: 180, step: 1, f: deg, lo: -3600, hi: 3600, def: 0 },
  { k: "tx", label: "Move X", min: -0.5, max: 0.5, step: 0.01, f: pct, lo: -2, hi: 2, def: 0 },
  { k: "ty", label: "Move Y", min: -0.5, max: 0.5, step: 0.01, f: pct, lo: -2, hi: 2, def: 0 },
  { k: "tz", label: "Move Z", min: -1500, max: 1000, step: 10, f: px, lo: -20000, hi: 1900, def: 0 },
  { k: "scale", label: "Scale", min: 0.3, max: 2, step: 0.01, f: (v) => `${v.toFixed(2)}×`, lo: 0.05, hi: 10, def: 1 },
];

export function Motion3dCard({ index, seg }: { index: number; seg: Motion3DSegment }) {
  const templates = useEditor((s) => s.motion3dTemplates);
  const k = useEditor((s) => s.m3dKey);
  const fps = useEditor((s) => s.plan?.output.fps ?? 30);
  const [name, setName] = useState("");
  const n = keyCount(seg);
  const key = Math.min(k, n - 1);
  const pose = keyPose(seg, key);
  const loop = seg.easing === "loop";
  const dur = seg.endMs - seg.startMs;
  const set = (patch: Parameters<typeof store.setMotion3dPose>[1]) => store.setMotion3dPose(index, patch, true, key);
  const upd = (patch: Partial<Motion3DSegment>, label: string, live = false) => store.updateMotion3d(index, patch, live, label);
  const interior = key > 0 && key < n - 1;
  const [atLo, atHi] = keyAtRange(seg, key);
  return (
    <div className="selection-card m3d-card" data-testid="selection-card">
      <div className="sel-head">
        <span className="dot dot-motion3d" />
        <b>3D motion</b>
        <span className="sel-time">
          {timecode(seg.startMs, fps)} – {timecode(seg.endMs, fps)}
        </span>
        <button className="icon-btn danger" title="Delete this 3D block (Del)" aria-label="Delete selection" data-testid="delete-selection" onClick={() => store.deleteMotion3d(index)}>
          <Icon name="trash" />
        </button>
      </div>

      <div className="m3d-grid" role="list" aria-label="3D templates" data-testid="m3d-templates">
        {templates.map((t) => {
          const id = tplKey(t);
          return (
            <div key={id} role="listitem" className={`m3d-tpl ${seg.template === id ? "on" : ""} ${t.user ? "user" : ""}`}>
              <button type="button" title={`Apply ${t.name} (${sec(t.durationMs)})`} data-testid={`m3d-tpl-${id}`} aria-pressed={seg.template === id} onClick={() => store.applyMotion3dTemplate(index, id)}>
                {t.name}
              </button>
              {t.user && (
                <button type="button" className="m3d-tpl-del" title={`Delete saved template ${t.name}`} aria-label={`Delete template ${t.name}`} data-testid={`m3d-tpl-del-${t.id}`} onClick={() => store.deleteMotion3dTemplate(t.id)}>
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="m3d-keys" data-testid="m3d-keys">
        <span className="ctl-label">Keyframes</span>
        <div className="m3d-key-list" role="listbox" aria-label="Keyframes">
          {Array.from({ length: n }, (_, i) => {
            const unused = loop && i > 0 && i < n - 1;
            return (
              <button
                key={i}
                type="button"
                role="option"
                aria-selected={i === key}
                className={`m3d-key ${i === key ? "on" : ""} ${unused ? "unused" : ""}`}
                data-testid={`m3d-key-${i}`}
                data-m3d-key={i}
                title={`${keyName(seg, i)} at ${timecode(seg.startMs + keyAt(seg, i) * dur, fps)}${unused ? " (not used while Loop is on)" : ""}${i > 0 && i < n - 1 ? " · Del deletes it" : ""}`}
                onClick={() => store.seekMotion3dKey(index, i)}
              >
                <span className="m3d-key-dia" aria-hidden="true" />
                {keyName(seg, i)} <small>{sec2(keyAt(seg, i) * dur)}</small>
              </button>
            );
          })}
        </div>
        <div className="cue-actions">
          <button className="chip-btn" data-testid="m3d-key-add" disabled={loop} title={loop ? "Loop easing swings between Start and End" : "Add a keyframe at the playhead (it starts with the pose the card has there)"} onClick={() => store.addMotion3dKey(index)}>
            <Icon name="plus" size={12} /> Keyframe at playhead
          </button>
          <button className="chip-btn danger" data-testid="m3d-key-del" disabled={!interior} title={interior ? `Delete ${keyName(seg, key)}` : "Start and End cannot be deleted"} onClick={() => store.deleteMotion3dKey(index, key)}>
            Delete keyframe
          </button>
        </div>
        {loop && n > 2 && <p className="note">Loop swings between Start and End; the other keyframes are kept but not used.</p>}
      </div>

      {interior && (
        <Slider
          label="Key time"
          value={Math.round(keyAt(seg, key) * dur)}
          min={Math.round(atLo * dur)}
          max={Math.round(atHi * dur)}
          step={10}
          format={sec2}
          testId="m3d-key-time"
          onChange={(v) => store.setMotion3dKeyAt(index, key, v / dur, true)}
        />
      )}
      <div className="m3d-edit-head">
        <p className="note">
          Editing <b data-testid="m3d-editing">{keyName(seg, key)}</b>. Alt+Arrows turn it 5°.
        </p>
        <button className="chip-btn" data-testid="m3d-reset-key" title={`Put ${keyName(seg, key)} back to the flat card`} onClick={() => store.resetMotion3dKey(index, key)}>
          ↺ Reset keyframe
        </button>
      </div>
      {POSE_CTL.map((c) => (
        <Slider key={c.k} label={c.label} value={pose[c.k]} min={c.min} max={c.max} step={c.step} format={c.f} inputMin={c.lo} inputMax={c.hi} defaultValue={c.def} testId={`m3d-${c.k}`} onChange={(v) => set({ [c.k]: v })} />
      ))}

      <Slider label="Perspective" value={seg.perspective} min={300} max={6000} step={50} format={px} inputMin={100} inputMax={50000} defaultValue={DEFAULT_PERSPECTIVE} testId="m3d-perspective" onChange={(v) => upd({ perspective: v }, "3D perspective", true)} />
      <Select<Easing3D>
        label="Easing"
        value={seg.easing}
        testId="m3d-easing"
        options={EASINGS_3D.filter((e) => e !== "loop" || loop).map((e) => ({ value: e, label: EASING_LABEL[e] }))}
        onChange={(e) => upd({ easing: e }, `3D easing ${EASING_LABEL[e]}`)}
      />
      <Toggle label="Hold end pose" value={!!seg.hold} testId="m3d-hold" hint="Keep the last pose after the block until the next 3D block" onChange={(v) => upd({ hold: v || undefined }, v ? "Hold 3D pose" : "Release 3D pose")} />
      <Toggle
        label="Loop"
        value={loop}
        testId="m3d-loop"
        hint="Swing between Start and End for the whole block"
        onChange={(v) => upd(v ? { easing: "loop", periodMs: seg.periodMs ?? 4000, blendMs: seg.blendMs ?? 600 } : { easing: "ease-in-out", periodMs: undefined }, v ? "Loop 3D motion" : "Stop 3D loop")}
      />
      {loop && <Slider label="Period" value={seg.periodMs ?? 4000} min={500} max={10000} step={100} format={sec} inputMin={100} inputMax={600000} defaultValue={4000} testId="m3d-period" onChange={(v) => upd({ periodMs: v }, "3D loop period", true)} />}
      <Slider label="Blend" value={seg.blendMs ?? 0} min={0} max={2000} step={50} format={(v) => (v ? sec(v) : "off")} inputMax={600000} defaultValue={0} testId="m3d-blend" onChange={(v) => upd({ blendMs: v || undefined }, "3D blend", true)} />
      <Segmented
        label="Back side"
        value={seg.backface ?? "card"}
        testId="m3d-backface"
        options={[{ value: "card", label: "Card back" }, { value: "front", label: "Screen" }]}
        onChange={(v) => upd({ backface: v === "front" ? "front" : undefined }, "3D back side")}
      />
      <div className="cue-actions">
        <button className="chip-btn" data-testid="m3d-reset-all" title="Put the whole block back to its template: every pose, keyframe, easing, perspective, hold and blend" onClick={() => store.resetMotion3d(index)}>
          ↺ Reset all
        </button>
      </div>

      <form
        className="m3d-save"
        onSubmit={(e) => {
          e.preventDefault();
          if (store.saveMotion3dTemplate(index, name)) setName("");
        }}
      >
        <input type="text" placeholder="Template name" value={name} aria-label="Template name" data-testid="m3d-save-name" onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="chip-btn accent" disabled={!name.trim()} data-testid="m3d-save">
          Save as template
        </button>
      </form>
    </div>
  );
}

/** Look tab: pick a template, add a 3D block with it at the playhead. */
export function Motion3dLookSection() {
  const templates = useEditor((s) => s.motion3dTemplates);
  const count = useEditor((s) => s.project.motion3d.length);
  const [tpl, setTpl] = useState("tilt-in");
  const valid = templates.some((t) => tplKey(t) === tpl) ? tpl : "tilt-in";
  return (
    <Section title="3D motion" aside={count ? <span className="lane-count" data-testid="m3d-count">{count}</span> : undefined}>
      <Select label="Template" value={valid} testId="look-m3d-template" options={templates.map((t) => ({ value: tplKey(t), label: t.name }))} onChange={setTpl} />
      <button className="chip-btn accent" data-testid="look-add-3d" onClick={() => store.addMotion3d(valid)}>
        <Icon name="plus" size={12} /> Add {templates.find((t) => tplKey(t) === valid)?.name ?? "3D"} at playhead
      </button>
      <p className="note">Tilts, swings and flips the whole screen card; zooms still run inside it. Edit it on the 3D lane.</p>
    </Section>
  );
}
