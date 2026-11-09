# Automation: `lens` CLI, `lens-mcp` server, demo-as-code (demand #6)

Lens projects can be driven without the editor: from a terminal, a CI job, or an AI agent. One
package (`packages/cli`) holds the operations; the CLI, the MCP server and `lens run` scripts all
call the same functions, so the three produce identical projects and identical video.

Built clean-room from our own engine and tools (`docs/Rules.md`). Nothing here comes from Screen
Studio, FocuSee or any other product; neither documents a CLI, API or MCP server (inventory OTH-04).

```bash
npm install && npm run build          # builds engine, cli, editor
node packages/cli/dist/cli.js --help  # or: npm run lens -- --help, or npx lens after npm link
```

## Projects

A project is a bundle folder: `screen.mp4`, `meta.json`, `events.jsonl` (required), `project.json`
(the edit), and optionally `cam.mp4`, `mic.wav`, `transcript.json`, brand assets. lens keeps its
working files in `<project>/.lens/` (plans, scans, rendered frames) and exports in
`<project>/exports/` unless `--out` says otherwise. `--project <dir>` / `-C <dir>` (or
`$LENS_PROJECT`, else the working directory) picks the project.

## CLI

| Command | What it does |
|---|---|
| `lens project new <dir> --from <bundle>` (or `--screen --meta --events [--cam --mic --transcript --project-file]`) `[--force]` | Create a project; same inputs again = no change; different files = conflict unless `--force` |
| `lens project open [<dir>]` | Check a project, list its files |
| `lens project info [<dir>]` | Output size and duration, planned zooms, cuts, captions + languages, transcript, takes, privacy / steps review counts, brand |
| `lens plan [--out plan.json] [--language es]` | Render plan (deterministic; returns its sha256) |
| `lens export [--format mp4\|gif\|srt\|vtt] [--out f] [--language es] [--crf n] [--x264-preset p]` (`render` = alias) | Video through the reference compositor, or subtitles on the output clock |
| `lens export demo [--out folder]` / `lens export guide [--out folder]` (also `--format demo\|guide`) | Interactive click-through demo (one self-contained `index.html`) / step guide (`guide.md`, `guide.html`, `guide.pdf`) from the accepted step labels (`docs/InteractiveDemo.md`) |
| `lens demo hotspot <step-id> [--x px --y px] [--tooltip text] [--clear]` | Hotspot editor: move a step's hotspot (source px) or change its tooltip; idempotent |
| `lens frame [--frame n \| --at 1.5s] [--out f.png]` | One output frame, drawn exactly as the export draws it (before the encode) |
| `lens transcribe [--force] [--model m] [--track id]` | On-device speech-to-text of the mic track; keeps an existing transcript unless `--force`; a transcript the engine rejects never replaces the old one |
| `lens translate --to es[,fr,de,ur,ar] [--select es\|source] [--no-download]` | Caption tracks per language (`docs/Translation.md`) |
| `lens takes list` / `lens takes set [--enabled] [--strategy last\|best] [--group i --keep k]` | Retakes (`docs/Takes.md`) |
| `lens privacy scan [--force]` / `privacy accept [id...]` / `privacy dismiss [id...]` | Sensitive-text scan (cached per screen.mp4) and review; no ids = all (`docs/Privacy.md`) |
| `lens steps generate [--force]` / `steps accept [id...]` / `steps dismiss [id...]` | Auto step labels from clicks + OCR (`docs/Annotations.md`) |
| `lens preset list` / `lens preset apply <name\|file.lenspreset> [--sections look,...]` | Presets (`docs/Presets.md`) |
| `lens brand set [--primary] [--accent] [--font] [--name] [--logo f.png] [--watermark] [--json-value '{...}']` | Brand kit; a logo outside the project is copied into `brand/` |
| `lens get [<pointer>]` / `lens set <pointer> <value> [--create]` | Read / write any project field by JSON pointer (RFC 6901). The value is JSON when it parses (`2`, `true`, `null`, `[...]`, `{...}`), else a string (`#ff0000`). Unknown keys are refused unless `--create`; arrays take an index or `-` (append). The engine validates the result |
| `lens zoom add --start t --end t [--scale s] [--focus x,y\|follow] [--id id]` | Manual zoom; id defaults to `zoom-<start>-<end>`, so the same call replaces rather than duplicates |
| `lens cut add --start t --end t` | Cut a range of the recording (audio, captions follow) |
| `lens annotate add '<json>'` | Text / arrow / rect / ellipse / badge / callout; `start`/`end` times, `rect` `[x,y,w,h]`, `from`/`to`/`at` `[x,y]` (source px). Same item (or same `id`) twice = one item |
| `lens run <script.lens.yaml> [--project dir]` | Demo-as-code, below |

