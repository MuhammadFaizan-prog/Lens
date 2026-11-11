/**
 * Direct manipulation of the non-annotation overlays on the preview (Windows bugs #12 / #14):
 * blur / pixelate / spotlight masks, the brand logo watermark, the webcam bubble, the caption
 * position, and the zoom target rectangle of a selected zoom block.
 *
 * Click to select (annotations are picked first, see AnnotationOverlay), drag to move with snapping
 * guides to the frame's edges and centre lines, corner handles to resize, arrow keys to nudge
 * (Shift = 10 px), Del to remove. Everything is stored in the space it lives in: masks and zoom
 * targets in source px (they follow the recording through zooms and aspect changes), the logo,
 * webcam and caption as fractions of the output frame.
 *
 * The screen card itself (feat/canvas-layout) is the "screen" object: picked lowest (every other
 * object wins), draggable from the first press, corner handles resize it (Shift keeps the aspect,
 * Alt resizes about the centre) and it snaps to the frame's thirds and centre lines. It is stored as
 * project.card (canvas fractions); a free shape trims the source, never stretches.
 */
import { useEffect, useRef, useState } from "react";
import { cardRect, framingMode, normalizeCrop, validCard } from "@lens/engine";
import type { PlanFrame, ProjectConfig, RenderPlan, Vec2 } from "@lens/engine";
import { captionBox } from "../render/renderer";
import { makeCanvas } from "../render/canvas";
import { playheadSrc, selectedZoomDocIndex, store, useEditor } from "../state/store";
import { updateBlock } from "../state/timelineOps";
import { centre, clampedNormCentre, moveBox, resizeBoxFrom, snapBox, snapLines, snapPoint, zoomRect, zoomTarget, type Box, type Corner } from "../state/overlayGeom";
import { cardFit, framingWindowOf, setCardRect, setFramingRect } from "../state/layoutOps";
import { boxToWindow, editViewRect, windowFromDraggedScreen, windowToBox } from "../state/framingEdit";
import { spaceOf } from "./AnnotationOverlay";

export type CanvasKind = "screen" | "mask" | "logo" | "webcam" | "caption" | "zoom" | "framing";

export interface CanvasObj {
  kind: CanvasKind;
  /** mask index / zoom segment index (project), else 0 */
  index: number;
  /** Output px. */
  box: Box;
  keepAspect: boolean;
  label: string;
  /** Project edit for a new box (output px). */
  apply: (b: Box) => (p: ProjectConfig) => ProjectConfig;
}

/** The frame as the preview shows it while a zoom block is selected: unzoomed, so its target rectangle can be drawn and dragged. */
export function zoomEditFrame(plan: RenderPlan, f: PlanFrame): PlanFrame {
  const [, , cw, ch] = plan.source.crop;
  return { ...f, cam: [cw / 2, ch / 2, 1], camVel: [0, 0, 0] };
}

export function zoomEditing(): boolean {
  return selectedZoomDocIndex(store.get()) >= 0;
}

/** True while the custom framing window is being placed (the preview shows the whole recording). */
export function framingEditing(): boolean {
  const s = store.get();
  return s.framingEdit && !!s.bundle && framingMode(s.project.output) === "custom" && !validCard(s.project.card);
}

/** The custom window as an edit-view object (output px), aspect locked to the canvas. */
function framingObject(plan: RenderPlan, project: ProjectConfig): CanvasObj | null {
  const meta = store.get().bundle?.meta;
  if (!meta) return null;
  const out = { width: plan.output.width, height: plan.output.height };
  const uc = normalizeCrop(project.crop, meta);
  const view = editViewRect(project, meta, out);
  const at = playheadSrc();
  const win = framingWindowOf(project, meta, out, at);
  return {
    kind: "framing",
    index: 0,
    box: windowToBox(win, uc, view),
    keepAspect: true,
    label: `shown part · ${win.w}×${win.h}`,
    apply: (b) => (p) => setFramingRect(p, boxToWindow(b, uc, view), meta, out, at),
  };
}

