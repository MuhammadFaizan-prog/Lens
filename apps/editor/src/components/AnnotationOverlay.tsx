/**
 * Direct manipulation of annotations on the preview (demand #4): draw arrows, boxes, ellipses,
 * callouts, text and badges by click-drag; select, move and resize them with handles; double-click
 * text to edit it inline. An SVG in output-px coordinates laid over the preview canvas.
 *
 * Geometry is stored in the item's anchor space: screen-anchored items in source px (mapped through
 * the current frame's camera, so drawing while zoomed lands on the content under the pointer),
 * frame-anchored items as fractions of the output frame.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { defaultAnnotationStyle, defaultAnimations, normalizeAnnotation, textPreset, type Annotation, type AnnFrame, type PlanFrame, type RenderPlan, type Vec2 } from "@lens/engine";
import { layoutText } from "../render/annotations";
import { makeCanvas } from "../render/canvas";
import { store, useEditor } from "../state/store";
import { pickCanvasObject, zoomEditFrame } from "./CanvasOverlay";
import { newId } from "../state/timelineOps";

type Handle = "nw" | "ne" | "sw" | "se" | "from" | "to" | "curve" | "tip";

interface Space {
  /** item coordinates -> output px */
  toOut(p: Vec2): Vec2;
  /** output px -> item coordinates */
  fromOut(p: Vec2): Vec2;
  /** output px per item unit (x) */
  kx: number;
  ky: number;
}

export function spaceOf(plan: RenderPlan, f: PlanFrame, anchor: "screen" | "frame"): Space {
  const { width: W, height: H } = plan.output;
  if (anchor === "frame") return { toOut: (p) => ({ x: p.x * W, y: p.y * H }), fromOut: (p) => ({ x: p.x / W, y: p.y / H }), kx: W, ky: H };
  const [cropX, cropY, srcW, srcH] = plan.source.crop;
  const [cx, cy, s] = f.cam;
  const [sx, sy, sw, sh] = f.layout.screen;
  const vw = srcW / s;
  const vh = srcH / s;
  const x0 = cx - vw / 2 + cropX;
  const y0 = cy - vh / 2 + cropY;
  const kx = sw / vw;
  const ky = sh / vh;
  return { toOut: (p) => ({ x: sx + (p.x - x0) * kx, y: sy + (p.y - y0) * ky }), fromOut: (p) => ({ x: x0 + (p.x - sx) / kx, y: y0 + (p.y - sy) / ky }), kx, ky };
}

const scratch = (() => {
  let g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
  return () => (g ??= makeCanvas(8, 8).getContext("2d") as CanvasRenderingContext2D);
})();

/** Bounds of one drawn item in output px (from its ops, text laid out like the renderer). */
export function itemBounds(plan: RenderPlan, f: PlanFrame, a: AnnFrame): [number, number, number, number] | null {
  const sp = a.space === "screen" ? spaceOf(plan, f, "screen") : null;
  const crop = plan.source.crop;
  const map = (x: number, y: number): Vec2 => (sp ? sp.toOut({ x: x + crop[0], y: y + crop[1] }) : { x, y });
  const k = sp ? sp.kx : 1;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (x: number, y: number, pad = 0) => {
    x0 = Math.min(x0, x - pad);
    y0 = Math.min(y0, y - pad);
    x1 = Math.max(x1, x + pad);
    y1 = Math.max(y1, y + pad);
  };
  for (const o of a.ops) {
    if (o.op === "text") {
      const p = map(o.x, o.y);
      const L = layoutText(scratch(), o, p.x, p.y, k);
      const [bx, by, bw, bh] = L.box;
      const px = o.bg ? o.bg.padX * k : 0;
      const py = o.bg ? o.bg.padY * k : 0;
      add(bx - px, by - py);
      add(bx + bw + px, by + bh + py);
    } else if (o.op === "fill" || o.op === "stroke") {
      const w = o.op === "stroke" ? (o.width * k) / 2 : 0;
      for (let i = 0; i < o.pts.length; i += 2) {
        const p = map(o.pts[i]!, o.pts[i + 1]!);
        add(p.x, p.y, w);
      }
    }
  }
  return Number.isFinite(x0) ? [x0, y0, x1 - x0, y1 - y0] : null;
}

function distToSeg(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy || 1;
  const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + u * dx), p.y - (a.y + u * dy));
}

function curveMid(from: Vec2, to: Vec2, curve: number): Vec2 {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  // a quadratic's midpoint is half-way to its control point
  return { x: (from.x + to.x) / 2 + (-dy / len) * curve * len * 0.5, y: (from.y + to.y) / 2 + (dx / len) * curve * len * 0.5 };
}

