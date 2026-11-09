/**
 * Inspector controls for 3D motion (feat/motion-3d): the selected block's card (template grid,
 * keyframes, pose sliders, timing) and the "3D motion" section of the Look tab that adds a block.
 * Every control goes through the store's motion3d methods, so each change is one undo step.
 */
import { useState } from "react";
import { EASINGS_3D, type Easing3D, type Motion3DSegment } from "@lens/engine";
import { store, useEditor } from "../state/store";
import { keyAt, keyCount, keyPose } from "../state/motion3dOps";
import { timecode } from "../state/timelineOps";
import { Section, Segmented, Select, Slider, Toggle } from "./Controls";
import { Icon } from "./Icon";

const EASING_LABEL: Record<Easing3D, string> = { spring: "Spring", "ease-in-out": "Ease in-out", "ease-out": "Ease out", "ease-in": "Ease in", linear: "Linear", loop: "Loop" };
const deg = (v: number) => `${Math.round(v)}°`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const px = (v: number) => `${Math.round(v)} px`;
const sec = (v: number) => `${(v / 1000).toFixed(1)} s`;

/** Template id as segments record it ("user:<id>" for saved ones). */
const tplKey = (t: { id: string; user?: boolean }) => (t.user ? `user:${t.id}` : t.id);

function keyName(s: Motion3DSegment, k: number): string {
  if (k === 0) return "Start";
  if (k === keyCount(s) - 1) return "End";
  return `Key ${k}`;
}

export function Motion3dCard({ index, seg }: { index: number; seg: Motion3DSegment }) {
  const templates = useEditor((s) => s.motion3dTemplates);
  const k = useEditor((s) => s.m3dKey);
  const fps = useEditor((s) => s.plan?.output.fps ?? 30);
  const [name, setName] = useState("");
  const n = keyCount(seg);
  const key = Math.min(k, n - 1);
  const pose = keyPose(seg, key);
  const loop = seg.easing === "loop";
  const set = (patch: Parameters<typeof store.setMotion3dPose>[1]) => store.setMotion3dPose(index, patch, true, key);
  const upd = (patch: Partial<Motion3DSegment>, label: string, live = false) => store.updateMotion3d(index, patch, live, label);
  const interior = key > 0 && key < n - 1;
  return (
    <div className="selection-card m3d-card" data-testid="selection-card">
      <div className="sel-head">
        <span className="dot dot-motion3d" />
        <b>3D motion</b>
        <span className="sel-time">
          {timecode(seg.startMs, fps)} – {timecode(seg.endMs, fps)}
        </span>
        <button className="icon-btn danger" title="Delete (Del)" aria-label="Delete selection" data-testid="delete-selection" onClick={() => store.deleteMotion3d(index)}>
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
          {Array.from({ length: n }, (_, i) => (
            <button
              key={i}
              type="button"
              role="option"
              aria-selected={i === key}
              className={`m3d-key ${i === key ? "on" : ""}`}
              data-testid={`m3d-key-${i}`}
              title={`${keyName(seg, i)} at ${pct(keyAt(seg, i))} · ${timecode(seg.startMs + keyAt(seg, i) * (seg.endMs - seg.startMs), fps)}`}
              onClick={() => {
                store.selectMotion3dKey(i);
                store.seekSource(seg.startMs + keyAt(seg, i) * (seg.endMs - seg.startMs));
              }}
            >
              {keyName(seg, i)} <small>{pct(keyAt(seg, i))}</small>
            </button>
          ))}
        </div>
        <div className="cue-actions">
          <button className="chip-btn" data-testid="m3d-key-add" disabled={loop} title={loop ? "Loop easing swings between Start and End" : "Add a keyframe at the playhead"} onClick={() => store.addMotion3dKey(index)}>
            <Icon name="plus" size={12} /> Key at playhead
          </button>
          <button className="chip-btn danger" data-testid="m3d-key-del" disabled={!interior} title={interior ? `Delete ${keyName(seg, key)}` : "Start and End cannot be deleted"} onClick={() => store.deleteMotion3dKey(index, key)}>
            Delete key
          </button>
        </div>
      </div>

      <p className="note">Editing <b>{keyName(seg, key)}</b>. Alt+Arrows turn it 5° (Alt+Shift+←/→ rolls).</p>
      <Slider label="Rotate X" value={pose.rx} min={-180} max={180} step={1} format={deg} testId="m3d-rx" onChange={(v) => set({ rx: v })} />
      <Slider label="Rotate Y" value={pose.ry} min={-180} max={180} step={1} format={deg} testId="m3d-ry" onChange={(v) => set({ ry: v })} />
      <Slider label="Rotate Z" value={pose.rz} min={-180} max={180} step={1} format={deg} testId="m3d-rz" onChange={(v) => set({ rz: v })} />
      <Slider label="Move X" value={pose.tx} min={-0.5} max={0.5} step={0.01} format={pct} testId="m3d-tx" onChange={(v) => set({ tx: v })} />
      <Slider label="Move Y" value={pose.ty} min={-0.5} max={0.5} step={0.01} format={pct} testId="m3d-ty" onChange={(v) => set({ ty: v })} />
      <Slider label="Move Z" value={pose.tz} min={-1500} max={1000} step={10} format={px} testId="m3d-tz" onChange={(v) => set({ tz: v })} />
      <Slider label="Scale" value={pose.scale} min={0.3} max={2} step={0.01} format={(v) => `${v.toFixed(2)}×`} testId="m3d-scale" onChange={(v) => set({ scale: v })} />

      <Slider label="Perspective" value={seg.perspective} min={300} max={6000} step={50} format={px} testId="m3d-perspective" onChange={(v) => upd({ perspective: v }, "3D perspective", true)} />
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
      {loop && <Slider label="Period" value={seg.periodMs ?? 4000} min={500} max={10000} step={100} format={sec} testId="m3d-period" onChange={(v) => upd({ periodMs: v }, "3D loop period", true)} />}
      <Slider label="Blend" value={seg.blendMs ?? 0} min={0} max={2000} step={50} format={(v) => (v ? sec(v) : "off")} testId="m3d-blend" onChange={(v) => upd({ blendMs: v || undefined }, "3D blend", true)} />
      <Segmented
        label="Back side"
        value={seg.backface ?? "card"}
        testId="m3d-backface"
        options={[{ value: "card", label: "Card back" }, { value: "front", label: "Screen" }]}
        onChange={(v) => upd({ backface: v === "front" ? "front" : undefined }, "3D back side")}
      />

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

/** Look tab: add a 3D block at the playhead from a template. */
export function Motion3dLookSection() {
  const templates = useEditor((s) => s.motion3dTemplates);
  const count = useEditor((s) => s.project.motion3d.length);
  const [tpl, setTpl] = useState("tilt-in");
  const valid = templates.some((t) => tplKey(t) === tpl) ? tpl : "tilt-in";
  return (
    <Section title="3D motion" aside={count ? <span className="lane-count" data-testid="m3d-count">{count}</span> : undefined}>
      <Select label="Template" value={valid} testId="look-m3d-template" options={templates.map((t) => ({ value: tplKey(t), label: t.name }))} onChange={setTpl} />
      <button className="chip-btn accent" data-testid="look-add-3d" onClick={() => store.addMotion3d(valid)}>
        <Icon name="plus" size={12} /> Add 3D at playhead
      </button>
      <p className="note">Tilts, swings and flips the whole screen card; zooms still run inside it. Edit it on the 3D lane.</p>
    </Section>
  );
}