const scratch = (() => {
  let g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
  return () => (g ??= makeCanvas(8, 8).getContext("2d") as CanvasRenderingContext2D);
})();

/** Every pickable overlay on the current frame, topmost last. */
export function canvasObjects(plan: RenderPlan, f0: PlanFrame, project: ProjectConfig): CanvasObj[] {
  const out: CanvasObj[] = [];
  const { width: W, height: H } = plan.output;
  if (framingEditing()) {
    const fo = framingObject(plan, project);
    return fo ? [fo] : [];
  }
  const sel = store.get().selection;
  // zoom selections index the plan; the project segment is found by id
  const zoomIdx = selectedZoomDocIndex(store.get());
  const zoomSel = zoomIdx >= 0 ? project.zoom.segments[zoomIdx] : undefined;
  const f = zoomSel ? zoomEditFrame(plan, f0) : f0;
  const sp = spaceOf(plan, f, "screen");
  // the screen card first: picked lowest, so masks, webcam, caption, logo and zoom targets win
  const sb = screenBox(plan, f, project);
  if (sb) {
    const mode = framingMode(project.output);
    const meta = store.get().bundle?.meta;
    if (meta && !validCard(project.card) && (mode === "fill" || mode === "custom")) {
      // Fill / Custom: dragging the picture pans (corners zoom) the shown part: it becomes Custom
      const win = framingWindowOf(project, meta, { width: W, height: H }, f0.src);
      out.push({ kind: "screen", index: 0, box: sb, keepAspect: true, label: "screen · drag to pan", apply: (b) => (p) => setFramingRect(p, windowFromDraggedScreen(win, b, { width: W, height: H }), meta, { width: W, height: H }, f0.src) });
    } else out.push({ kind: "screen", index: 0, box: sb, keepAspect: false, label: "screen", apply: (b) => (p) => setCardRect(p, b, { width: W, height: H }) });
  }
  const toBox = (r: { x: number; y: number; w: number; h: number }): Box => {
    const a = sp.toOut({ x: r.x, y: r.y });
    const b = sp.toOut({ x: r.x + r.w, y: r.y + r.h });
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  };
  const fromBox = (b: Box) => {
    const a = sp.fromOut({ x: b.x, y: b.y });
    const c = sp.fromOut({ x: b.x + b.w, y: b.y + b.h });
    return { x: Math.round(a.x), y: Math.round(a.y), w: Math.max(4, Math.round(c.x - a.x)), h: Math.max(4, Math.round(c.y - a.y)) };
  };
  // masks active at this source time (tracked: the key in effect)
  project.masks.forEach((m, i) => {
    if (!(f.src >= m.startMs && f.src < m.endMs)) return;
    let r = m.rect;
    if (m.keys?.length) for (const k of m.keys) if (k.tMs <= f.src) r = k.rect;
    out.push({
      kind: "mask",
      index: i,
      box: toBox(r),
      keepAspect: false,
      label: m.kind,
      apply: (b) => (p) => {
        const nr = fromBox(b);
        const cur = m; // as at the gesture start: deltas are absolute
        if (!p.masks[i]) return p;
        // tracked masks: every key moves / grows by the same edge deltas
        const d = { x0: nr.x - r.x, y0: nr.y - r.y, x1: nr.x + nr.w - (r.x + r.w), y1: nr.y + nr.h - (r.y + r.h) };
        const shift = (q: typeof r) => ({ x: q.x + d.x0, y: q.y + d.y0, w: Math.max(4, q.w + d.x1 - d.x0), h: Math.max(4, q.h + d.y1 - d.y0) });
        return updateBlock(p, "mask", i, { rect: shift(cur.rect), ...(cur.keys ? { keys: cur.keys.map((k) => ({ ...k, rect: shift(k.rect) })) } : {}) });
      },
    });
  });
  // webcam bubble (corner overlays only: split / fullscreen layouts own their slot)
  const cam = f.layout.camera;
  if (cam && f.layout.cameraOpacity > 0.5 && project.camera.enabled) {
    const [x, y, w, h] = cam;
    const size0 = project.camera.size;
    out.push({
      kind: "webcam",
      index: 0,
      box: { x, y, w, h },
      keepAspect: true,
      label: "webcam",
      apply: (b) => (p) => {
        const size = Math.min(0.9, Math.max(0.05, size0 * (b.w / w)));
        return { ...p, camera: { ...p.camera, size: Math.round(size * 1000) / 1000, position: clampedNormCentre(centre(b), b.w, b.h, W, H) } };
      },
    });
  }
  // caption: moves vertically (centred horizontally), corners scale the font
  const cb = captionBox(scratch(), plan, f);
  if (cb) {
    const [x, y, w, h] = cb;
    const fs0 = project.captions.style.fontSize;
    out.push({
      kind: "caption",
      index: 0,
      box: { x, y, w, h },
      keepAspect: true,
      label: "caption",
      apply: (b) => (p) => {
        const fontSize = Math.round(Math.min(160, Math.max(14, fs0 * (b.h / h))) * 10) / 10;
        const yc = Math.min(0.97, Math.max(0.03, (b.y + b.h / 2) / H));
        return { ...p, captions: { ...p.captions, style: { ...p.captions.style, position: "custom", y: Math.round(yc * 10000) / 10000, fontSize } } };
      },
    });
  }
  // brand logo watermark
  const wm = plan.watermark;
  if (wm) {
    out.push({
      kind: "logo",
      index: 0,
      box: { x: wm.x, y: wm.y, w: wm.w, h: wm.h },
      keepAspect: true,
      label: "logo",
      apply: (b) => (p) => {
        const size = Math.min(0.8, Math.max(0.02, b.w / W));
        return { ...p, brand: { ...p.brand, logo: { ...p.brand.logo, size: Math.round(size * 10000) / 10000, position: clampedNormCentre(centre(b), b.w, b.h, W, H) } } };
      },
    });
  }
  // zoom target rectangle of the selected zoom block (drawn over the unzoomed frame)
  if (zoomSel && sel) {
    const [cx0, cy0, cw, ch] = plan.source.crop;
    const focus = zoomSel.focus === "follow" ? { x: cw / 2, y: ch / 2 } : { x: zoomSel.focus.x - cx0, y: zoomSel.focus.y - cy0 };
    const r = zoomRect(focus, zoomSel.scale, cw, ch);
    const idx = zoomIdx;
    out.push({
      kind: "zoom",
      index: idx,
      box: toBox({ x: r.x + cx0, y: r.y + cy0, w: r.w, h: r.h }),
      keepAspect: true,
      label: zoomSel.focus === "follow" ? "zoom · follows cursor" : "zoom · fixed point",
      apply: (b) => (p) => {
        const sr = fromBoxF(sp, b);
        const t = zoomTarget({ x: sr.x - cx0, y: sr.y - cy0, w: sr.w, h: sr.h }, cw, ch, 1, p.zoom.maxScale);
        return updateBlock(p, "zoom", idx, { focus: { x: t.focus.x + cx0, y: t.focus.y + cy0 }, scale: t.scale });
      },
    });
  }
  return out;
}

