/**
 * Live auto-zoom for the recorder's preview. The engine's camera (buildCameraTrack) simulates the
 * whole recording at once; while recording only the past is known, so this runs the same per-step
 * logic incrementally: the zoom segments come from the engine's planAutoZoom over the events so far
 * (re-planned when a click or key arrives), and each preview frame advances the same springs
 * (stepSpring, log-space scale, follow deadzone, edge clamp) by the elapsed time.
 *
 * Fed the final segments and the same cursor samples, step() reproduces buildCameraTrack exactly
 * (test/liveCamera.test.ts). The saved project still gets the full plan (smoothing, lead-in, merges)
 * on export; this only drives the preview.
 */
import { activeSegment } from "../../../../packages/engine/src/camera";
import { planAutoZoom } from "../../../../packages/engine/src/autozoom";
import { defaultProject, type ProjectConfig } from "../../../../packages/engine/src/project";
import { stepSpring, type SpringState } from "../../../../packages/engine/src/spring";
import type { InputEvent, RecordingMeta, Vec2, ZoomSegment } from "../../../../packages/engine/src/types";

export interface LiveCameraState {
  t: number;
  cx: number;
  cy: number;
  scale: number;
  segment: string | null;
}

export class LiveCamera {
  private ls: SpringState = { x: 0, v: 0 };
  private sx: SpringState;
  private sy: SpringState;
  private follow: Vec2;
  private prevSeg: string | null = null;
  private lastT: number | null = null;
  private events: InputEvent[] = [];
  private segments: ZoomSegment[] = [];
  private dirty = false;
  state: LiveCameraState;

  constructor(
    private readonly meta: Pick<RecordingMeta, "width" | "height"> & Partial<RecordingMeta>,
    readonly cfg: ProjectConfig["zoom"] = defaultProject().zoom,
    /** Fixed segments (tests); when given, events do not re-plan. */
    private readonly fixed: ZoomSegment[] | null = null,
  ) {
    const home = { x: meta.width / 2, y: meta.height / 2 };
    this.sx = { x: home.x, v: 0 };
    this.sy = { x: home.y, v: 0 };
    this.follow = { ...home };
    this.state = { t: 0, cx: home.x, cy: home.y, scale: 1, segment: null };
    if (fixed) this.segments = fixed;
  }

  /** Add a logged event (down / key re-plan the zooms; moves are passed to step() instead). */
  push(e: InputEvent): void {
    if (e.type === "down" || e.type === "key") {
      this.events.push(e);
      this.dirty = true;
    }
  }

  zoomSegments(nowMs: number): ZoomSegment[] {
    if (this.fixed) return this.fixed;
    if (this.dirty) {
      const meta: RecordingMeta = { width: this.meta.width, height: this.meta.height, fps: 60, pixelRatio: 1, durationMs: nowMs + 3_600_000 };
      this.segments = planAutoZoom(this.events, meta, this.cfg);
      this.dirty = false;
    }
    return this.segments;
  }

  private clamp(c: Vec2, scale: number): Vec2 {
    const halfW = this.meta.width / (2 * scale);
    const halfH = this.meta.height / (2 * scale);
    return { x: Math.min(this.meta.width - halfW, Math.max(halfW, c.x)), y: Math.min(this.meta.height - halfH, Math.max(halfH, c.y)) };
  }

  /** Advance to time t (ms, video clock) with the cursor at `cur` (capture px). */
  step(t: number, cur: Vec2): LiveCameraState {
    const segs = this.zoomSegments(t);
    const seg = activeSegment(segs, t);
    const targetScale = seg ? seg.scale : 1;
    let target: Vec2 = { x: this.meta.width / 2, y: this.meta.height / 2 };
    if (seg) {
      if (seg.focus === "follow") {
        if (seg.id !== this.prevSeg) this.follow = { x: cur.x, y: cur.y };
        const halfW = this.meta.width / (2 * targetScale);
        const halfH = this.meta.height / (2 * targetScale);
        const dzX = halfW * this.cfg.followDeadzone;
        const dzY = halfH * this.cfg.followDeadzone;
        const dx = cur.x - this.follow.x;
        const dy = cur.y - this.follow.y;
        if (Math.abs(dx) > dzX) this.follow.x += dx - Math.sign(dx) * dzX;
        if (Math.abs(dy) > dzY) this.follow.y += dy - Math.sign(dy) * dzY;
        target = this.follow;
      } else target = seg.focus;
      target = this.clamp(target, targetScale);
    }
    this.prevSeg = seg ? seg.id : null;
    if (this.lastT === null) {
      this.ls = { x: Math.log(targetScale), v: 0 };
      this.sx = { x: target.x, v: 0 };
      this.sy = { x: target.y, v: 0 };
    } else {
      const dt = Math.max(0, t - this.lastT);
      this.ls = stepSpring(this.ls, Math.log(targetScale), dt, this.cfg.spring);
      this.sx = stepSpring(this.sx, target.x, dt, this.cfg.spring);
      this.sy = stepSpring(this.sy, target.y, dt, this.cfg.spring);
    }
    this.lastT = t;
    const scale = Math.max(1, Math.exp(this.ls.x));
    const c = this.clamp({ x: this.sx.x, y: this.sy.x }, scale);
    this.state = { t, cx: c.x, cy: c.y, scale, segment: seg ? seg.id : null };
    return this.state;
  }
}

/** Source rect shown by a camera state (for drawImage). */
export function viewportOf(s: Pick<LiveCameraState, "cx" | "cy" | "scale">, width: number, height: number): { x: number; y: number; w: number; h: number } {
  const w = width / s.scale;
  const h = height / s.scale;
  return { x: s.cx - w / 2, y: s.cy - h / 2, w, h };
}
