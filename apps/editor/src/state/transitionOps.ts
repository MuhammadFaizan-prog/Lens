/**
 * Project edits for cut transitions and enter / exit animations (demand #14). Pure functions; the
 * inspector, the timeline transition chip and the tests share them.
 */
import { defaultTransitions, type CutTransition, type CutTransitionKind, type Easing, type ProjectConfig, type TransitionsConfig } from "@lens/engine";

export const TRANSITION_LABELS: Record<CutTransitionKind, string> = { none: "None (hard cut)", crossfade: "Crossfade", push: "Push", zoom: "Zoom through", blur: "Blur dip" };
export const TRANSITION_GLYPH: Record<CutTransitionKind, string> = { none: "|", crossfade: "◐", push: "⇥", zoom: "⤢", blur: "◌" };
export const EASING_LABELS: Record<Easing, string> = { linear: "Linear", "ease-in": "Ease in", "ease-out": "Ease out", "ease-in-out": "Ease in-out", spring: "Spring" };

/** The project's cut transition default (an absent config = hard cuts). */
export function projectTransitions(p: ProjectConfig): TransitionsConfig {
  return p.transitions ?? { ...defaultTransitions(), kind: "none" };
}

/** Set (patch) the project default; the first change from "absent" starts from the default config. */
export function setProjectTransitions(p: ProjectConfig, patch: Partial<TransitionsConfig>): ProjectConfig {
  const cur = p.transitions ?? { ...defaultTransitions(), kind: "none" as CutTransitionKind };
  return { ...p, transitions: { ...cur, ...patch } };
}

/**
 * The transition a cut actually gets: kind, duration and easing, and whether it is the cut's own or
 * the project default.
 */
export function effectiveCutTransition(p: ProjectConfig, index: number): { kind: CutTransitionKind; durationMs: number; easing: Easing; own: boolean } {
  const d = projectTransitions(p);
  const own = p.edits.cuts[index]?.transition ?? null;
  return { kind: own?.kind ?? d.kind, durationMs: own?.durationMs ?? d.durationMs, easing: own?.easing ?? d.easing, own: !!own };
}

/** Give cut `index` its own transition (patching any it has), or clear it (null = follow the project default). */
export function setCutTransition(p: ProjectConfig, index: number, patch: CutTransition | null): ProjectConfig {
  const cuts = p.edits.cuts.map((c, i) => {
    if (i !== index) return c;
    if (patch === null) {
      const { transition: _t, ...rest } = c;
      return rest;
    }
    return { ...c, transition: { ...(c.transition ?? {}), ...patch } };
  });
  return { ...p, edits: { ...p.edits, cuts } };
}