/**
 * The screen card's box on this frame (output px), or null when the frame's layout does not use the
 * card (split / fullscreen webcam, a hidden screen). Fill mode with no card covers the whole canvas.
 */
export function screenBox(plan: RenderPlan, f: PlanFrame, project: ProjectConfig): Box | null {
  if (!(f.layout.screenOpacity > 0.5)) return null;
  const out = { width: plan.output.width, height: plan.output.height };
  // Fill / Follow / Custom framing with no free card: the screen covers the canvas
  if (framingMode(project.output) !== "fit" && !validCard(project.card)) return { x: 0, y: 0, w: out.width, h: out.height };
  const [, , cw, ch] = plan.source.crop;
  const r = cardRect(out, cw / Math.max(1, ch), project);
  const [x, y, w, h] = f.layout.screen;
  const tol = 2;
  if (Math.abs(x - r.x) > tol || Math.abs(y - r.y) > tol || Math.abs(w - r.w) > tol || Math.abs(h - r.h) > tol) return null;
  return r;
}

/** Output box -> source rect without rounding (zoom targets keep sub-pixel precision). */
function fromBoxF(sp: ReturnType<typeof spaceOf>, b: Box): Box {
  const a = sp.fromOut({ x: b.x, y: b.y });
  const c = sp.fromOut({ x: b.x + b.w, y: b.y + b.h });
  return { x: a.x, y: a.y, w: c.x - a.x, h: c.y - a.y };
}

