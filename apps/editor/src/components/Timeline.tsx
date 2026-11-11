import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { applyWordEdits, captionBlocks, captionWords, mergeCaptionCues, type Motion3DSegment } from "@lens/engine";
import { keyAt, keyCount, mapSegment, setKeyAt } from "../state/motion3dOps";
import { store, useEditor } from "../state/store";
import {
  addBlock,
  blocksOf,
  canOverlap,
  createRange,
  freeSpan,
  MIN_BLOCK_MS,
  moveRange,
  normalizeCuts,
  resizeRange,
  snap,
  timecode,
  updateBlock,
  type Range,
  type TrackKind,
} from "../state/timelineOps";
import { Icon } from "./Icon";
import { labelWidth, packLane, ROW_GAP, ROW_H } from "../state/laneLayout";
import { clampLabelW, ui, useUi } from "../state/uiLayout";

const SNAP_PX = 8;
const DEFAULT_LEN: Record<TrackKind, number> = { zoom: 2000, cut: 800, speed: 1500, freeze: 2000, mask: 2000, annotation: 3000, slide: 0, caption: 2000, volume: 2000, motion3d: 1500 };
const ANN_EXPANDED_KEY = "lens.timeline.annotationsExpanded";
const SLIDE_ROW_H = 18;
const COLLAPSED_H = 30;

/** What an inserted clip is called (demand #20: title card, image, freeze pause). */
export function slideKindName(kind: string | undefined): string {
  return kind === "image" ? "Image" : kind === "freeze" ? "Freeze pause" : "Title card";
}
/** Label on a slide marker: the title, else the clip kind. */
function slideMarkerLabel(sl: { kind?: string; title: string }): string {
  if (sl.kind === "freeze") return "❚❚ Pause";
  if (sl.kind === "image") return sl.title.trim() ? `▣ ${sl.title}` : "▣ Image";
  return sl.title;
}

/** Label of an annotation block on the lane. */
function annLabel(a: { stepId?: string; text?: string; kind: string }): string {
  return `${a.stepId ? "step · " : ""}${a.text ? a.text : a.kind}`;
}
/** Label of a 3D block: its template's name ("user:<id>" for a saved one). */
function m3dLabel(id: string, templates: Array<{ id: string; name: string; user?: boolean }>): string {
  const bare = id.startsWith("user:") ? id.slice(5) : id;
  return `3D · ${templates.find((t) => t.id === bare && !!t.user === id.startsWith("user:"))?.name ?? bare}`;
}
const ADDABLE = ["zoom", "cut", "speed", "freeze", "motion3d", "mask", "annotation", "caption", "audio"];
const TRACKS: Array<{ kind: TrackKind | "caption" | "audio" | "takes"; label: string }> = [
  { kind: "zoom", label: "Zoom" },
  { kind: "cut", label: "Cuts" },
  { kind: "takes", label: "Alt takes" },
  { kind: "speed", label: "Speed" },
  { kind: "freeze", label: "Freeze" },
  { kind: "motion3d", label: "3D" },
  { kind: "mask", label: "Masks" },
  { kind: "annotation", label: "Annotations" },
  { kind: "caption", label: "Captions" },
  { kind: "audio", label: "Audio" },
];

/** Lane id in TRACKS -> the block track it holds (takes hold none). */
const LANE_TRACK: Record<string, TrackKind | undefined> = { zoom: "zoom", cut: "cut", speed: "speed", freeze: "freeze", motion3d: "motion3d", mask: "mask", annotation: "annotation", caption: "caption", audio: "volume" };
const MARQUEE_PX = 4;

type MenuState = { x: number; y: number; kind: "block" } | { x: number; y: number; kind: "lane"; track: TrackKind; label: string };

/** True when keyboard focus is inside the timeline (arrow keys nudge, Ctrl+A selects all). */
export function timelineHasFocus(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el?.closest?.("[data-timeline-root]");
}

interface DragState {
  track: TrackKind;
  index: number;
  mode: "move" | "start" | "end";
  x0: number;
  r0: Range;
  lo: number;
  hi: number;
  moved: boolean;
}

/** Ruler label in seconds: 0:05, 0:05.5 */
function rulerLabel(s: number): string {
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const whole = Math.floor(rest + 1e-9);
  const frac = rest - whole;
  return `${m}:${String(whole).padStart(2, "0")}${frac > 1e-6 ? (frac.toFixed(2).replace(/0+$/, "").slice(1)) : ""}`;
}

function niceStep(pxPerSec: number): number {
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  return steps.find((s) => s * pxPerSec >= 70) ?? 600;
}

/**
 * Drag handle on the right edge of the lane-header column (Windows v0.1.3: "i cant shrink or grow
 * this"). The lane area is a sibling flex box and every x <-> time conversion is relative to the
 * scroller's own box, so resizing the column never shifts the ruler / playhead / block math.
 * Double-click resets the default width; the width is remembered with the rest of the layout.
 */
function LabelResizer() {
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const w0 = ui.get().tlLabelW;
    const x0 = e.clientX;
    const move = (ev: PointerEvent) => ui.set({ tlLabelW: clampLabelW(w0 + ev.clientX - x0) });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div
      className="tl-labels-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize lane names"
      data-testid="tl-labels-resizer"
      title="Drag to resize the lane names · double-click to reset"
      onPointerDown={onDown}
      onDoubleClick={(e) => {
        e.stopPropagation();
        ui.set({ tlLabelW: undefined as unknown as number });
      }}
    />
  );
}

