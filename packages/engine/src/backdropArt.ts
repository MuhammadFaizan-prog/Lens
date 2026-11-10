import type { FieldStyle } from "./backdropField.js";

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
  /** blobs / waves / rays / grain: the original twelve (vector canvas drawing); the rest are fields (backdropField.ts) */
  style: "blobs" | "waves" | "rays" | "grain" | FieldStyle;
  seed: number;
  /** a style's variant (fields only), e.g. grid dots / lines / neon lines */
  variant?: number;
  /** picker categories (fields only; the original twelve get theirs from CLASSIC_CATEGORIES) */
  tags?: BackdropCategory[];
}

export type BackdropCategory = "mesh" | "aurora" | "blur" | "geometric" | "grain" | "lines" | "rays" | "minimal" | "pastel" | "neon" | "nature" | "classic";

/** Picker chips, in order ("all" is every backdrop). */
export const BACKDROP_CATEGORIES: Array<{ id: "all" | BackdropCategory; label: string }> = [
  { id: "all", label: "All" },
  { id: "mesh", label: "Mesh" },
  { id: "aurora", label: "Aurora" },
  { id: "blur", label: "Blobs & blur" },
  { id: "geometric", label: "Geometric" },
  { id: "grain", label: "Grain" },
  { id: "lines", label: "Waves & lines" },
  { id: "rays", label: "Rays" },
  { id: "minimal", label: "Dark & minimal" },
  { id: "pastel", label: "Pastel" },
  { id: "neon", label: "Neon" },
  { id: "nature", label: "Nature" },
  { id: "classic", label: "Classic" },
];