function selectedKey(): { kind: CanvasKind; index: number } | null {
  const s = store.get();
  if (framingEditing()) return { kind: "framing", index: 0 };
  if (s.canvasSel) return { kind: s.canvasSel, index: 0 };
  if (s.selection?.track === "mask") return { kind: "mask", index: s.selection.index };
  if (s.selection?.track === "zoom") return { kind: "zoom", index: selectedZoomDocIndex(s) };
  return null;
}

interface Drag {
  mode: "move" | Corner;
  start: Vec2;
  orig: CanvasObj;
  moved: boolean;
}

/** The drag in progress (module-level so a pick from the annotation layer can start one). */
let activeDrag: Drag | null = null;

function selectObj(o: CanvasObj): void {
  if (o.kind === "framing") {
    canvasFocus = true;
    return;
  }
  if (o.kind === "mask") store.select({ track: "mask", index: o.index });
  else if (o.kind === "zoom") store.selectZoom(o.index);
  else store.selectCanvas(o.kind);
  canvasFocus = true;
}

/** True while the last pick was on the canvas: arrow keys nudge instead of stepping frames. */
let canvasFocus = false;
export function canvasHasFocus(): boolean {
  return canvasFocus && !!selectedKey();
}

/** Pick an overlay under output point p (called by the annotation layer when no annotation is hit). */
export function pickCanvasObject(p: Vec2, startDrag = true): boolean {
  const s = store.get();
  const plan = s.plan;
  const f = plan?.frames[s.frame];
  if (!plan || !f) return false;
  const objs = canvasObjects(plan, f, s.project);
  for (let i = objs.length - 1; i >= 0; i--) {
    const b = objs[i]!.box;
    const o = objs[i]!;
    const pad = o.kind === "screen" ? 0 : 4;
    if (p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad) {
      selectObj(o);
      // the screen card drags from the first press (no select-then-drag)
      if ((o.kind === "screen" || o.kind === "framing") && startDrag) {
        store.pause();
        store.beginGesture();
        activeDrag = { mode: "move", start: p, orig: o, moved: false };
      }
      return true;
    }
  }
  return false;
}

/** Arrow-key nudge of the selected canvas object by (dx, dy) output px; one undo step per key press. */
export function nudgeSelected(dx: number, dy: number): boolean {
  const s = store.get();
  const plan = s.plan;
  const f = plan?.frames[s.frame];
  const key = selectedKey();
  if (!plan || !f || !key) return false;
  const o = canvasObjects(plan, f, s.project).find((x) => x.kind === key.kind && x.index === key.index);
  if (!o) return false;
  store.edit(`Nudge ${o.label}`, o.apply(moveBox(o.box, o.kind === "caption" ? 0 : dx, dy)));
  return true;
}

