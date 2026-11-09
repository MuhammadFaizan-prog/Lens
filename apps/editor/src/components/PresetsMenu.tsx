/**
 * Presets menu (demand #9): the built-in and saved style presets, each with a live thumbnail (the
 * frame at the playhead rendered with that preset applied to the current project), section
 * checkboxes for a partial apply, and save / rename / duplicate / delete / import / export /
 * default-for-new-projects.
 */
import { useEffect, useRef, useState } from "react";
import { applyPreset, buildRenderPlan, PRESET_SECTIONS, resolveProject, SECTION_LABELS, type Preset, type PresetSection } from "@lens/engine";
import { ensurePlanAssets } from "../render/assets";
import { PlanRenderer } from "../render/renderer";
import { makeCanvas } from "../render/canvas";
import { planPauses } from "../state/bundle";
import { store, useEditor } from "../state/store";
import { Icon } from "./Icon";

const THUMB_W = 176;
const THUMB_H = 99;
const thumbRenderer = new PlanRenderer();

/** Render the playhead frame of the current project with `preset` applied into `canvas` (letterboxed). */
async function renderThumb(canvas: HTMLCanvasElement, preset: Preset): Promise<boolean> {
  const s = store.get();
  const b = s.bundle;
  if (!b || !s.plan || !store.screen) return false;
  const t = s.plan.frames[s.frame]?.t ?? 0;
  const project = resolveProject(applyPreset(s.project, preset));
  const i = Math.round((t * project.output.fps) / 1000);
  const plan = buildRenderPlan({ meta: b.meta, events: b.events, project, words: b.transcript?.words ?? [], pauses: planPauses(b), onlyFrames: [i] });
  await ensurePlanAssets(plan);
  const f = plan.frames[0]!;
  const scr = await store.screen.load(store.screen.indexAt(f.src));
  const wantCam = !!(store.cam && f.layout.camera && f.layout.cameraOpacity > 0);
  const cam = wantCam ? await store.cam!.load(store.cam!.indexAt(f.src)) : null;
  const { width: W, height: H } = plan.output;
  const full = makeCanvas(W, H);
  thumbRenderer.draw(full.getContext("2d") as OffscreenCanvasRenderingContext2D, plan, 0, { screen: scr, cam });
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#0d0f13";
  g.fillRect(0, 0, THUMB_W, THUMB_H);
  const k = Math.min(THUMB_W / W, THUMB_H / H);
  g.imageSmoothingQuality = "high";
  g.drawImage(full as CanvasImageSource, (THUMB_W - W * k) / 2, (THUMB_H - H * k) / 2, W * k, H * k);
  canvas.dataset.rendered = `${s.revision}:${s.frame}`;
  return true;
}

/** Thumbnails render one at a time, after the preview, so the menu never stalls playback. */
let queue: Promise<unknown> = Promise.resolve();

