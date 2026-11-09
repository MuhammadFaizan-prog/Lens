"""End-to-end render pipeline: (optional) on-device transcription -> lens-plan -> compositor.

When the project wants words (captions, transcript cleanup or multi-take on) and none were supplied, an
audio track is transcribed locally with lens-transcribe (faster-whisper) and its transcript is
handed to the engine, so captions and filler/pause removal come straight from the recording's
audio. project.transcription controls it:

  "transcription": {"mode": "auto" | "off", "track": "mic" | null, "model": "base.en", "language": null}

Track choice when track is null: first unmuted mic track, else first unmuted track. Word times are
shifted by the track's offsetMs so they land on the recording clock.
"""
from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .render import RenderOptions, render

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / "packages" / "engine" / "dist" / "cli.js"
TRANSCRIBE_DIR = ROOT / "transcribe"


def _get(d: dict, *keys, default=None):
    for k in keys:
        if not isinstance(d, dict) or k not in d:
            return default
        d = d[k]
    return d


def needs_words(project: dict) -> bool:
    return bool(_get(project, "captions", "enabled", default=False) or _get(project, "edits", "cleanup", "enabled", default=False)
                or _get(project, "edits", "takes", "enabled", default=False))


def pick_track(project: dict) -> Optional[dict]:
    tracks = _get(project, "audio", "tracks", default=[]) or []
    want = _get(project, "transcription", "track")
    if want:
        for t in tracks:
            if t.get("id") == want:
                return t
        raise ValueError(f"transcription.track {want!r} is not an audio track id")
    live = [t for t in tracks if not t.get("muted")]
    for t in live:
        if t.get("kind") == "mic":
            return t
    return live[0] if live else None


def transcribe_track(project: dict, project_dir: Path, out_path: Path) -> Optional[Path]:
    """Transcribe the project's speech track to out_path. Returns None when there is nothing to do."""
    if _get(project, "transcription", "mode", default="auto") == "off" or not needs_words(project):
        return None
    track = pick_track(project)
    if track is None:
        return None
    if str(TRANSCRIBE_DIR) not in sys.path:
        sys.path.insert(0, str(TRANSCRIBE_DIR))
    from lens_transcribe import TranscribeOptions, transcribe_file  # lazy: heavy, optional

    path = Path(track["path"])
    if not path.is_absolute():
        path = project_dir / path
    opts = TranscribeOptions(model=_get(project, "transcription", "model", default="base.en") or "base.en",
                             language=_get(project, "transcription", "language"))
    t = transcribe_file(str(path), opts, offset_ms=int(round(track.get("offsetMs", 0))))
    t["source"] = {"path": str(path), "trackId": track.get("id")}
    # A negative offset skips into the file: words before recording time 0 are not in the recording.
    t["words"] = [w for w in t["words"] if w["endMs"] > 0]
    t["pauses"] = [p for p in t["pauses"] if p["endMs"] > 0]
    out_path.write_text(json.dumps(t, indent=1))
    return out_path


def privacy_warning(project: dict) -> Optional[str]:
    """A warning when the scan found sensitive items nobody reviewed yet (they render unmasked)."""
    dets = _get(project, "privacy", "detections", default=[]) or []
    pending = [d for d in dets if d.get("state", "pending") == "pending"]
    if not pending:
        return None
    kinds = sorted({d.get("type", "?") for d in pending})
    return f"warning: {len(pending)} privacy detection{'s' if len(pending) > 1 else ''} not reviewed ({', '.join(kinds)}); they are not masked in this export"


@dataclass
class PipelineResult:
    plan: Path
    transcript: Optional[Path]
    render: dict


def run(meta: str, events: str, project_path: Optional[str], screen: str, out: str, camera: Optional[str] = None,
        words: Optional[str] = None, opts: RenderOptions = RenderOptions(), work_dir: Optional[str] = None) -> PipelineResult:
    outp = Path(out)
    work = Path(work_dir) if work_dir else outp.parent
    work.mkdir(parents=True, exist_ok=True)
    stem = outp.stem
    project = json.loads(Path(project_path).read_text()) if project_path else {}
    project_dir = Path(project_path).resolve().parent if project_path else Path.cwd()
    # Absolute audio paths so the plan can live next to the output.
    for t in _get(project, "audio", "tracks", default=[]) or []:
        if t.get("path") and not Path(t["path"]).is_absolute():
            t["path"] = str((project_dir / t["path"]).resolve())
    warn = privacy_warning(project)
    if warn:
        print(warn, file=sys.stderr)
    resolved = work / f"{stem}.project.json"
    resolved.write_text(json.dumps(project))
    transcript = Path(words) if words else transcribe_track(project, project_dir, work / f"{stem}.transcript.json")
    plan = work / f"{stem}.plan.json"
    args = ["node", str(CLI), "--meta", meta, "--events", events, "--project", str(resolved), "--out", str(plan)]
    if transcript:
        args += ["--words", str(transcript)]
    p = subprocess.run(args, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"lens-plan failed: {p.stderr.strip() or p.stdout.strip()}")
    info = render(str(plan), screen, out, camera, opts)
    return PipelineResult(plan, transcript, info)