/** Handles of an item in output px. */
function handlesOf(a: Annotation, sp: Space): Array<{ h: Handle; p: Vec2 }> {
  if (a.kind === "arrow" && a.from && a.to) {
    const f = sp.toOut(a.from);
    const t = sp.toOut(a.to);
    return [{ h: "from", p: f }, { h: "to", p: t }, { h: "curve", p: curveMid(f, t, a.curve ?? 0) }];
  }
  if ((a.kind === "rect" || a.kind === "ellipse" || a.kind === "callout") && a.rect) {
    const p0 = sp.toOut({ x: a.rect.x, y: a.rect.y });
    const p1 = sp.toOut({ x: a.rect.x + a.rect.w, y: a.rect.y + a.rect.h });
    const hs: Array<{ h: Handle; p: Vec2 }> = [
      { h: "nw", p: p0 },
      { h: "ne", p: { x: p1.x, y: p0.y } },
      { h: "sw", p: { x: p0.x, y: p1.y } },
      { h: "se", p: p1 },
    ];
    if (a.kind === "callout" && a.to) hs.push({ h: "tip", p: sp.toOut(a.to) });
    return hs;
  }
  return [];
}

/** A new item of the current tool at output point p (drag start), fully visible at the playhead. */
function createAt(kind: Annotation["kind"], anchor: "screen" | "frame", p: Vec2, srcMs: number, durMs: number): Annotation {
  const anim = defaultAnimations(kind);
  const startMs = Math.max(0, srcMs - anim.in.ms);
  const endMs = Math.min(durMs, Math.max(startMs + 500, srcMs + 3000));
  const base = { id: newId(kind), kind, anchor, startMs, endMs, ...anim, style: defaultAnnotationStyle(kind, anchor) } as Annotation;
  switch (kind) {
    case "arrow":
      return { ...base, from: p, to: p, curve: 0, head: "triangle" };
    case "rect":
    case "ellipse":
      return { ...base, rect: { x: p.x, y: p.y, w: 1e-3, h: 1e-3 } };
    case "callout":
      return { ...base, rect: { x: p.x, y: p.y, w: 1e-3, h: 1e-3 }, text: "Callout" };
    case "badge":
      return { ...base, at: p, size: 18, number: null, text: "" };
    default: {
      const pre = textPreset(anchor === "frame" ? "lower-third" : "label");
      return normalizeAnnotation({ ...base, kind: "text", role: pre.role, rect: { x: p.x, y: p.y, w: 0, h: 0 }, align: "left", text: "Text",
        style: { ...defaultAnnotationStyle("text", anchor), ...pre.style, ...(anchor === "frame" ? { strokeWidth: 0 } : {}) } });
    }
  }
}

interface Drag {
  mode: "create" | "move" | "handle";
  id: string;
  handle?: Handle;
  start: Vec2;
  orig: Annotation;
  moved: boolean;
}