Times: milliseconds, or `"1.5s"`, `"800ms"`, `"1:02.5"`. Positions: source pixels.

**`--json`** on every command prints exactly one JSON object on stdout:
`{"ok": true, "command": "zoom add", "result": {...}}` or
`{"ok": false, "command": "...", "error": {"code": "invalid", "message": "...", "exit": 4}}`.
Without `--json` the result is printed as YAML and errors go to stderr. `--progress` streams the
tools' progress lines to stderr.

**Mutations** (set, zoom, cut, annotate, captions, preset, brand, takes, privacy / steps review,
translate) return `changed` and `diff`, the JSON-pointer changes to project.json
(`[{"op": "replace", "path": "/zoom/segments", "value": [...], "old": [...]}]`). Running the same
mutation again returns `changed: false`, `diff: []`, and leaves project.json byte-identical.

**Exit codes**

| Code | Error code | Meaning |
|---|---|---|
| 0 | | success (including nothing to do) |
| 1 | `failed` | a tool ran and failed (renderer, transcriber, translator, scanner) |
| 2 | `usage` | unknown command or option, missing or malformed argument |
| 3 | `not_found` | project, file, field or prerequisite missing (e.g. translate before transcribe) |
| 4 | `invalid` | the engine rejects the value (range, colour, unknown field, bad pointer, bad script) |
| 5 | `outside_root` | a path resolves outside `--root` |
| 6 | `conflict` | `project new` over different existing files without `--force` |

## Sandbox

`--root <dir>` (CLI, or `$LENS_ROOT`) and `lens-mcp` (always) confine every path:

- every path a command reads or writes (project, inputs, `--out`, preset files, logos, scripts and
  the paths inside them) is resolved, symlinks followed, and must lie inside the root; `..`,
  absolute paths elsewhere, symlinks pointing out, and NUL bytes are refused (`outside_root`);
- paths stored in project.json that the renderer reads (audio tracks, brand logo, custom fonts)
  are checked on every write and before every render; a `system:` font must be a bare file name;
- no tool runs a shell or a user-given command: the only processes started are Lens's own scripts
  (`compositor/render.py`, `compositor/frame.py`, `transcribe/lens-transcribe`,
  `translate/lens-translate`, `redact/lens-redact`) with argument arrays.

What the sandbox does not do: it does not limit CPU, memory or disk use, and the on-device tools
themselves are trusted code. Translation may download a model (SHA-256 pinned) on first use unless
`--no-download`.

## MCP server

`lens-mcp` speaks MCP over stdio (`@modelcontextprotocol/sdk`, MIT). Start:
`node packages/cli/dist/mcp.js --root ~/LensProjects` (or `$LENS_MCP_ROOT`; default: the working
directory). Relative paths are relative to the root.

**Tools** (each with a JSON schema; unknown arguments are refused): `project_new`, `project_open`,
`project_info`, `plan`, `export`, `render_frame`, `transcribe`, `translate`, `takes_list`,
`takes_set`, `privacy_scan`, `privacy_review`, `steps_generate`, `steps_review`, `preset_list`,
`preset_apply`, `brand_set`, `get`, `set`, `zoom_add`, `cut_add`, `annotate`, `captions`,
`run_script`. `project_open` / `project_new` set the default project; every other tool also takes
`project`. Results come back as JSON text plus `structuredContent`; errors as tool errors
(`isError`) with `{error: {code, message, exit}}`. `render_frame` also returns the frame as an
image, so the agent sees what it changed.

**Resources** (for the open project): `lens://project/project.json`, `lens://project/info.json`,
`lens://project/transcript.json`, `lens://project/preview.png` (the last frame `render_frame`
drew, rendered now) and the template `lens://project/frame/{n}.png`. Long tools send progress as
MCP log messages (at most one a second).

### Claude Desktop

