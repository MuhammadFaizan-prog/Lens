# Presets and brand kit (demand #9)

Lens's own design. Nothing here is taken from Screen Studio, FocuSee or any other product (see
`docs/Rules.md`); the built-in presets, the placeholder logo in the brand sample and the layout of the
brand cards are original.

## What a preset is

A **preset** is a named, versioned bundle of seven sections:

| Section | What it sets | What it never touches |
|---|---|---|
| Look | output aspect, theme palette (primary, accent, caption highlight, backdrop, font), backdrop blur, frame (padding, radius, shadow, inset), motion blur | resolution, fps, crop |
| Zoom | auto on/off, scales, lead / hold / merge, spring, follow deadzone, budget, intensity preset name | your zoom blocks |
| Cursor | size, shape, smoothing, idle hide, click effect, click sound | per-segment overrides |
| Webcam | corner, size, shape, mirror, size while zoomed, transition, hide during silence | webcam on/off, its crop, layouts |
| Captions | on/off, words per block, block length, word highlight, style (size, position, words per line, text colour, pill) | the transcript |
| Audio cleanup | noise reduction, loudness target | audio tracks, volumes |
| Annotation styles | per-kind style (stroke, radius, font size, fills, shadow, ...) | annotation positions, timing, text |

Applying a preset writes the checked sections. Anything a section leaves out takes the built-in default,
so the same preset gives the same result from any starting project. Unchecked sections keep the
project's values exactly. Applying is **one undo step** (`store.applyStylePreset`, engine `applyPreset`).

Colours travel only in the Look section's **palette**, never as literals on captions or annotations,
so a brand kit can still override them. The Annotation styles section restyles existing items of
each listed kind; a colour you set on an item by hand (a literal that differs from the kind's default)
stays.

### Built-in presets

| Preset | Idea |
|---|---|
| Clean Product Demo | airy light-blue gradient, soft long shadow, standard zoom, Inter, blue primary |
| Tutorial | navy gradient, calm zoom, big cursor with click highlight and sound, captions on, orange primary |
| Social Vertical 9:16 | 9:16, punchy zoom, 3-word 64 px captions at 76% height, magenta gradient, -14 LUFS |
| Dark Dev | near-black, mint primary, JetBrains Mono, tight corners, strong shadow |
| Minimal | warm off-white solid backdrop, small padding, quiet shadow, no click effect, no motion blur, calm zoom |

These are design choices, not measurements (Rules.md 4). Applying none of them leaves every default
unchanged.

## The `.lenspreset` file (schema version 2)

```json
{
  "format": "lens-preset",
  "version": 2,
  "id": "team-look",
  "name": "Team look",
  "description": "",
  "revision": 1,
  "sections": {
    "look": { "aspect": "16:9", "palette": { "primary": "#3d63f5", "highlight": "#9fc2ff",
              "background": { "kind": "gradient", "colors": ["#f1f4fa", "#bccbe8"], "angle": 160 }, "font": "Inter" },
              "frame": { "padding": 0.075, "radius": 18 } },
    "zoom": { "auto": true, "defaultScale": 1.6 },
    "captions": { "enabled": true, "style": { "fontSize": 48 } }
  }
}
```

- `version` is the schema version; `revision` is the preset's own version, bumped when it is saved over
  or renamed.
- Every section and every field is optional.
- **Validation** (`validatePreset`): format and version, id (lowercase, digits, dashes), name, unknown
  sections, unknown fields at any depth (checked against the defaults), value types, palette colours,
  caption highlight must be a theme slot (`@highlight`), annotation colours must be `#rrggbb` or a
  slot; then ranges, by applying the preset to a default project and running the project validator.
  Every error is reported with its path (`sections.look.frame.paddng is not a known field`).
- **Migration**: version 1 was the flat 0.x draft (`accentColor`, `look.padding`, `zoom.preset`,
  `cursor.smoothing: bool`, `captions.highlightColor`). `parsePreset` migrates it to version 2 on
  import; exporting writes version 2. (No version-1 files were ever published; the migration exists so
  the format can change without breaking shared presets, and it is unit-tested.)
- Serialising is canonical (`serializePreset`): parse then serialise is byte-identical.

## Library and default for new projects

The editor's **Presets** menu lists the built-ins and your saved presets, each with a **live
thumbnail**: the frame at the playhead rendered with that preset applied to the current project
(engine `buildRenderPlan({ onlyFrames })` + the preview renderer, one at a time, not while playing).
Section checkboxes choose a partial apply. Per preset: Apply, Rename, Duplicate, Export
`.lenspreset`, Use for new projects, Delete (built-ins can be duplicated and exported, not renamed or
deleted). Footer: Save current as preset, Import.

The browser editor keeps the library in `localStorage` (`lens.presets.v1`, stored as `.lenspreset`
text). A bundle without a `project.json` (a new recording) starts from the default preset. Importing
the same file twice does not duplicate it; an id that clashes with a different preset gets a suffix.

CLI: `lens-plan ... --preset look.lenspreset [--preset-sections look,zoom]`.

## Theme slots and precedence

Themed fields hold a literal (`#ff5a36`, `Inter`) or a slot reference:

| Slot | Used by (when the field is left on its default) |
|---|---|
| `@primary` | annotation strokes and fills, step badges, lower-third bars, slide accent bars |
| `@accent` | (available to items; brand accent) |
| `@highlight` | caption word highlight |
| `@font` | captions, annotation text, slides |
| backdrop (`background.inherit: true`) | the backdrop behind the recording |

A reference resolves through layers, highest first:

```
per-item override (a literal on the item)  >  brand kit (when on)  >  preset palette  >  built-in default
```

The built-in palette is exactly the pre-#9 look (`#ff5a36`, `#ffd23f`, the purple-peach gradient,
DejaVu Sans), so a project with no preset and no brand kit renders the same pixels as before and its
plan carries no `fonts` or `watermark` keys. `buildRenderPlan` resolves every reference first
(`applyTheme`), so both renderers only see literals. A project file written before #9 that sets its
own backdrop or caption highlight keeps it (those are literals, i.e. overrides). In the editor a
colour field that follows a slot shows a **Brand** / **Theme** tag; picking a colour makes it the
item's own; ↺ puts the reference back. The backdrop picker has a Theme / Brand swatch.