export function AnnotationOverlay({ cssW, cssH }: { cssW: number; cssH: number }) {
  const plan = useEditor((s) => s.plan);
  const frame = useEditor((s) => s.frame);
  const project = useEditor((s) => s.project);
  const tool = useEditor((s) => s.tool);
  const anchor = useEditor((s) => s.newAnchor);
  const selection = useEditor((s) => s.selection);
  const editing = useEditor((s) => s.editingText);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const [, bump] = useState(0);
  const f = plan?.frames[frame];
  const W = plan?.output.width ?? 1280;
  const H = plan?.output.height ?? 720;
  const sel = selection?.track === "annotation" ? project.annotations[selection.index] ?? null : null;

  const active = useMemo(() => {
    if (!plan || !f) return [] as Array<{ a: Annotation; drawn: AnnFrame; box: [number, number, number, number] | null }>;
    return f.annotations
      .map((d) => ({ a: project.annotations.find((x) => x.id === d.id)!, drawn: d, box: itemBounds(plan, f, d) }))
      .filter((x) => x.a);
  }, [plan, f, project.annotations]);

  const toOut = (e: { clientX: number; clientY: number }): Vec2 => {
    const r = svg.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * W) / r.width, y: ((e.clientY - r.top) * H) / r.height };
  };

  const hit = (p: Vec2): Annotation | null => {
    if (!plan || !f) return null;
    for (let i = active.length - 1; i >= 0; i--) {
      const { a, box } = active[i]!;
      if (a.kind === "arrow" && a.from && a.to) {
        const sp = spaceOf(plan, f, a.anchor);
        const fr = sp.toOut(a.from);
        const to = sp.toOut(a.to);
        const m = curveMid(fr, to, a.curve ?? 0);
        if (Math.min(distToSeg(p, fr, m), distToSeg(p, m, to)) <= 10) return a;
        continue;
      }
      if (box && p.x >= box[0] - 6 && p.x <= box[0] + box[2] + 6 && p.y >= box[1] - 6 && p.y <= box[1] + box[3] + 6) return a;
    }
    return null;
  };

  useEffect(() => {
    const up = () => {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      const label = d.mode === "create" ? `Draw ${d.orig.kind}` : d.mode === "move" ? `Move ${d.orig.kind}` : `Resize ${d.orig.kind}`;
      if (!d.moved && d.mode !== "create") {
        store.endGesture(label);
        return;
      }
      store.endGesture(label, (p) => ({
        ...p,
        annotations: p.annotations.map((a) => {
          if (a.id !== d.id || !a.rect) return a;
          // normalise a box dragged up / left, and give a click-created box a usable size
          let { x, y, w, h } = a.rect;
          if (w < 0) [x, w] = [x + w, -w];
          if (h < 0) [y, h] = [y + h, -h];
          if ((a.kind === "rect" || a.kind === "ellipse" || a.kind === "callout") && (w < 4 / (a.anchor === "frame" ? W : 1) || h < 4 / (a.anchor === "frame" ? H : 1))) {
            w = a.anchor === "frame" ? 0.2 : 160;
            h = a.anchor === "frame" ? 0.1 : 60;
          }
          return { ...a, rect: { x, y, w, h } };
        }),
      }));
      if (d.mode === "create") {
        store.setTool("select");
        store.selectAnnotation(d.id);
        if (d.orig.kind === "text" || d.orig.kind === "callout") store.startTextEdit(d.id);
      }
    };
    const move = (e: PointerEvent) => {
      const d = drag.current;
      const s = store.get();
      const pl = s.plan;
      const fr = pl?.frames[s.frame];
      if (!d || !pl || !fr) return;
      const p = toOut(e);
      if (!d.moved && Math.hypot(p.x - d.start.x, p.y - d.start.y) < 2) return;
      d.moved = true;
      const sp = spaceOf(pl, fr, d.orig.anchor);
      const q = sp.fromOut(p);
      const q0 = sp.fromOut(d.start);
      const dx = q.x - q0.x;
      const dy = q.y - q0.y;
      const o = d.orig;
      let next: Annotation = o;
      if (d.mode === "create") {
        if (o.kind === "arrow") next = { ...o, to: q };
        else if (o.rect && (o.kind === "rect" || o.kind === "ellipse" || o.kind === "callout")) {
          next = { ...o, rect: { x: o.rect.x, y: o.rect.y, w: q.x - o.rect.x, h: q.y - o.rect.y } };
          if (o.kind === "callout") next = { ...next, to: { x: o.rect.x + (q.x - o.rect.x) / 2, y: o.rect.y - (q.y - o.rect.y) * 0.8 } };
        } else next = moveBy(o, dx, dy);
      } else if (d.mode === "move") next = moveBy(o, dx, dy);
      else next = resize(o, d.handle!, q, sp, p);
      store.preview((pp) => ({ ...pp, annotations: pp.annotations.map((a) => (a.id === o.id ? next : a)) }));
      bump((n) => n + 1);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [W, H]);

  if (!plan || !f) return null;

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const p = toOut(e);
    if (editing) store.startTextEdit(null);
    if (tool !== "select") {
      store.pause();
      const sp = spaceOf(plan, f, anchor);
      const a = createAt(tool, anchor, sp.fromOut(p), f.src, plan.source.durationMs);
      store.beginGesture();
      store.preview((pp) => ({ ...pp, annotations: [...pp.annotations, a] }));
      drag.current = { mode: "create", id: a.id, start: p, orig: a, moved: false };
      store.selectAnnotation(a.id);
      return;
    }
    const h = hit(p);
    if (!h) {
      // not an annotation: a mask, the logo, the webcam, the caption or a zoom target?
      if (!pickCanvasObject(p)) {
        store.select(null);
        store.selectCanvas(null);
      }
      return;
    }
    store.selectAnnotation(h.id);
    store.beginGesture();
    drag.current = { mode: "move", id: h.id, start: p, orig: h, moved: false };
  };

  const onHandle = (e: React.PointerEvent, a: Annotation, handle: Handle) => {
    e.stopPropagation();
    e.preventDefault();
    store.beginGesture();
    drag.current = { mode: "handle", id: a.id, handle, start: toOut(e), orig: a, moved: false };
  };

  const onDouble = (e: React.MouseEvent) => {
    const h = hit(toOut(e));
    if (h && (h.kind === "text" || h.kind === "callout" || h.kind === "badge")) {
      store.selectAnnotation(h.id);
      store.startTextEdit(h.id);
    }
  };

  const selDrawn = sel ? active.find((x) => x.a.id === sel.id) : undefined;
  const selSpace = sel ? spaceOf(plan, f, sel.anchor) : null;
  const editItem = editing ? active.find((x) => x.a.id === editing) : undefined;
  const sx = cssW / W;
  const sy = cssH / H;

  return (
    <>
      <svg
        ref={svg}
        className={`ann-overlay tool-${tool}`}
        data-testid="ann-overlay"
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: cssW, height: cssH }}
        onPointerDown={onDown}
        onDoubleClick={onDouble}
      >
        {active.map(({ a, box }) =>
          box ? (
            <rect key={a.id} className={`ann-hit ${sel?.id === a.id ? "sel" : ""}`} data-testid={`ann-box-${a.id}`} x={box[0]} y={box[1]} width={box[2]} height={box[3]} />
          ) : null,
        )}
        {sel && selDrawn && selSpace &&
          handlesOf(sel, selSpace).map(({ h, p }) => (
            <circle key={h} className={`ann-handle h-${h}`} data-testid={`ann-handle-${h}`} cx={p.x} cy={p.y} r={7 / Math.min(sx, sy)} onPointerDown={(e) => onHandle(e, sel, h)} />
          ))}
      </svg>
      {editItem && editItem.box && <InlineText key={editItem.a.id} a={editItem.a} box={editItem.box} sx={sx} sy={sy} />}
    </>
  );
}