`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows:
`%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "lens": {
      "command": "node",
      "args": ["/path/to/Lens/packages/cli/dist/mcp.js", "--root", "/Users/me/LensProjects"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add lens -- node /path/to/Lens/packages/cli/dist/mcp.js --root ~/LensProjects
```

or commit a project-scoped `.mcp.json` next to your recordings:

```json
{
  "mcpServers": {
    "lens": { "command": "node", "args": ["/path/to/Lens/packages/cli/dist/mcp.js", "--root", "."] }
  }
}
```

Then, for example: "open `release-1.4`, zoom 1:30 to 2:20 on the sidebar, show me frame 2700,
cut the first 4 seconds, export an mp4 and Spanish subtitles". (Config shapes as documented by
Anthropic for Claude Desktop and Claude Code; check `claude mcp --help` for your version.)

## Demo-as-code: `lens run`

A `.lens.yaml` script is a list of edits applied in order, then exports, so a release pipeline can
re-record the raw session and re-render the same demo:

```yaml
version: 1
name: release demo
project: ./recording                 # relative to this file
steps:
  - preset: { name: Clean Product Demo, sections: [look] }
  - zoom: { start: 1.2s, end: 3.8s, scale: 2.2, focus: [400, 300] }
  - cut: { start: 8.6s, end: 9.2s }
  - annotate: { id: save-label, kind: text, text: "Click Save", start: 5.5s, end: 7.5s, rect: [880, 520, 320, 0] }
  - captions: { enabled: true, style: { fontSize: 40, highlightColor: "#22d3ee", position: top } }
  - brand: { primary: "#1c7ed6", logo: assets/logo.png }
  - set: { /cursor/size: 2, /output/resolution: 1080 }
  - translate: { to: [es], select: source }
  - export: { format: mp4, out: out/demo.mp4 }
  - export: { format: srt, language: es, out: out/demo.es.srt }
```

Steps: `preset`, `brand`, `set` (pointer → value map), `zoom`, `cut`, `annotate`, `captions`
(merged into project.captions), `takes`, `privacy` (`scan`, `accept: all | [ids]`, `dismiss`),
`steps` (`generate`, `accept`), `transcribe`, `translate`, `export`, `frame`. Each runs the CLI
operation of the same name. Every step's shape is checked before the first one runs; a failing
step stops the run and names its number. Paths in the script resolve against the script's folder
and obey `--root`. Edits are idempotent, so re-running a script on the same project changes nothing
and only re-renders the exports.

## Measured (2026-11-09)

Bounds were written into the test files before the first run (see `docs/Tracker.md`):

- CLI integration (`packages/cli/test/integration/cli.test.ts`, 19 tests): every subcommand has a
  happy path and an error path with its exit code and a JSON-shape snapshot; idempotent mutations
  leave project.json byte-identical; export: 300 / 300 frames, duration 10.000 s vs plan 10000 ms;
  espeak speech transcribed with the content words read back.
- MCP (`mcp.test.ts`, 5 tests): 24 tools listed with schemas; open → zoom_add → render_frame:
  mean |diff| 40.56 levels after the zoom (bound ≥ 2.0); export 300 frames / 10 s = plan; resources
  read; 14 path-escape attempts refused with `outside_root`, nothing written outside.
- Demo-as-code (`script.test.ts`, 4 tests): script vs the same 12 CLI calls: project.json
  byte-identical, plan hash identical, 282 / 282 frames identical (luma SSIM min 1.000000, bound
  0.999).
- Unit (`test/unit`, 27 tests): pointers, diff, argument / time parsing, sandbox (dot-dot, absolute,
  symlink out, new file behind a symlink, NUL), MCP argument validation, usage exit codes.

## Not done

- **Recording.** There is no `record` / `stop` (demand #6 asks for `record(target) → projectId`):
  native capture does not exist yet. lens starts from a recorded bundle.
- No HTTP / SSE transport for MCP (stdio only), no auth: it is a local tool.
- No 10-task agent study (the demand report's success metric) and no directory listing yet.
- Speed ranges, layouts, masks, slides and audio settings have no dedicated subcommand; use
  `lens set` on the field.
- `lens run` has no variables, includes or conditions; it is a flat list.
- Tool errors from the Python tools are passed through as text (last stderr lines), not structured.
