/**
 * Lens's own backdrop art (Windows bug #20): twelve procedural abstract images described by a seed, a
 * palette and a style. Original designs, no third-party wallpapers or assets. The editor draws them
 * (apps/editor/src/render/backdrops.ts) and the plan carries the chosen one (style.backdropArt) so
 * the Python compositor draws the same picture (compositor/lens_compositor/backdrop_art.py).
 */
export interface Backdrop {
  id: string;
  name: string;
  colors: string[];
  style: "blobs" | "waves" | "rays" | "grain";
  seed: number;
}

export const BUILTIN_BACKDROPS: Backdrop[] = [
  { id: "aurora", name: "Aurora", colors: ["#0b1026", "#1f6f8b", "#99e1d9", "#f0f3bd"], style: "waves", seed: 11 },
  { id: "dusk", name: "Dusk", colors: ["#1a1033", "#6b2d5c", "#f0386b", "#ff9f1c"], style: "blobs", seed: 23 },
  { id: "lagoon", name: "Lagoon", colors: ["#022b3a", "#1f7a8c", "#bfdbf7", "#e1e5f2"], style: "blobs", seed: 37 },
  { id: "ember", name: "Ember", colors: ["#140d0b", "#7a1f0f", "#e2711d", "#ffc971"], style: "rays", seed: 41 },
  { id: "orchard", name: "Orchard", colors: ["#0d2818", "#04471c", "#058c42", "#c9f2c7"], style: "waves", seed: 53 },
  { id: "nebula", name: "Nebula", colors: ["#07031a", "#3c1a78", "#b14aed", "#fbd1ff"], style: "grain", seed: 67 },
  { id: "sandstone", name: "Sandstone", colors: ["#3d2c1e", "#9c6644", "#ddb892", "#f4ede4"], style: "waves", seed: 71 },
  { id: "glacier", name: "Glacier", colors: ["#e8f1f8", "#b9d6ee", "#6aa6d6", "#2b5f8e"], style: "rays", seed: 83 },
  { id: "citrus", name: "Citrus", colors: ["#fff3b0", "#ffd166", "#ef8354", "#5e2bff"], style: "blobs", seed: 97 },
  { id: "slate", name: "Slate", colors: ["#111418", "#2a3039", "#4b5563", "#9aa5b1"], style: "grain", seed: 101 },
  { id: "bloom", name: "Bloom", colors: ["#2b0a3d", "#a4036f", "#ff7aa2", "#ffe3ec"], style: "blobs", seed: 113 },
  { id: "tide", name: "Tide", colors: ["#03045e", "#0077b6", "#00b4d8", "#caf0f8"], style: "rays", seed: 127 },
];

export function backdropById(ref: string): Backdrop | undefined {
  const id = ref.startsWith("builtin:") ? ref.slice(8) : ref;
  return BUILTIN_BACKDROPS.find((b) => b.id === id);
}