function moveBy(a: Annotation, dx: number, dy: number): Annotation {
  const mv = (p?: Vec2) => (p ? { x: p.x + dx, y: p.y + dy } : p);
  return { ...a, from: mv(a.from), to: mv(a.to), at: mv(a.at), rect: a.rect ? { ...a.rect, x: a.rect.x + dx, y: a.rect.y + dy } : a.rect };
}

function resize(a: Annotation, h: Handle, q: Vec2, sp: Space, pOut: Vec2): Annotation {
  if (h === "from") return { ...a, from: q };
  if (h === "to") return { ...a, to: q };
  if (h === "tip") return { ...a, to: q };
  if (h === "curve" && a.from && a.to) {
    const f = sp.toOut(a.from);
    const t = sp.toOut(a.to);
    const dx = t.x - f.x;
    const dy = t.y - f.y;
    const len = Math.hypot(dx, dy) || 1;
    const n = { x: -dy / len, y: dx / len };
    const mid = { x: (f.x + t.x) / 2, y: (f.y + t.y) / 2 };
    const off = (pOut.x - mid.x) * n.x + (pOut.y - mid.y) * n.y;
    return { ...a, curve: Math.max(-1, Math.min(1, (2 * off) / len)) };
  }
  if (!a.rect) return a;
  const r = a.rect;
  let x0 = r.x;
  let y0 = r.y;
  let x1 = r.x + r.w;
  let y1 = r.y + r.h;
  if (h === "nw" || h === "sw") x0 = q.x;
  if (h === "ne" || h === "se") x1 = q.x;
  if (h === "nw" || h === "ne") y0 = q.y;
  if (h === "sw" || h === "se") y1 = q.y;
  return { ...a, rect: { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.max(1e-3, Math.abs(x1 - x0)), h: Math.max(1e-3, Math.abs(y1 - y0)) } };
}

function InlineText({ a, box, sx, sy }: { a: Annotation; box: [number, number, number, number]; sx: number; sy: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [val, setVal] = useState(a.text ?? "");
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = (keep: boolean) => {
    if (done.current) return;
    done.current = true;
    if (keep && val !== (a.text ?? "")) store.updateAnnotation(a.id, (x) => ({ ...x, text: val }), "edit", "Edit text");
    store.startTextEdit(null);
  };
  const fs = Math.max(12, a.style.fontSize * (a.anchor === "frame" ? (store.get().plan?.output.height ?? 1080) / 1080 : 1) * sy);
  return (
    <textarea
      ref={ref}
      className="ann-inline"
      data-testid="ann-inline"
      value={val}
      style={{ left: box[0] * sx, top: box[1] * sy, width: Math.max(140, box[2] * sx + 24), height: Math.max(fs * 1.6, box[3] * sy + 8), fontSize: fs }}
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => commit(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          commit(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          commit(false);
        }
      }}
    />
  );
}