## Brand kit (`project.brand`)

- **Colours**: primary, accent; backdrop *derived* (a deep 135° gradient from 80% to 42% of the way
  from the primary to near-black) or *custom*; caption highlight takes the primary (default) or the
  accent.
- **Font**: Inter or JetBrains Mono (bundled, SIL Open Font License 1.1, files and licences in
  `assets/fonts/`), DejaVu Sans, or your own files (regular + bold, uploaded into the bundle's `brand/`
  folder; you bring the licence). Preview and export load the same TTF; text uses no kerning on both
  sides so widths match.
- **Logo**: an image in the bundle (`brand/`), its aspect read on upload. As a **watermark**: corner,
  width (fraction of the output width), opacity, safe margin (fraction of the short side). The engine
  places it on whole pixels; both renderers area-average the premultiplied image to exactly that size
  (the preview does it in JS rather than trusting the browser's resampler) and composite it at the
  brand opacity above the caption, under slides.
- **Intro / outro cards**: title, subtitle, length, logo on/off. They are text slides inserted before
  the first frame and after the last, painted with the brand backdrop, brand font, logo above the title
  and a primary accent bar; audio shifts with them like any slide.

Changing the brand primary updates every element that inherits it live (the colour picker is a live
gesture; it commits as one undo step after 400 ms idle).

## Tests

- `packages/engine/test/presets.test.ts` (19): precedence for every layer combination and end to end
  in the plan; default palette = old defaults; built-ins valid, serialise byte-identically; partial
  apply; determinism; segments / tracks / edits survive; restyle keeps hand colours; save -> apply
  round trip; schema errors; v1 migration; watermark geometry; brand propagation; brand cards;
  `onlyFrames`.
- `tests/test_brand.py` (3): on exported MP4s, watermark alpha and edges, brand primary propagation
  to the box, caption highlight and backdrop by pixel colour, intro card length and backdrop.
- `apps/editor/e2e/presets.spec.ts` (4), `annotationsLane.spec.ts` (1), and the brand case in
  `parity.spec.ts`. Numbers in `docs/Tracker.md`.

## Not done

- No cloud / team sync of the library; sharing is by `.lenspreset` file.
- The brand kit lives in the project; there is no separate brand library to reuse across projects
  (save a preset for the look, copy the brand by importing a project).
- No per-aspect variants of one preset (16:9 and 9:16 in one file).
- No SVG logos (PNG / JPEG / WebP only); no animated logo or intro animation beyond the cross-fade.
- Caption text colour and pill colour are not themed slots (literals per preset).
- `.lens` project folder versioning / autosave from demand #9 is not part of this change.
