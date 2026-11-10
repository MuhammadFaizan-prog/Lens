import { useRef } from "react";
import { defaultFreezeSlide } from "@lens/engine";
import { store, useEditor, type AnnotationTool } from "../state/store";
import { newId } from "../state/timelineOps";
import { createBlock } from "./Timeline";
import { AspectSelect } from "./AspectPicker";

const TOOLS: Array<{ id: AnnotationTool; label: string; key: string; glyph: string }> = [
  { id: "select", label: "Select", key: "V", glyph: "↖" },
  { id: "arrow", label: "Arrow", key: "A", glyph: "↗" },
  { id: "rect", label: "Box", key: "B", glyph: "▭" },
  { id: "ellipse", label: "Ellipse", key: "E", glyph: "◯" },
  { id: "text", label: "Text", key: "T", glyph: "T" },
  { id: "callout", label: "Callout", key: "C", glyph: "❝" },
  { id: "badge", label: "Step badge", key: "N", glyph: "①" },
];

/** Add a hold freeze on the Freeze lane at the playhead and select it (button and the F key). */
export function addFreezeAtPlayhead(): void {
  const i = createBlock("freeze", store.playheadSrc());
  if (i >= 0) store.select({ track: "freeze", index: i });
}

/** Annotation tools over the preview: pick a tool, then click-drag on the preview. */
export function AnnotationToolbar() {
  const tool = useEditor((s) => s.tool);
  const anchor = useEditor((s) => s.newAnchor);
  const src = useEditor((s) => s.plan?.frames[s.frame]?.src ?? 0);
  const brandOn = useEditor((s) => s.project.brand.enabled);
  const imageInput = useRef<HTMLInputElement>(null);
  return (
    <div className="ann-toolbar" role="toolbar" aria-label="Annotation tools" data-testid="ann-toolbar">
      {TOOLS.map((t) => (
        <button key={t.id} className={`tool-btn ${tool === t.id ? "on" : ""}`} aria-pressed={tool === t.id} aria-label={t.label} title={`${t.label} (${t.key})`} data-testid={`tool-${t.id}`} onClick={() => store.setTool(t.id)}>
          <span className="glyph">{t.glyph}</span>
          <span className="tool-label">{t.label}</span>
        </button>
      ))}
      <span className="divider" />
      <div className="segmented pin" role="radiogroup" aria-label="New items pin to">
        {(["screen", "frame"] as const).map((a) => (
          <button key={a} role="radio" aria-checked={anchor === a} className={anchor === a ? "on" : ""} data-testid={`anchor-${a}`} title={a === "screen" ? "Follows the content through zooms" : "Fixed on the video frame"} onClick={() => store.setNewAnchor(a)}>
            {a === "screen" ? "On screen" : "On frame"}
          </button>
        ))}
      </div>
      <span className="divider" />
      <div className="insert-group" role="group" aria-label="Insert at the playhead" data-testid="insert-group">
        <span className="insert-label">Insert</span>
        <button className="chip-btn" data-testid="add-slide" title={brandOn ? "Insert a full-frame title card in your brand kit's look at the playhead" : "Insert a full-frame title card at the playhead"} onClick={() => store.addTitleCard(Math.round(src))}>
          + Title card
        </button>
        <button className="chip-btn" data-testid="insert-image" title="Insert a still image (PNG, JPEG, WebP) as a full-frame clip at the playhead" onClick={() => imageInput.current?.click()}>
          + Image
        </button>
        <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp" hidden data-testid="image-slide-input"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void store.addImageSlide(f, Math.round(src)); e.target.value = ""; }} />
        <button className="chip-btn" data-testid="insert-freeze" title="Freeze frame: hold the screen still from the playhead while sound, cursor and zoom keep going (H)" onClick={() => addFreezeAtPlayhead()}>
          + Freeze
        </button>
        <button className="chip-btn" data-testid="insert-pause" title="Pause: stop the whole video on this frame for 2 s (silent), the rest plays later" onClick={() => store.addSlide(defaultFreezeSlide(newId("pause"), Math.round(src)), "Add pause")}>
          + Pause
        </button>
      </div>
      <span className="divider" />
      <AspectSelect />
    </div>
  );
}
