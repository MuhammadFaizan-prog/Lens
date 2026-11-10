/**
 * Freeze frames (demand #20): hold the screen recording on one frame over a source range while the
 * rest of the video keeps going. Lens's own design (clean room, see docs/FreezeFrames.md).
 *
 * A hold freeze changes no timing: output time, audio, captions, zoom, webcam and annotations run as
 * before; only the screen picture (and the masks glued to it) stops on the frame at startMs. The
 * cursor either keeps moving over the still picture ("live", handy for pointing at a static screen
 * while you talk) or is hidden ("hide").
 *
 * The other kind, a pause that stops everything for a while and inserts silent time, is a slide of
 * kind "freeze" (annotations.ts TextSlide), so it shares the slide timeline insertion and audio shift.
 */

export type FreezeCursor = "live" | "hide";

export interface FreezeFrame {
  id: string;
  /** Source range (recording ms) the screen holds still over; the held frame is the one at startMs. */
  startMs: number;
  endMs: number;
  /** live = the cursor keeps moving over the held picture; hide = no cursor and no click effects. */
  cursor: FreezeCursor;
}

export function defaultFreeze(id: string, startMs: number, endMs = startMs + 2000): FreezeFrame {
  return { id, startMs, endMs, cursor: "live" };
}

/** Fill in missing fields of a hand-written freeze. */
export function normalizeFreeze(raw: Partial<FreezeFrame> & { id: string }): FreezeFrame {
  const startMs = raw.startMs ?? 0;
  return { ...defaultFreeze(raw.id, startMs, raw.endMs ?? startMs + 2000), ...raw };
}

/**
 * The freeze holding source time t, or null. On overlap the one that started first wins, so the held
 * frame never steps backwards in time (the Python reference decodes the screen forward only).
 */
export function freezeAt(items: FreezeFrame[] | undefined, t: number): FreezeFrame | null {
  if (!items?.length) return null;
  let hit: FreezeFrame | null = null;
  for (const f of items) if (t >= f.startMs && t < f.endMs && (!hit || f.startMs < hit.startMs)) hit = f;
  return hit;
}

export function validateFreezes(items: unknown): string[] {
  if (items === undefined) return [];
  if (!Array.isArray(items)) return ["freezes must be a list"];
  const errs: string[] = [];
  const ids = new Set<string>();
  for (const f of items as FreezeFrame[]) {
    if (!f || typeof f !== "object" || typeof f.id !== "string" || !f.id) {
      errs.push("freeze without an id");
      continue;
    }
    if (ids.has(f.id)) errs.push(`freeze ${f.id} id is used twice`);
    ids.add(f.id);
    if (!(Number.isFinite(f.startMs) && f.startMs >= 0 && Number.isFinite(f.endMs) && f.endMs > f.startMs)) errs.push(`freeze ${f.id} needs 0 <= startMs < endMs`);
    if (f.cursor !== "live" && f.cursor !== "hide") errs.push(`freeze ${f.id} cursor must be live or hide`);
  }
  return errs;
}
