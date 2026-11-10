import { RIGHT_MAX, RIGHT_MIN, ui } from "../state/uiLayout";

/**
 * Drag handle between two regions. Double-click: the left panel collapses / restores; the Inspector
 * (right) goes back to its default width when it was resized, otherwise collapses / restores; the
 * timeline goes back to its default height.
 */
export function Splitter({ kind }: { kind: "left" | "right" | "timeline" }) {
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const s0 = ui.get();
    const x0 = e.clientX;
    const y0 = e.clientY;
    if (kind === "left" && !s0.leftOpen) ui.set({ leftOpen: true });
    if (kind === "right" && !s0.rightOpen) ui.set({ rightOpen: true });
    const move = (ev: PointerEvent) => {
      if (kind === "left") ui.set({ leftW: Math.round(s0.leftW + ev.clientX - x0) });
      else if (kind === "right") ui.set({ rightW: Math.max(RIGHT_MIN, Math.min(RIGHT_MAX, Math.round(s0.rightW - (ev.clientX - x0)))) });
      else ui.set({ tlH: Math.round(s0.tlH - (ev.clientY - y0)) });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const onDouble = () => {
    const s = ui.get();
    if (kind === "left") ui.set({ leftOpen: !s.leftOpen });
    else if (kind === "right") {
      if (s.rightOpen && ui.isCustom("rightW")) ui.set({ rightW: undefined as unknown as number });
      else ui.set({ rightOpen: !s.rightOpen });
    }
    else ui.set({ tlH: undefined as unknown as number });
  };
  return (
    <div
      className={`splitter splitter-${kind}`}
      role="separator"
      aria-orientation={kind === "timeline" ? "horizontal" : "vertical"}
      aria-label={kind === "timeline" ? "Resize timeline" : `Resize ${kind} panel`}
      data-testid={`splitter-${kind}`}
      title={kind === "right" ? "Drag to resize the Inspector · double-click to reset its width (again to collapse)" : kind === "left" ? "Drag to resize · double-click to collapse / restore" : "Drag to resize · double-click to reset"}
      onPointerDown={onDown}
      onDoubleClick={onDouble}
    />
  );
}
