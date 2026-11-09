import { defaultSlide } from "@lens/engine";
import { store, useEditor, type AnnotationTool } from "../state/store";
import { newId } from "../state/timelineOps";

const TOOLS: Array<{ id: AnnotationTool; label: string; key: string; glyph: string }> = [
  { id: "select", label: "Select", key: "V", glyph: "↖" },
  { id: "arrow", label: "Arrow", key: "A", glyph: "↗" },
  { id: "rect", label: "Box", key: "B", glyph: "▭" },
  { id: "ellipse", label: "Ellipse", key: "E", glyph: "◯" },
  { id: "text", label: "Text", key: "T", glyph: "T" },
  { id: "callout", label: "Callout", key: "C", glyph: "💬" },
  { id: "badge", label: "Step badge", key: "N", glyph: "①" },
];

/** Annotation tools over the preview: pick a tool, then click-drag on the preview. */
export function AnnotationToolbar() {
  const tool = useEditor((s) => s.tool);
  const anchor = useEditor((s) => s.newAnchor);
  const src = useEditor((s) => s.plan?.frames[s.frame]?.src ?? 0);
  return (
    <div className="ann-toolbar" role="toolbar" aria-label="Annotation tools" data-testid="ann-toolbar">
      {TOOLS.map((t) => (
        <button key={t.id} className={`tool-btn ${tool === t.id ? "on" : ""}`} aria-pressed={tool === t.id} title={`${t.label} (${t.key})`} data-testid={`tool-${t.id}`} onClick={() => store.setTool(t.id)}>
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
      <button className="chip-btn" data-testid="add-slide" title="Insert a full-frame title card at the playhead" onClick={() => store.addSlide(defaultSlide(newId("slide"), Math.round(src)))}>
        + Text slide
      </button>
    </div>
  );
}