/** The original twelve, unchanged (ids, colours, seeds: old projects render identically, Rules.md §4). */
const CLASSIC_BACKDROPS: Backdrop[] = [
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

const CLASSIC_CATEGORIES: Record<string, BackdropCategory[]> = {
  aurora: ["classic", "lines"], dusk: ["classic", "blur"], lagoon: ["classic", "blur"], ember: ["classic", "rays"],
  orchard: ["classic", "lines"], nebula: ["classic", "grain", "minimal"], sandstone: ["classic", "lines"], glacier: ["classic", "rays"],
  citrus: ["classic", "blur"], slate: ["classic", "grain", "minimal"], bloom: ["classic", "blur"], tide: ["classic", "rays"],
};

/**
 * v0.1.4 field backdrops (backdropField.ts): per-pixel procedural art rendered at the output size.
 * Palettes are listed in the order each style reads them (see backdropField.ts).
 */
const FIELD_BACKDROPS: Backdrop[] = [
  // mesh gradients: one soft colour point per palette colour, gently warped
  { id: "mesh-lagoon", name: "Lagoon Mesh", colors: ["#0f4c75", "#3282b8", "#bbe1fa", "#1b262c", "#00b7c2"], style: "mesh", seed: 1301, tags: ["mesh"] },
  { id: "mesh-sunrise", name: "Sunrise Mesh", colors: ["#ff9a8b", "#ff6a88", "#ff99ac", "#fcd581", "#a0e7e5"], style: "mesh", seed: 1307, tags: ["mesh"] },
  { id: "mesh-plum", name: "Plum Mesh", colors: ["#2d0b59", "#7b2cbf", "#e0aaff", "#ff6d00", "#240046"], style: "mesh", seed: 1319, tags: ["mesh"] },
  { id: "mesh-deepsea", name: "Deep Sea Mesh", colors: ["#03071e", "#023e8a", "#0077b6", "#7400b8", "#48cae4"], style: "mesh", seed: 1321, tags: ["mesh", "minimal"] },
  { id: "mesh-mint", name: "Mint Mesh", colors: ["#d8f3dc", "#b7e4c7", "#a9def9", "#e4c1f9", "#fcf6bd"], style: "mesh", seed: 1327, tags: ["mesh", "pastel"] },
  { id: "mesh-sherbet", name: "Sherbet Mesh", colors: ["#ffd6a5", "#ffadad", "#fdffb6", "#caffbf", "#bdb2ff"], style: "mesh", seed: 1361, tags: ["mesh", "pastel"] },
  // aurora: night sky (top, bottom) + three light curtains
  { id: "aurora-borealis", name: "Borealis", colors: ["#020617", "#0b1d3a", "#2dd4bf", "#4ade80", "#a78bfa"], style: "aurora", seed: 1409, tags: ["aurora", "nature"] },
  { id: "aurora-polar", name: "Polar Night", colors: ["#04080f", "#102a43", "#7cf5ff", "#56e39f", "#3a86ff"], style: "aurora", seed: 1423, tags: ["aurora"] },
  { id: "aurora-rose", name: "Rose Aurora", colors: ["#0d0221", "#261447", "#ff6ec7", "#c77dff", "#72efdd"], style: "aurora", seed: 1427, tags: ["aurora", "neon"] },
  { id: "aurora-solar", name: "Solar Wind", colors: ["#0a0a0a", "#2b1100", "#ffb703", "#fb8500", "#e63946"], style: "aurora", seed: 1429, tags: ["aurora"] },
  // blobs & blur: big gaussian colour clouds with a fine grain
  { id: "blur-candy", name: "Candy Haze", colors: ["#1a1a2e", "#16213e", "#e94560", "#3a6ea5", "#f9a826"], style: "blur", seed: 1511, tags: ["blur"] },
  { id: "blur-frost", name: "Frosted Glass", colors: ["#f8f9fa", "#e9ecef", "#a2d2ff", "#ffafcc", "#cdb4db"], style: "blur", seed: 1523, tags: ["blur", "pastel"] },
  { id: "blur-lime", name: "Lime Fog", colors: ["#081c15", "#1b4332", "#95d5b2", "#d8f3dc", "#52b788"], style: "blur", seed: 1531, tags: ["blur"] },
  { id: "bokeh-city", name: "City Bokeh", colors: ["#0b090a", "#161a1d", "#ffba08", "#f48c06", "#e85d04", "#ffd60a"], style: "bokeh", seed: 1543, tags: ["blur", "minimal"] },
  { id: "bokeh-teal", name: "Teal Bokeh", colors: ["#001219", "#005f73", "#94d2bd", "#e9d8a6", "#0a9396"], style: "bokeh", seed: 1549, tags: ["blur"] },
  // geometric
  { id: "poly-glacier", name: "Low-poly Glacier", colors: ["#caf0f8", "#90e0ef", "#00b4d8", "#0077b6", "#03045e"], style: "lowpoly", seed: 1601, tags: ["geometric"] },
  { id: "poly-sunset", name: "Low-poly Sunset", colors: ["#ffcdb2", "#ffb4a2", "#e5989b", "#b5838d", "#6d6875"], style: "lowpoly", seed: 1607, tags: ["geometric", "pastel"] },
  { id: "poly-forest", name: "Low-poly Forest", colors: ["#d9ed92", "#99d98c", "#52b69a", "#168aad", "#184e77"], style: "lowpoly", seed: 1609, tags: ["geometric", "nature"] },
  { id: "grid-dots", name: "Dot Grid", colors: ["#0d1117", "#1f2937", "#94a3b8", "#6366f1"], style: "grid", variant: 0, seed: 1613, tags: ["geometric", "minimal"] },
  { id: "grid-blueprint", name: "Blueprint", colors: ["#0a2342", "#2a5ea8", "#cfe8ff", "#7fb7ff"], style: "grid", variant: 1, seed: 1619, tags: ["geometric"] },
  { id: "grid-neon", name: "Neon Grid", colors: ["#05010d", "#1a0b2e", "#ff2bd6", "#00f0ff"], style: "grid", variant: 2, seed: 1621, tags: ["geometric", "neon"] },
  { id: "iso-blocks", name: "Iso Blocks", colors: ["#1e1e24", "#f2c14e", "#f78154", "#4d9078", "#5fad56"], style: "iso", variant: 0, seed: 1627, tags: ["geometric"] },
  { id: "iso-steel", name: "Iso Steel", colors: ["#111111", "#1c2541", "#3a506b", "#5bc0be", "#6fffe9"], style: "iso", variant: 1, seed: 1637, tags: ["geometric", "minimal"] },
  // grain / noise: a warped gradient under film grain
  { id: "grain-twilight", name: "Twilight Grain", colors: ["#231942", "#5e548e", "#9f86c0", "#e0b1cb"], style: "grain2", seed: 1657, tags: ["grain"] },
  { id: "grain-tangerine", name: "Tangerine Grain", colors: ["#ff4800", "#ff6d00", "#ff9e00", "#ffd000"], style: "grain2", seed: 1663, tags: ["grain"] },
  { id: "grain-cotton", name: "Cotton Grain", colors: ["#fde2e4", "#fad2e1", "#e2ece9", "#bee1e6", "#cddafd"], style: "grain2", seed: 1667, tags: ["grain", "pastel"] },
  { id: "grain-noir", name: "Noir Grain", colors: ["#0b0b0b", "#1c1c1c", "#2e2e2e", "#111111"], style: "grain2", seed: 1669, tags: ["grain", "minimal"] },
  // waves & topography lines
  { id: "topo-moss", name: "Moss Contours", colors: ["#1b2d1f", "#2f4f36", "#a3c9a8", "#e9f5db"], style: "topo", seed: 1693, tags: ["lines", "nature"] },
  { id: "topo-ink", name: "Ink Contours", colors: ["#0b132b", "#1c2541", "#5bc0be", "#ffffff"], style: "topo", seed: 1697, tags: ["lines", "minimal"] },
  { id: "topo-sorbet", name: "Sorbet Contours", colors: ["#fff1e6", "#fde2e4", "#e8a598", "#c06c84"], style: "topo", seed: 1699, tags: ["lines", "pastel"] },
  { id: "silk-ocean", name: "Ocean Silk", colors: ["#03045e", "#0096c7", "#90e0ef", "#caf0f8", "#ffffff"], style: "silk", variant: 0, seed: 1709, tags: ["lines"] },
  { id: "silk-gold", name: "Gold Silk", colors: ["#1a1423", "#3d1e3d", "#f9c74f", "#f8961e", "#f94144"], style: "silk", variant: 0, seed: 1721, tags: ["lines"] },
  { id: "silk-neon", name: "Neon Silk", colors: ["#030014", "#0b0033", "#00f5d4", "#9b5de5", "#f15bb5"], style: "silk", variant: 1, seed: 1723, tags: ["lines", "neon"] },
  { id: "silk-laser", name: "Laser Lines", colors: ["#000000", "#0a0a14", "#ff0054", "#ffbd00", "#00bbf9"], style: "silk", variant: 1, seed: 1733, tags: ["lines", "neon"] },
  // rays & bursts
  { id: "burst-sun", name: "Sunburst", colors: ["#ff7b00", "#ff4800", "#ffd000", "#fff3b0"], style: "burst", variant: 0, seed: 1741, tags: ["rays"] },
  { id: "burst-cobalt", name: "Cobalt Burst", colors: ["#001845", "#002855", "#7ea8ff", "#e0ecff"], style: "burst", variant: 0, seed: 1747, tags: ["rays"] },
  { id: "burst-candy", name: "Candy Burst", colors: ["#ffc8dd", "#bde0fe", "#cdb4db", "#ffffff"], style: "burst", variant: 0, seed: 1753, tags: ["rays", "pastel"] },
  { id: "conic-prism", name: "Prism Swirl", colors: ["#ff595e", "#ffca3a", "#8ac926", "#1982c4", "#6a4c93"], style: "burst", variant: 1, seed: 1759, tags: ["rays"] },
  { id: "conic-tide", name: "Tide Swirl", colors: ["#0b132b", "#3a506b", "#5bc0be", "#1c2541"], style: "burst", variant: 1, seed: 1777, tags: ["rays", "minimal"] },
  // dark & minimal
  { id: "spot-graphite", name: "Graphite Spot", colors: ["#0a0a0a", "#3a3a3a", "#6b7280"], style: "spot", variant: 0, seed: 1783, tags: ["minimal"] },
  { id: "spot-horizon", name: "Horizon Line", colors: ["#05060a", "#0d1117", "#7dd3fc"], style: "spot", variant: 1, seed: 1787, tags: ["minimal"] },
  { id: "spot-beam", name: "Soft Beam", colors: ["#09090b", "#52525b", "#a1a1aa"], style: "spot", variant: 2, seed: 1789, tags: ["minimal"] },
  { id: "spot-wine", name: "Wine Spot", colors: ["#120309", "#5c1a33", "#c9184a"], style: "spot", variant: 0, seed: 1801, tags: ["minimal"] },
  // neon / synthwave
  { id: "synth-sunset", name: "Synth Sunset", colors: ["#0d0221", "#541388", "#ff2a6d", "#ffd319"], style: "synth", variant: 0, seed: 1811, tags: ["neon"] },
  { id: "synth-cyan", name: "Cyber Grid", colors: ["#000814", "#3c096c", "#00f5ff", "#f72585"], style: "synth", variant: 1, seed: 1823, tags: ["neon"] },
  // nature-like abstract
  { id: "dunes-sahara", name: "Dunes", colors: ["#fde4cf", "#ffd6a5", "#f4a261", "#e76f51", "#9c4a2f"], style: "dunes", seed: 1831, tags: ["nature"] },
  { id: "dunes-night", name: "Night Dunes", colors: ["#0b1026", "#2b2d5c", "#6c5b7b", "#355c7d", "#1b1b3a"], style: "dunes", seed: 1847, tags: ["nature", "minimal"] },
  { id: "mountains-alpine", name: "Alpine", colors: ["#dbeafe", "#bfdbfe", "#93c5fd", "#3b82f6", "#1e3a8a"], style: "mountains", seed: 1861, tags: ["nature"] },
  { id: "mountains-dusk", name: "Dusk Ridges", colors: ["#ffcad4", "#f4acb7", "#9d8189", "#6d597a", "#355070"], style: "mountains", seed: 1867, tags: ["nature", "pastel"] },
  { id: "sky-clear", name: "Clear Sky", colors: ["#1d4e89", "#8ecae6", "#ffe8a3", "#ffffff"], style: "sky", seed: 1871, tags: ["nature"] },
  { id: "sky-golden", name: "Golden Hour", colors: ["#3d1e6d", "#ff8c42", "#fff3b0", "#ffd6c0"], style: "sky", seed: 1873, tags: ["nature"] },
];

export const BUILTIN_BACKDROPS: Backdrop[] = [...CLASSIC_BACKDROPS, ...FIELD_BACKDROPS];

/** The picker categories a backdrop shows under. */
export function backdropCategories(b: Backdrop): BackdropCategory[] {
  return b.tags ?? CLASSIC_CATEGORIES[b.id] ?? ["classic"];
}

export function backdropById(ref: string): Backdrop | undefined {
  const id = ref.startsWith("builtin:") ? ref.slice(8) : ref;
  return BUILTIN_BACKDROPS.find((b) => b.id === id);
}