/** Del on a selected canvas object that is not a timeline block. */
export function removeCanvasSelection(): boolean {
  const which = store.get().canvasSel;
  if (!which) return false;
  if (which === "logo") store.edit("Hide logo watermark", (p) => ({ ...p, brand: { ...p.brand, logo: { ...p.brand.logo, watermark: false } } }));
  else if (which === "webcam") store.edit("Hide webcam", (p) => ({ ...p, camera: { ...p.camera, enabled: false } }));
  else if (which === "caption") store.edit("Captions off", (p) => ({ ...p, captions: { ...p.captions, enabled: false } }));
  else if (which === "screen") {
    // the screen cannot be deleted: Del puts the card back to Fit
    store.edit("Fit screen", cardFit);
    return true;
  }
  store.selectCanvas(null);
  return true;
}

export function CanvasOverlay({ cssW, cssH }: { cssW: number; cssH: number }) {
  const plan = useEditor((s) => s.plan);
  const frame = useEditor((s) => s.frame);
  const project = useEditor((s) => s.project);
  useEditor((s) => s.selection);
  useEditor((s) => s.canvasSel);
  useEditor((s) => s.framingEdit);
  const svg = useRef<SVGSVGElement>(null);
  const [guides, setGuides] = useState<{ gx: number[]; gy: number[] }>({ gx: [], gy: [] });
  const f = plan?.frames[frame];
  const W = plan?.output.width ?? 1280;
  const H = plan?.output.height ?? 720;

  const toOut = (e: { clientX: number; clientY: number }): Vec2 => {
    const r = svg.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * W) / r.width, y: ((e.clientY - r.top) * H) / r.height };
  };

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = activeDrag;
      if (!d) return;
      let p = toOut(e);
      // a click that wobbles must not move anything: the screen card (picked on press, dragged from
      // the first move) waits for 4 screen px, the rest for 2 output px
      const minMove = d.orig.kind === "screen" ? 4 * (W / Math.max(1, cssW)) : 2;
      if (!d.moved && Math.hypot(p.x - d.start.x, p.y - d.start.y) < minMove) return;
      d.moved = true;
      const o = d.orig;
      let b: Box;
      let g = { gx: [] as number[], gy: [] as number[] };
      const thr = 8 * (W / Math.max(1, cssW));
      const isScreen = o.kind === "screen";
      if (d.mode === "move") {
        b = moveBox(o.box, o.kind === "caption" ? 0 : p.x - d.start.x, p.y - d.start.y);
        if (!e.altKey && o.kind !== "framing" && !(isScreen && o.keepAspect)) {
          const sn = snapBox(b, W, H, thr, isScreen);
          b = o.kind === "caption" ? { ...sn.box, x: o.box.x } : sn.box;
          g = { gx: o.kind === "caption" ? [] : sn.gx, gy: sn.gy };
        }
      } else if (isScreen && !o.keepAspect) {
        // screen card: Shift keeps the aspect, Alt resizes about the centre; the free corner snaps
        if (!e.shiftKey) {
          const sp = snapPoint(p, snapLines(W, H, true), thr);
          p = sp.p;
          g = { gx: sp.gx, gy: sp.gy };
        }
        b = resizeBoxFrom(o.box, d.mode, p, e.shiftKey, 16, e.altKey);
      } else b = resizeBoxFrom(o.box, d.mode, p, o.keepAspect, 8);
      if (o.kind === "caption" && d.mode !== "move") b = { ...b, y: o.box.y + (o.box.h - b.h) / 2 }; // scale about its centre line
      setGuides(g);
      store.preview(o.apply(b));
    };
    const up = () => {
      const d = activeDrag;
      if (!d) return;
      activeDrag = null;
      setGuides({ gx: [], gy: [] });
      store.endGesture(d.mode === "move" ? `Move ${d.orig.label}` : `Resize ${d.orig.label}`);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    // a pointer down outside the preview hands the arrow keys back to the transport
    const away = (e: PointerEvent) => {
      if (!(e.target as Element)?.closest?.(".preview-stage")) canvasFocus = false;
    };
    window.addEventListener("pointerdown", away, true);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointerdown", away, true);
    };
  }, [W, H, cssW]);

  if (!plan || !f) return null;
  const key = selectedKey();
  const objs = canvasObjects(plan, f, project);
  const sel = key ? objs.find((o) => o.kind === key.kind && o.index === key.index) : undefined;
  const k = Math.min(cssW / W, cssH / H) || 1;
  const hr = 6 / k;

  const begin = (e: React.PointerEvent, o: CanvasObj, mode: Drag["mode"]) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    // a just-added zoom (Z / Zoom "+") waits for a click to aim it: a click on its own (follow-cursor)
    // rectangle aims it too, instead of starting a move
    const st = store.get();
    if (o.kind === "zoom" && st.zoomPlacing && st.selection?.track === "zoom" && st.plan) {
      const fr = st.plan.frames[st.frame];
      if (fr) {
        const q = spaceOf(st.plan, zoomEditFrame(st.plan, fr), "screen").fromOut(toOut(e));
        const idx = selectedZoomDocIndex(st);
        if (idx >= 0) store.edit("Aim zoom", (pp) => updateBlock(pp, "zoom", idx, { focus: { x: Math.round(q.x * 100) / 100, y: Math.round(q.y * 100) / 100 } }));
      }
      store.setZoomPlacing(false);
      return;
    }
    canvasFocus = true;
    store.pause();
    store.beginGesture();
    activeDrag = { mode, start: toOut(e), orig: o, moved: false };
  };

  return (
    <svg ref={svg} className="canvas-overlay" data-testid="canvas-overlay" viewBox={`0 0 ${W} ${H}`} style={{ width: cssW, height: cssH }}>
      {sel?.kind === "framing" && (
        <path className="co-dim" data-testid="framing-dim" fillRule="evenodd" d={`M0 0H${W}V${H}H0Z M${sel.box.x} ${sel.box.y}h${sel.box.w}v${sel.box.h}h${-sel.box.w}Z`} />
      )}
      {objs.map((o) =>
        o === sel ? null : <rect key={`${o.kind}-${o.index}`} className={`co-outline co-${o.kind}`} data-testid={`co-${o.kind}-${o.index}`} x={o.box.x} y={o.box.y} width={o.box.w} height={o.box.h} />,
      )}
      {sel && (
        <g className={`co-sel co-${sel.kind}`} data-testid={`co-sel-${sel.kind}`} data-box={sel.box.x.toFixed(2) + "," + sel.box.y.toFixed(2) + "," + sel.box.w.toFixed(2) + "," + sel.box.h.toFixed(2)}>
          <rect className="co-body" data-testid="co-body" x={sel.box.x} y={sel.box.y} width={sel.box.w} height={sel.box.h} onPointerDown={(e) => begin(e, sel, "move")} />
          {sel.kind === "zoom" && <circle className="co-centre" cx={sel.box.x + sel.box.w / 2} cy={sel.box.y + sel.box.h / 2} r={hr * 0.8} />}
          <text className="co-label" x={sel.box.x + 4 / k} y={sel.box.y - 6 / k} style={{ fontSize: 12 / k }}>{sel.label}</text>
          {(["nw", "ne", "sw", "se"] as Corner[]).map((h) => {
            const cx = h === "nw" || h === "sw" ? sel.box.x : sel.box.x + sel.box.w;
            const cy = h === "nw" || h === "ne" ? sel.box.y : sel.box.y + sel.box.h;
            return <rect key={h} className={`co-handle h-${h}`} data-testid={`co-handle-${h}`} x={cx - hr} y={cy - hr} width={hr * 2} height={hr * 2} onPointerDown={(e) => begin(e, sel, h)} />;
          })}
        </g>
      )}
      {guides.gx.map((x) => <line key={`gx${x}`} className="co-guide" x1={x} x2={x} y1={0} y2={H} />)}
      {guides.gy.map((y) => <line key={`gy${y}`} className="co-guide" y1={y} y2={y} x1={0} x2={W} />)}
    </svg>
  );
}