function Thumb({ preset }: { preset: Preset }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const revision = useEditor((s) => s.revision);
  const frame = useEditor((s) => s.frame);
  const playing = useEditor((s) => s.playing);
  useEffect(() => {
    if (playing) return;
    let live = true;
    const timer = setTimeout(() => {
      queue = queue.then(() => (live && ref.current ? renderThumb(ref.current, preset) : false)).catch(() => false);
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [preset, revision, frame, playing]);
  return <canvas ref={ref} width={THUMB_W} height={THUMB_H} className="preset-thumb" data-testid={`preset-thumb-${preset.id}`} />;
}

function download(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function Row({ p, sections, onDone }: { p: Preset; sections: PresetSection[]; onDone: () => void }) {
  const applied = useEditor((s) => s.project.theme.preset?.id === p.id);
  const isDefault = useEditor((s) => s.defaultPresetId === p.id);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(p.name);
  return (
    <li className={`preset-row ${applied ? "applied" : ""}`} data-testid={`preset-row-${p.id}`}>
      <Thumb preset={p} />
      <div className="preset-meta">
        {renaming ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              store.renameStylePreset(p.id, name);
              setRenaming(false);
            }}
          >
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setRenaming(false)} aria-label="Preset name" data-testid={`preset-rename-input-${p.id}`} />
          </form>
        ) : (
          <b className="preset-name">
            {p.name}
            {isDefault && <span className="tag" title="New projects start with this preset">default</span>}
            {applied && <span className="tag on">applied</span>}
          </b>
        )}
        <span className="preset-desc">{p.description || (p.builtIn ? "" : `Saved preset · v${p.revision}`)}</span>
      </div>
      <div className="preset-actions">
        <button className="btn primary small" data-testid={`preset-apply-${p.id}`} disabled={!sections.length} onClick={() => { store.applyStylePreset(p.id, sections); onDone(); }}>
          Apply
        </button>
        <button className="icon-btn" aria-label={`More for ${p.name}`} data-testid={`preset-more-${p.id}`} onClick={() => setMenu(!menu)}>
          ⋯
        </button>
        {menu && (
          <div className="preset-more" role="menu" onMouseLeave={() => setMenu(false)}>
            {!p.builtIn && (
              <button role="menuitem" data-testid={`preset-rename-${p.id}`} onClick={() => { setRenaming(true); setMenu(false); }}>
                Rename
              </button>
            )}
            <button role="menuitem" data-testid={`preset-duplicate-${p.id}`} onClick={() => { store.duplicateStylePreset(p.id); setMenu(false); }}>
              Duplicate
            </button>
            <button role="menuitem" data-testid={`preset-export-${p.id}`} onClick={() => { const f = store.presetFile(p.id); if (f) download(f.name, f.text); setMenu(false); }}>
              Export .lenspreset
            </button>
            <button role="menuitem" data-testid={`preset-default-${p.id}`} onClick={() => { store.setDefaultStylePreset(isDefault ? null : p.id); setMenu(false); }}>
              {isDefault ? "Stop using for new projects" : "Use for new projects"}
            </button>
            {!p.builtIn && (
              <button role="menuitem" className="danger" data-testid={`preset-delete-${p.id}`} onClick={() => { store.deleteStylePreset(p.id); setMenu(false); }}>
                Delete
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

export function PresetsMenu() {
  const [open, setOpen] = useState(false);
  const [sections, setSections] = useState<PresetSection[]>([...PRESET_SECTIONS]);
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState("");
  const presets = useEditor((s) => s.presets);
  const applied = useEditor((s) => s.project.theme.preset);
  const file = useRef<HTMLInputElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const el = e.target as Node;
      if (pop.current && !pop.current.contains(el) && !(el as HTMLElement).closest?.("[data-testid=presets-button]")) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);
  const toggle = (k: PresetSection) => setSections((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : PRESET_SECTIONS.filter((x) => x === k || cur.includes(x))));
  const onImport = async (f: File | undefined) => {
    if (!f) return;
    store.importStylePreset(await f.text(), f.name);
    if (file.current) file.current.value = "";
  };
  return (
    <div className="presets-anchor">
      <button className={`btn ghost ${open ? "on" : ""}`} data-testid="presets-button" aria-expanded={open} onClick={() => setOpen(!open)} title="Style presets">
        <Icon name="sparkle" /> Presets{applied ? <span className="preset-current" data-testid="preset-current">· {applied.name}</span> : null}
      </button>
      {open && (
        <div className="presets-pop" ref={pop} role="dialog" aria-label="Presets" data-testid="presets-menu">
          <header>
            <h2>Presets</h2>
            <span className="sub">Thumbnails show the frame at the playhead with each preset.</span>
          </header>
          <fieldset className="preset-sections" data-testid="preset-sections">
            <legend>Apply</legend>
            {PRESET_SECTIONS.map((k) => (
              <label key={k} className="check">
                <input type="checkbox" checked={sections.includes(k)} onChange={() => toggle(k)} data-testid={`preset-section-${k}`} /> {SECTION_LABELS[k]}
              </label>
            ))}
          </fieldset>
          <ul className="preset-list">
            {presets.map((p) => (
              <Row key={`${p.id}:${p.revision}:${p.name}`} p={p} sections={sections} onDone={() => undefined} />
            ))}
          </ul>
          <footer>
            {saving ? (
              <form
                className="save-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (store.saveCurrentAsPreset(newName)) {
                    setSaving(false);
                    setNewName("");
                  }
                }}
              >
                <input autoFocus placeholder="Preset name" value={newName} onChange={(e) => setNewName(e.target.value)} aria-label="New preset name" data-testid="preset-save-name" />
                <button className="btn primary small" type="submit" data-testid="preset-save-confirm" disabled={!newName.trim()}>
                  Save
                </button>
              </form>
            ) : (
              <button className="btn small" data-testid="preset-save" onClick={() => setSaving(true)}>
                <Icon name="save" /> Save current as preset
              </button>
            )}
            <input ref={file} type="file" accept=".lenspreset,application/json" hidden data-testid="preset-import-input" onChange={(e) => void onImport(e.target.files?.[0])} />
            <button className="btn ghost small" data-testid="preset-import" onClick={() => file.current?.click()}>
              <Icon name="open" /> Import
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}
