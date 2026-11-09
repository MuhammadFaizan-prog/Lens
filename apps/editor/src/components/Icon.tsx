/** Lens UI icons: original line glyphs drawn for this editor (24 px grid, 1.6 px stroke). */
const PATHS: Record<string, string> = {
  play: "M8 5.5v13l10.5-6.5z",
  pause: "M8 5.5h2.8v13H8zM13.2 5.5H16v13h-2.8z",
  prev: "M7 6v12M18 6l-8 6 8 6z",
  next: "M17 6v12M6 6l8 6-8 6z",
  loop: "M4 12a6 6 0 0 1 6-6h8m-3-3 3 3-3 3M20 12a6 6 0 0 1-6 6H6m3 3-3-3 3-3",
  undo: "M9 7 4 12l5 5M4.5 12H14a5 5 0 0 1 0 10h-2",
  redo: "M15 7l5 5-5 5M19.5 12H10a5 5 0 0 0 0 10h2",
  open: "M3.5 7.5V18a1.5 1.5 0 0 0 1.5 1.5h14a1.5 1.5 0 0 0 1.5-1.5V9.5A1.5 1.5 0 0 0 19 8h-7l-2-2.5H5A1.5 1.5 0 0 0 3.5 7z",
  save: "M5 4h11l3 3v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1zM8 4v5h7V4M8 20v-6h8v6",
  export: "M12 15V4m-4 4 4-4 4 4M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14",
  plus: "M12 5v14M5 12h14",
  trash: "M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12",
  magnet: "M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4zM6 8h4M14 8h4",
  sparkle: "M12 3v5M12 16v5M3 12h5M16 12h5M6 6l3 3M15 15l3 3M18 6l-3 3M9 15l-3 3",
  close: "M6 6l12 12M18 6 6 18",
  scissors: "M6.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM6.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM8.5 7.5 20 17M8.5 16.5 20 7",
  restore: "M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4",
  check: "M5 12.5l4.5 4.5L19 7.5",
  shield: "M12 3.5 5 6.5v5c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9v-5zM9 12l2.2 2.2L15.5 10",
};

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const filled = name === "play" || name === "pause" || name === "prev" || name === "next";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="icon">
      <path d={PATHS[name] ?? ""} fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={filled ? 0 : 1.6} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The Lens mark: an aperture of three offset rings (original). */
export function LensMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="lm" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5eead4" />
          <stop offset="1" stopColor="#60a5fa" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="13" fill="none" stroke="url(#lm)" strokeWidth="3" />
      <circle cx="16" cy="16" r="6.5" fill="url(#lm)" />
      <circle cx="13.5" cy="13.5" r="2" fill="#0b0d10" opacity="0.55" />
    </svg>
  );
}