export function Timeline() {
  const labelW = useUi((s) => s.tlLabelW);
  const plan = useEditor((s) => s.plan);
  const project = useEditor((s) => s.project);
  const bundle = useEditor((s) => s.bundle);
  const frame = useEditor((s) => s.frame);
  const selection = useEditor((s) => s.selection);
  const templates = useEditor((s) => s.motion3dTemplates);
  const m3dKey = useEditor((s) => s.m3dKey);
  const multi = useEditor((s) => s.multi);
  const audition = useEditor((s) => s.audition);
  const playing = useEditor((s) => s.playing);
  const duration = bundle?.meta.durationMs ?? 1;
  const scroller = useRef<HTMLDivElement>(null);
  const [laneW, setLaneW] = useState(800);
  const [pxPerSec, setPxPerSec] = useState<number | null>(null);
  const [snapOn, setSnapOn] = useState(true);
  const [guide, setGuide] = useState<number | null>(null);
  const drag = useRef<DragState | null>(null);
  const [, force] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const isSel = (track: TrackKind, index: number) => multi.some((x) => x.track === track && x.index === index);

  // menus close on any outside press, Escape, scroll or resize
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e.type === "pointerdown" && (e.target as Element)?.closest?.(".tl-menu")) return;
      setMenu(null);
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close, true);
    window.addEventListener("resize", close);
    const el = scroller.current;
    el?.addEventListener("scroll", close);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("resize", close);
      el?.removeEventListener("scroll", close);
    };
  }, [menu]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setLaneW(el.clientWidth));
    ro.observe(el);
    setLaneW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  useEffect(() => store.audio.onChange(() => force((n) => n + 1)), []);

  const fitPps = Math.max(10, (laneW - 24) / (duration / 1000));
  const pps = pxPerSec ?? fitPps;
  const innerW = Math.max(laneW, (duration / 1000) * pps + 24);
  const xOf = (ms: number) => (ms / 1000) * pps;
  const msOf = (x: number) => (x / pps) * 1000;
  const playSrc = plan?.frames[frame]?.src ?? 0;

  // keep the playhead in view while playing
  useEffect(() => {
    const el = scroller.current;
    if (!el || !playing) return;
    const x = xOf(playSrc);
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = Math.max(0, x - 80);
  });

  const captionBlockList = useMemo(() => {
    const words = bundle?.transcript?.words ?? [];
    const cl = project.edits.cleanup;
    const cuts = plan?.cuts ?? [];
    const kept = captionWords(applyWordEdits(words, project.captions.wordEdits), cl.enabled && cl.removeFillers, cl.fillers).filter((w) => !cuts.some((c) => (w.startMs + w.endMs) / 2 >= c.startMs && (w.startMs + w.endMs) / 2 < c.endMs));
    // transcript blocks that a hand-written cue replaces are not shown (the cue is, as an editable block)
    return mergeCaptionCues(captionBlocks(kept, project.captions.maxWordsPerBlock, project.captions.maxBlockMs), project.captions.cues).filter((b) => !b.manual);
  }, [bundle, plan?.cuts, project.edits.cleanup, project.captions.maxWordsPerBlock, project.captions.maxBlockMs, project.captions.cues, project.captions.wordEdits]);

  const snapTargets = (exclude: { track: TrackKind; index: number } | null, group?: Set<string>): number[] => {
    const t: number[] = [0, duration, playSrc];
    for (const k of ["zoom", "cut", "speed", "freeze", "motion3d", "mask", "annotation", "caption", "volume"] as TrackKind[]) {
      blocksOf(store.get().project, k).forEach((b, i) => {
        if (exclude && exclude.track === k && exclude.index === i) return;
        if (group?.has(`${k}:${i}`)) return;
        t.push(b.startMs, b.endMs);
      });
    }
    for (const z of store.get().plan?.zoomSegments ?? []) t.push(z.startMs, z.endMs);
    for (const w of bundle?.transcript?.words ?? []) t.push(w.startMs, w.endMs);
    return t;
  };

  const laneX = (clientX: number) => {
    const el = scroller.current!;
    return clientX - el.getBoundingClientRect().left + el.scrollLeft;
  };

  const startDrag = (e: React.PointerEvent, track: TrackKind, index: number, r: Range) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    root.current?.focus({ preventScroll: true });
    // Ctrl/Cmd+click toggles a block in the group, Shift+click adds the run between it and the primary
    if (e.ctrlKey || e.metaKey) {
      store.toggleSelect({ track, index });
      return;
    }
    if (e.shiftKey) {
      store.selectRange({ track, index });
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const off = e.clientX - rect.left;
    const mode: DragState["mode"] = off < 7 ? "start" : off > rect.width - 7 ? "end" : "move";
    if (mode === "move" && store.get().multi.length > 1 && isSel(track, index)) return startGroupDrag(e, track, index, r);
    let idx = index;
    if (track === "zoom") {
      // live auto zooms become editable blocks first (see freezeAutoZooms)
      const seg = store.get().plan!.zoomSegments[index]!;
      idx = store.freezeZoomsFor(seg.startMs, seg.endMs);
      if (idx < 0) return;
    }
    // the selection keeps the plan index (as multi-select does); idx is the project index for the drag
    if (track === "zoom") store.selectZoom(idx);
    else store.select({ track, index: idx });
    const blocks = blocksOf(store.get().project, track);
    // tracks whose blocks may overlap (cuts merge) can go anywhere
    const [lo, hi] = canOverlap(track) ? [0, duration] : freeSpan(blocks, (r.startMs + r.endMs) / 2, duration, idx);
    drag.current = { track, index: idx, mode, x0: e.clientX, r0: { startMs: r.startMs, endMs: r.endMs }, lo, hi, moved: false };
    store.beginGesture();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      if (!d.moved && Math.abs(ev.clientX - d.x0) < 2) return;
      d.moved = true;
      const snapOpts = snapOn && !ev.altKey ? { targets: snapTargets({ track: d.track, index: d.index }), thresholdMs: msOf(SNAP_PX) } : null;
      const delta = msOf(ev.clientX - d.x0);
      const res = d.mode === "move"
        ? moveRange(d.r0, delta, d.lo, d.hi, snapOpts)
        : resizeRange(d.r0, d.mode, (d.mode === "start" ? d.r0.startMs : d.r0.endMs) + delta, MIN_BLOCK_MS[d.track], d.lo, d.hi, snapOpts);
      setGuide(res.snapped);
      store.preview((p) => updateBlock(p, d.track, d.index, { startMs: Math.round(res.startMs), endMs: Math.round(res.endMs) }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const d = drag.current;
      drag.current = null;
      setGuide(null);
      if (!d) return;
      const verb = d.mode === "move" ? "Move" : "Resize";
      store.endGesture(`${verb} ${d.track}`, d.track === "cut" ? normalizeCuts : undefined);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** Drag a block of a multi-selection: the whole group moves (clamped as a group), one undo step. */
  const startGroupDrag = (e: React.PointerEvent, track: TrackKind, index: number, r: Range) => {
    const x0 = e.clientX;
    let moved = false;
    let begun = false;
    const sel = store.get().multi;
    const exclude = new Set(sel.map((x) => `${x.track}:${x.index}`));
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 2) return;
      moved = true;
      if (!begun) {
        begun = true;
        store.beginMoveSelected();
      }
      let delta = msOf(ev.clientX - x0);
      let snapped: number | null = null;
      if (snapOn && !ev.altKey) {
        const targets = snapTargets(null, exclude);
        const opts = { targets, thresholdMs: msOf(SNAP_PX) };
        const a = snap(r.startMs + delta, opts);
        const b = snap(r.endMs + delta, opts);
        const da = a.snapped !== null ? Math.abs(a.t - (r.startMs + delta)) : Infinity;
        const db = b.snapped !== null ? Math.abs(b.t - (r.endMs + delta)) : Infinity;
        if (da <= db && a.snapped !== null) {
          delta = a.t - r.startMs;
          snapped = a.snapped;
        } else if (b.snapped !== null) {
          delta = b.t - r.endMs;
          snapped = b.snapped;
        }
      }
      const applied = store.previewMoveSelected(Math.round(delta));
      setGuide(snapped !== null && Math.abs(applied - Math.round(delta)) < 1 ? snapped : null);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setGuide(null);
      if (begun) store.endMoveSelected();
      // a plain click (no drag) on a grouped block makes it the only selection
      else store.setSelection([{ track, index }]);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** Right-click a block: it joins (or keeps) the selection and the Delete / Duplicate menu opens. */
  const openBlockMenu = (e: React.MouseEvent, track: TrackKind, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isSel(track, index)) store.setSelection([{ track, index }]);
    root.current?.focus({ preventScroll: true });
    setMenu({ x: e.clientX, y: e.clientY, kind: "block" });
  };

  /** Blocks (data-track / data-index) whose box intersects the marquee, in client space. */
  const marqueeHits = (m: { x0: number; y0: number; x1: number; y1: number }) => {
    const el = inner.current;
    if (!el) return [];
    const base = el.getBoundingClientRect();
    const L = base.left + Math.min(m.x0, m.x1), R = base.left + Math.max(m.x0, m.x1);
    const T = base.top + Math.min(m.y0, m.y1), B = base.top + Math.max(m.y0, m.y1);
    const out: Array<{ track: TrackKind; index: number }> = [];
    el.querySelectorAll<HTMLElement>("[data-sel-track]").forEach((b) => {
      const r = b.getBoundingClientRect();
      if (r.right >= L && r.left <= R && r.bottom >= T && r.top <= B) out.push({ track: b.dataset.selTrack as TrackKind, index: Number(b.dataset.selIndex) });
    });
    return out;
  };

  /**
   * Press on an empty lane area: seeks there (as before); dragging past a few pixels turns it into a
   * marquee that selects every block it touches, across lanes. Ctrl/Cmd/Shift adds to the selection.
   */
  const laneDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = inner.current;
    if (!el) return;
    root.current?.focus({ preventScroll: true });
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    const base = additive ? store.get().multi : [];
    const prim = additive ? store.get().selection : null;
    if (!additive) store.select(null);
    store.pause();
    store.seekSource(msOf(laneX(e.clientX)));
    const pos = (ev: { clientX: number; clientY: number }) => {
      const b = el.getBoundingClientRect();
      return { x: ev.clientX - b.left, y: ev.clientY - b.top };
    };
    const p0 = pos(e);
    let boxing = false;
    const move = (ev: PointerEvent) => {
      const p = pos(ev);
      if (!boxing && Math.hypot(p.x - p0.x, p.y - p0.y) < MARQUEE_PX) return;
      boxing = true;
      const m = { x0: p0.x, y0: p0.y, x1: p.x, y1: p.y };
      setMarquee(m);
      store.setSelection([...base, ...marqueeHits(m)], prim);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setMarquee(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const selectLane = (track: TrackKind) => {
    store.selectAll(track);
    root.current?.focus({ preventScroll: true });
  };
  const deleteLane = (track: TrackKind, label: string) => {
    const n = track === "zoom" ? (store.get().plan?.zoomSegments ?? project.zoom.segments).length : blocksOf(store.get().project, track).length;
    if (!n) return store.notify(`Nothing on the ${label} lane`);
    if (n > 3 && !window.confirm(`Delete all ${n} blocks on the ${label} lane?`)) return;
    store.selectAll(track);
    const d = store.deleteSelected();
    store.notify(`Deleted ${d} block${d === 1 ? "" : "s"} from ${label}`);
  };

  const create = (track: TrackKind, t: number) => createBlock(track, t);

  const scrubLane = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    store.select(null);
    store.pause();
    store.seekSource(msOf(laneX(e.clientX)));
    const move = (ev: PointerEvent) => store.seekSource(msOf(laneX(ev.clientX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const el = scroller.current!;
    const mx = laneX(e.clientX);
    const t = msOf(mx);
    const next = Math.max(fitPps, Math.min(2000, pps * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
    setPxPerSec(next);
    requestAnimationFrame(() => (el.scrollLeft = (t / 1000) * next - (e.clientX - el.getBoundingClientRect().left)));
  };

  // Annotations lane (demand #9 UI fix): auto-stacked sub-rows, packed in pixels so no two blocks
  // overlap and every block keeps room for a readable label; collapsible to one summary row.
  const [annExpanded, setAnnExpanded] = useState(() => localStorage.getItem(ANN_EXPANDED_KEY) !== "0");
  const toggleAnn = () => {
    localStorage.setItem(ANN_EXPANDED_KEY, annExpanded ? "0" : "1");
    setAnnExpanded(!annExpanded);
  };
  const annPack = useMemo(() => packLane(project.annotations.map((a) => ({ startMs: a.startMs, endMs: a.endMs, label: annLabel(a) })), pps / 1000), [project.annotations, pps]);
  const slideRow = project.slides.length ? SLIDE_ROW_H : 0;
  const annLaneH = annExpanded ? Math.max(34, slideRow + 4 + annPack.rowCount * (ROW_H + ROW_GAP)) : COLLAPSED_H;

  /** Drag a slide marker along the source timeline (one undo step). */
  const startSlideDrag = (e: React.PointerEvent, index: number, at0: number) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    root.current?.focus({ preventScroll: true });
    if (e.ctrlKey || e.metaKey) return store.toggleSelect({ track: "slide", index });
    if (e.shiftKey) return store.selectRange({ track: "slide", index });
    if (store.get().multi.length > 1 && isSel("slide", index)) return startGroupDrag(e, "slide", index, { startMs: at0, endMs: at0 });
    store.select({ track: "slide", index });
    store.beginGesture();
    const x0 = e.clientX;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 2) return;
      moved = true;
      const at = Math.round(Math.max(0, Math.min(duration, at0 + msOf(ev.clientX - x0))));
      store.preview((p) => ({ ...p, slides: p.slides.map((s, j) => (j === index ? { ...s, atMs: at } : s)) }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      store.endGesture("Move inserted clip");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const step = niceStep(pps);
  const ticks: number[] = [];
  for (let s = 0; s <= duration / 1000 + 1e-9; s += step) ticks.push(s);
  const fps = plan?.output.fps ?? 30;
  const zoomLevel = Math.round((pps / fitPps) * 100);
  const peaks = store.audio.peaks;

  /**
   * Keyframe diamonds on a 3D block: one per keyframe (Start / End at the edges, inside the trim
   * handles). Click selects the block and the keyframe and puts the playhead on it; dragging an
   * inner one moves it in time (clamped between its neighbours, one undo step).
   */
  const keyDiamonds = (i: number, m: Motion3DSegment) => {
    const n = keyCount(m);
    const w = Math.max(4, xOf(m.endMs) - xOf(m.startMs));
    if (w < 24) return null;
    const on = selection?.track === "motion3d" && selection.index === i;
    return Array.from({ length: n }, (_, k) => {
      const at = keyAt(m, k);
      const inner = k > 0 && k < n - 1;
      const left = k === 0 ? 11 : k === n - 1 ? w - 11 : at * w;
      return (
        <button
          key={k}
          type="button"
          className={`m3d-dia ${inner ? "inner" : ""} ${on && m3dKey === k ? "on" : ""}`}
          style={{ left }}
          data-testid={`m3d-dia-${m.id}-${k}`}
          data-m3d-key={k}
          title={`${k === 0 ? "Start" : k === n - 1 ? "End" : `Key ${k}`} · ${timecode(m.startMs + at * (m.endMs - m.startMs), fps)}${inner ? " · drag to move, Del to delete" : ""}`}
          aria-label={k === 0 ? "Start keyframe" : k === n - 1 ? "End keyframe" : `Keyframe ${k}`}
          onDoubleClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => {
            e.stopPropagation();
            if (e.button !== 0) return;
            store.seekMotion3dKey(i, k);
            if (!inner) return;
            const el = e.currentTarget;
            const blockEl = el.parentElement!;
            el.setPointerCapture?.(e.pointerId);
            const x0 = e.clientX;
            let moved = false;
            const move = (ev: PointerEvent) => {
              if (!moved && Math.abs(ev.clientX - x0) < 3) return;
              if (!moved) store.beginGesture();
              moved = true;
              const r = blockEl.getBoundingClientRect();
              store.preview((p) => mapSegment(p, i, (s) => setKeyAt(s, k, (ev.clientX - r.left) / r.width)));
            };
            const up = () => {
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", up);
              if (moved) {
                store.endGesture("Move 3D keyframe");
                store.seekMotion3dKey(i, k);
              }
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
          }}
        />
      );
    });
  };

  const block = (track: TrackKind, i: number, r: Range, label: string, extra = "", testId?: string, style: React.CSSProperties = {}, children?: React.ReactNode) => {
    const selected = isSel(track, i) || (selection?.track === track && selection.index === i && !extra.includes("auto"));
    const primary = multi.length > 1 && selection?.track === track && selection.index === i;
    return (
      <div
        key={`${track}-${i}-${r.startMs}`}
        className={`block block-${track} ${selected ? "selected" : ""} ${primary ? "primary" : ""} ${extra}`}
        style={{ left: xOf(r.startMs), width: Math.max(4, xOf(r.endMs) - xOf(r.startMs)), ...style }}
        onPointerDown={(e) => startDrag(e, track, i, r)}
        onContextMenu={(e) => openBlockMenu(e, track, i)}
        data-sel-track={track}
        data-sel-index={i}
        data-selected={selected ? "1" : "0"}
        onDoubleClick={(e) => e.stopPropagation()}
        data-testid={testId ?? `block-${track}-${i}`}
        data-start={Math.round(r.startMs)}
        data-end={Math.round(r.endMs)}
        title={`${label} · ${timecode(r.startMs, fps)}–${timecode(r.endMs, fps)}`}
      >
        <span className="handle l" />
        <span className="block-label">{label}</span>
        <span className="handle r" />
        {children}
      </div>
    );
  };

  return (
    <div className="timeline" onWheel={onWheel} ref={root} tabIndex={-1} data-timeline-root data-testid="timeline">
      <div className="timeline-toolbar">
        <span className="tl-title">Timeline</span>
        <span className="tl-sub">source time · double-click a lane to add · drag to move · edges to trim · Ctrl/Shift-click or drag empty space to select several · Del to remove</span>
        <div className="spacer" />
        {multi.length > 1 && (
          <span className="tl-badge" data-testid="selection-count" title="Del deletes them, drag any of them to move the group, Esc clears">
            {multi.length} selected
          </span>
        )}
        <button className={`chip-btn ${snapOn ? "on" : ""}`} aria-pressed={snapOn} onClick={() => setSnapOn(!snapOn)} title="Snap to edges, words and playhead (hold Alt to bypass)">
          <Icon name="magnet" /> Snap
        </button>
        <label className="tl-zoom">
          <span>Zoom</span>
          <input
            type="range"
            min={100}
            max={1600}
            step={10}
            value={Math.min(1600, zoomLevel)}
            aria-label="Timeline zoom"
            data-testid="timeline-zoom"
            onChange={(e) => setPxPerSec((fitPps * Number(e.target.value)) / 100)}
          />
          <span className="num">{zoomLevel}%</span>
        </label>
        <button className="chip-btn" onClick={() => setPxPerSec(null)}>
          Fit
        </button>
      </div>
      <div className="timeline-body">
        <div className="tl-labels" style={{ width: labelW }} data-testid="tl-labels">
          <LabelResizer />
          <div className="tl-ruler-spacer" />
          {TRACKS.map((t) => (
            <div key={t.kind} className={`tl-label tl-label-${t.kind}`} title={t.label} data-testid={`tl-label-${t.kind}`}
              onContextMenu={(e) => {
                // right-click a lane name opens its menu too (the "⋯" hides when the column is narrow)
                if (!LANE_TRACK[t.kind]) return;
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, kind: "lane", track: LANE_TRACK[t.kind]!, label: t.label });
              }}
              style={t.kind === "annotation" ? { height: annLaneH } : undefined}>
              {t.kind === "annotation" ? (
                <button className="lane-toggle" aria-expanded={annExpanded} data-testid="ann-lane-toggle" title={annExpanded ? "Collapse to one row" : "Expand into rows"} onClick={toggleAnn}>
                  {annExpanded ? "▾" : "▸"}
                </button>
              ) : null}
              <span className={`dot dot-${t.kind}`} />
              <span className="lane-name" title={t.label} data-testid={`lane-name-${t.kind}`}>{t.label}</span>
              {t.kind === "annotation" && project.annotations.length > 0 && (
                <span className="lane-count" data-testid="ann-lane-rows" title={annExpanded ? `${annPack.rowCount} row${annPack.rowCount > 1 ? "s" : ""}` : `${project.annotations.length} items, collapsed`}>
                  {annExpanded ? annPack.rowCount : project.annotations.length}
                </span>
              )}
              {LANE_TRACK[t.kind] && (
                <button
                  className="lane-menu-btn"
                  title={`${t.label} lane actions`}
                  aria-label={`${t.label} lane menu`}
                  aria-haspopup="menu"
                  data-testid={`lane-menu-${t.kind}`}
                  onClick={(e) => {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setMenu({ x: r.left, y: r.bottom + 2, kind: "lane", track: LANE_TRACK[t.kind]!, label: t.label });
                  }}
                >
                  ⋯
                </button>
              )}
              {ADDABLE.includes(t.kind) && (
                <button
                  className="mini-add"
                  title={t.kind === "motion3d" ? "Add a 3D motion at playhead" : t.kind === "audio" ? "Add a volume segment at playhead" : t.kind === "zoom" ? "Add a zoom at playhead, then click the preview to aim it (Z)" : `Add ${t.label.toLowerCase()} at playhead`}
                  aria-label={`Add ${t.kind}`}
                  data-testid={`add-${t.kind}`}
                  onClick={() => (t.kind === "zoom" ? addZoomAtPlayhead() : t.kind === "motion3d" ? store.addMotion3d() : create((t.kind === "audio" ? "volume" : t.kind) as TrackKind, store.get().plan?.frames[store.get().frame]?.src ?? 0))}
                >
                  <Icon name="plus" size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="tl-scroll" ref={scroller} data-testid="timeline-scroll">
          <div className="tl-inner" ref={inner} style={{ width: innerW }}>
            <div className="tl-ruler" onPointerDown={scrubLane}>
              {ticks.map((s) => (
                <div key={s} className="tick" style={{ left: xOf(s * 1000) }}>
                  {xOf(s * 1000) < innerW - 44 && <span>{rulerLabel(s)}</span>}
                </div>
              ))}
              {(project.chapters?.items ?? []).map((c) => (
                <button key={c.id} className="tl-chapter" style={{ left: xOf(c.srcMs) }} title={`Chapter: ${c.title} (Export > Title & chapters)`} data-testid="tl-chapter"
                  onPointerDown={(e) => e.stopPropagation()} onClick={() => store.seekSource(c.srcMs)}>
                  <span>{c.title}</span>
                </button>
              ))}
            </div>
            {plan?.cuts.map((c, i) => (
              <div key={`cut-shade-${i}`} className="cut-shade" style={{ left: xOf(c.startMs), width: xOf(c.endMs) - xOf(c.startMs) }} />
            ))}
            <div className="lane" data-testid="lane-zoom" onPointerDown={laneDown} onDoubleClick={(e) => create("zoom", msOf(laneX(e.clientX)))}>
              {plan?.zoomSegments.map((z, i) => block("zoom", i, z, `${z.scale.toFixed(1)}×${z.auto ? " auto" : ""}`, z.auto && project.zoom.auto ? "auto" : ""))}
            </div>
            <div className="lane" data-testid="lane-cut" onPointerDown={laneDown} onDoubleClick={(e) => create("cut", msOf(laneX(e.clientX)))}>
              {(plan?.cleanupCuts ?? []).map((c, i) => (
                <div key={`cl-${i}`} className="block block-cleanup" style={{ left: xOf(c.startMs), width: Math.max(3, xOf(c.endMs) - xOf(c.startMs)) }} title="Cleanup cut (fillers / pauses)" />
              ))}
              {project.edits.cuts.map((c, i) => block("cut", i, c, "cut"))}
            </div>
            <div className={`lane lane-takes ${project.edits.takes.enabled ? "" : "off"}`} data-testid="lane-takes" onPointerDown={laneDown}>
              {(plan?.takes ?? []).map((g, gi) => (
                <div key={`tg-${g.id}`} className="take-group" style={{ left: xOf(g.startMs), width: Math.max(6, xOf(g.endMs) - xOf(g.startMs)) }} title={`Retake group · ${g.takes.length} takes · ${g.manual ? "marked by you" : `found by ${g.cues.join(", ") || "repeat"}`}`} />
              ))}
              {(plan?.takes ?? []).flatMap((g, gi) =>
                g.takes.map((t, k) => {
                  const isKept = k === g.kept;
                  const auditioning = audition?.group === gi && audition.take === k;
                  return (
                    <div
                      key={`take-${g.id}-${k}`}
                      className={`block block-take ${isKept ? "kept" : "rejected"} ${auditioning ? "auditioning" : ""}`}
                      style={{ left: xOf(t.startMs), width: Math.max(14, xOf(t.endMs) - xOf(t.startMs)) }}
                      data-testid={`take-${gi}-${k}`}
                      data-kept={isKept ? "1" : "0"}
                      title={`Take ${k + 1} of ${g.takes.length}${isKept ? " · kept" : " · click to keep this take"} · score ${t.score.toFixed(2)} · ${timecode(t.startMs, fps)}–${timecode(t.endMs, fps)}`}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        if (e.button !== 0) return;
                        if (!isKept) store.keepTake(gi, k);
                        else store.seekSource(t.startMs);
                      }}
                    >
                      <span className="block-label">{isKept ? "✓ " : ""}Take {k + 1}</span>
                      <button
                        className="take-ab"
                        data-testid={`take-ab-${gi}-${k}`}
                        title={`A/B preview take ${k + 1}`}
                        aria-label={`Preview take ${k + 1}`}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (auditioning) store.endAudition();
                          else store.audition(gi, k);
                        }}
                      >
                        {auditioning ? "■" : "▶"}
                      </button>
                    </div>
                  );
                }),
              )}
              {project.edits.takes.enabled && !(plan?.takes ?? []).length && <span className="lane-hint">No retakes found</span>}
              {!project.edits.takes.enabled && <span className="lane-hint">Takes off · turn on in the transcript panel</span>}
            </div>
            <div className="lane" data-testid="lane-speed" onPointerDown={laneDown} onDoubleClick={(e) => create("speed", msOf(laneX(e.clientX)))}>
              {project.edits.speed.map((s, i) => block("speed", i, s, `${s.rate}×`))}
            </div>
            <div className="lane lane-freeze" data-testid="lane-freeze" onPointerDown={laneDown} onDoubleClick={(e) => create("freeze", msOf(laneX(e.clientX)))}>
              {(project.freezes ?? []).map((f, i) => block("freeze", i, f, f.cursor === "hide" ? "Freeze · no cursor" : "Freeze", "", `block-freeze-${i}`))}
              {!(project.freezes ?? []).length && <span className="lane-hint">Hold the screen still while you talk · double-click or +</span>}
            </div>
            <div className="lane lane-motion3d" data-testid="lane-motion3d" onPointerDown={laneDown} onDoubleClick={(e) => store.addMotion3d("tilt-in", msOf(laneX(e.clientX)))}>
              {project.motion3d.map((m, i) => block("motion3d", i, m, m3dLabel(m.template, templates), m.hold ? "hold" : "", `block-motion3d-${m.id}`, {}, keyDiamonds(i, m)))}
            </div>
            <div className="lane" data-testid="lane-mask" onPointerDown={laneDown} onDoubleClick={(e) => create("mask", msOf(laneX(e.clientX)))}>
              {project.masks.map((m, i) => block("mask", i, m, m.privacyId ? `${m.kind} · ${m.privacyId}` : m.kind, m.privacyId ? "privacy" : ""))}
            </div>
            <div className={`lane lane-annotation ${annExpanded ? "expanded" : "collapsed"}`} data-testid="lane-annotation" data-rows={annPack.rowCount} style={{ height: annLaneH }} onPointerDown={laneDown} onDoubleClick={(e) => create("annotation", msOf(laneX(e.clientX)))}>
              {project.annotations.map((a, i) => {
                const label = annLabel(a);
                const w = xOf(a.endMs) - xOf(a.startMs);
                const row = annPack.rows[i]!;
                if (!annExpanded) {
                  // collapsed: thin bars in their rows, no labels (hover for the title)
                  // rows share the summary row's height, so any number of rows fits inside it
                  const step = (COLLAPSED_H - 6) / annPack.rowCount;
                  const h = Math.max(1, Math.floor(step) - (step >= 3 ? 1 : 0));
                  return block("annotation", i, a, label, `${a.stepId ? "step" : ""} mini`, `block-annotation-${a.id}`, { top: 3 + Math.floor(row * step), height: h });
                }
                const narrow = w < labelWidth(label);
                return block("annotation", i, a, label, `${a.stepId ? "step" : ""}${narrow ? " narrow" : ""}`, `block-annotation-${a.id}`,
                  { top: slideRow + 3 + row * (ROW_H + ROW_GAP), height: ROW_H, ["--label-room" as string]: `${Math.max(0, labelWidth(label) - Math.max(4, w) - 3)}px` });
              })}
              {project.slides.map((sl, i) => (
                <div
                  key={`slide-${sl.id}`}
                  className={`slide-marker kind-${sl.kind ?? "text"} ${isSel("slide", i) || (selection?.track === "slide" && selection.index === i) ? "selected" : ""}`}
                  style={{ left: xOf(sl.atMs) }}
                  data-sel-track="slide"
                  data-sel-index={i}
                  onContextMenu={(e) => openBlockMenu(e, "slide", i)}
                  data-testid={`slide-marker-${sl.id}`}
                  title={`${slideKindName(sl.kind)}${sl.title ? ` “${sl.title}”` : ""} · ${(sl.durationMs / 1000).toFixed(1)} s · inserted at ${timecode(sl.atMs, fps)}`}
                  onPointerDown={(e) => startSlideDrag(e, i, sl.atMs)}
                >
                  <span>{slideMarkerLabel(sl)}</span>
                </div>
              ))}
            </div>
            <div className={`lane lane-caption ${project.captions.enabled ? "" : "off"}`} data-testid="lane-caption" onPointerDown={laneDown} onDoubleClick={(e) => create("caption", msOf(laneX(e.clientX)))}>
              {(project.captions.cues ?? []).map((c, i) => block("caption", i, c, c.text || "(empty)", "manual", `block-caption-${c.id}`))}
              {captionBlockList.map((b, i) => (
                <div
                  key={`cap-${i}`}
                  className="block block-caption auto-cap"
                  data-testid={`caption-auto-${i}`}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    store.cueFromBlock(b.startMs, b.endMs, b.text);
                  }}
                  style={{ left: xOf(b.startMs), width: Math.max(4, xOf(b.endMs) - xOf(b.startMs)) }}
                  title={`${b.text} · double-click to edit as a caption`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    store.seekSource(b.startMs);
                  }}
                >
                  <span className="block-label">{b.text}</span>
                </div>
              ))}
            </div>
            <div className="lane lane-audio" data-testid="lane-audio" onPointerDown={laneDown} onDoubleClick={(e) => create("volume", msOf(laneX(e.clientX)))}>
              {project.overrides.filter((o) => o.volume !== undefined).map((o, i) => block("volume", i, o, `vol ${Math.round((o.volume ?? 1) * 100)}%`, "", `block-volume-${i}`))}
              <Waveform peaks={peaks} peakMs={store.audio.peakMs} width={innerW} pps={pps} offsetMs={project.audio.tracks[0]?.offsetMs ?? 0} muted={project.audio.tracks[0]?.muted ?? false} />
            </div>
            {guide !== null && <div className="snap-guide" style={{ left: xOf(guide) }} />}
            {marquee && (
              <div
                className="tl-marquee"
                data-testid="timeline-marquee"
                style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }}
              />
            )}
            <div className="playhead" style={{ left: xOf(playSrc) }} data-testid="playhead">
              <span className="playhead-cap" />
            </div>
          </div>
        </div>
      </div>
      {menu && (
        <div className="tl-menu" role="menu" data-testid={menu.kind === "block" ? "block-menu" : "lane-menu"} style={{ left: menu.x, top: menu.y }} onContextMenu={(e) => e.preventDefault()}>
          {menu.kind === "block" ? (
            <>
              <button role="menuitem" data-testid="block-menu-duplicate" onClick={() => { setMenu(null); store.duplicateSelected(); }}>
                Duplicate{multi.length > 1 ? ` ${multi.length}` : ""}
              </button>
              <button role="menuitem" className="danger" data-testid="block-menu-delete" onClick={() => { setMenu(null); deleteSelection(); }}>
                Delete{multi.length > 1 ? ` ${multi.length}` : ""}
              </button>
            </>
          ) : (
            <>
              <button role="menuitem" data-testid="lane-menu-select-all" onClick={() => { setMenu(null); selectLane(menu.track); }}>
                Select all in lane
              </button>
              <button role="menuitem" className="danger" data-testid="lane-menu-delete-all" onClick={() => { setMenu(null); deleteLane(menu.track, menu.label); }}>
                Delete all in lane
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Waveform({ peaks, peakMs, width, pps, offsetMs, muted }: { peaks: Float32Array | null; peakMs: number; width: number; pps: number; offsetMs: number; muted: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const h = 44;
  const w = Math.min(16000, Math.ceil(width));
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const g = c.getContext("2d")!;
    g.clearRect(0, 0, c.width, c.height);
    if (!peaks) return;
    let max = 0.0001;
    for (const v of peaks) if (v > max) max = v;
    g.fillStyle = muted ? "#3a4250" : "#5fd4a4";
    for (let x = 0; x < c.width; x++) {
      const t0 = (x / pps) * 1000 - offsetMs;
      const t1 = ((x + 1) / pps) * 1000 - offsetMs;
      let m = 0;
      for (let k = Math.max(0, Math.floor(t0 / peakMs)); k < Math.min(peaks.length, Math.ceil(t1 / peakMs)); k++) m = Math.max(m, peaks[k]!);
      const a = Math.sqrt(m / max) * (h / 2 - 3);
      g.fillRect(x, h / 2 - a, 1, Math.max(1, a * 2));
    }
  }, [peaks, peakMs, w, pps, offsetMs, muted]);
  return <canvas ref={ref} width={w} height={h} className="waveform" data-testid="waveform" />;
}

/**
 * Add a block to a track at source time t (lane "+", double-click, Z, the Captions tab). When t sits
 * inside an existing block of a track whose blocks may not overlap, the new block goes right after it.
 * Errors are shown, never swallowed (a failing "+" used to look like it did nothing).
 */
export function createBlock(track: TrackKind, t: number): number {
  const s = store.get();
  const bundle = s.bundle;
  const duration = bundle?.meta.durationMs ?? 1;
  try {
    const p = s.project;
    let r: Range | null = null;
    if (track === "annotation") r = { startMs: Math.max(0, Math.min(t, duration - 500)), endMs: Math.min(duration, Math.max(t, 0) + DEFAULT_LEN.annotation) };
    else {
      const blocks = blocksOf(p, track);
      let at = t;
      // the playhead never stops inside a cut (output time skips it), it lands on the cut's end:
      // a new cut there would merge into it, so it starts just after
      if (track === "cut") for (const b of blocks) if (at >= b.endMs - 50 && at < b.endMs + 100) at = b.endMs + 100;
      for (let k = 0; k < 50 && !r; k++) {
        r = createRange(blocks, at, DEFAULT_LEN[track], duration, MIN_BLOCK_MS[track]);
        const inside = blocks.find((b) => at >= b.startMs && at < b.endMs);
        // after the block the playhead is in (a cut keeps a small gap, or it would merge into that cut)
        if (!r && inside) at = inside.endMs + (track === "cut" ? 100 : 0);
        else break;
      }
    }
    if (!r) {
      store.notify("No room for a block there");
      return -1;
    }
    const range = { startMs: Math.round(r.startMs), endMs: Math.round(r.endMs) };
    let index = -1;
    store.edit(`Add ${track}`, (q) => {
      const out = addBlock(q, track, range, bundle?.meta.width, bundle?.meta.height);
      index = out.index;
      return track === "cut" ? normalizeCuts(out.project) : out.project;
    });
    if (track === "zoom") store.selectZoom(index);
    else if (track !== "cut") store.select({ track, index });
    return index;
  } catch (e) {
    store.notify(`Could not add ${track}: ${e instanceof Error ? e.message : String(e)}`);
    console.error(e);
    return -1;
  }
}

/** Z / Zoom lane "+": a manual zoom at the playhead; the next click on the preview aims it (fixed point). */
export function addZoomAtPlayhead(): void {
  const s = store.get();
  const t = s.plan?.frames[s.frame]?.src ?? 0;
  const i = createBlock("zoom", t);
  if (i >= 0) {
    store.setZoomPlacing(true);
    store.notify("Zoom added: click the preview to aim it (Esc to keep following the cursor)");
  }
}

/** Delete the selected block, or every block of a multi-selection, as one undo step. */
export function deleteSelection(): boolean {
  const s = store.get();
  if (!s.selection && !s.multi.length) return false;
  store.deleteSelected();
  store.select(null);
  return true;
}
