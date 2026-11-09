"""lens-translate: on-device caption translation for Lens (demand #8).

  lens-translate transcript.json --to es,fr,de,ur -o out/ [--project project.json --project-out p.json [--select es]]

Splits the transcript (lens-transcribe output) into caption segments (sentences, broken at long
pauses), translates each segment with a local CTranslate2 model, and writes per language:

  out/<lang>.track.json   the caption track (packages/engine/src/translation.ts: CaptionTrack)
  out/<lang>.srt          subtitles on the recording clock
  out/<lang>.vtt          WebVTT, same cues

With --project, the tracks are added to project.translations (replacing a track of the same
language) and the project is written to --project-out (default: in place); --select makes one of
them the caption language. lens-plan then burns that language in and re-times its words onto the
speech that survives the edit. --progress prints one JSON object per line on stdout.

Models download once (SHA-256 checked) into $LENS_MT_MODEL_DIR (default ~/.cache/lens-mt); after
that nothing touches the network. Models and licences: docs/Translation.md.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

from .models import MODELS
from .mt import MTOptions, Translator
from .segment import segment_transcript

ROOT = Path(__file__).resolve().parents[2]
SUBTITLES_JS = ROOT / "packages" / "engine" / "dist" / "subtitlesCli.js"


def build_track(lang: str, source_language: str, segments: list[dict], texts: list[str], tr: Translator) -> dict:
    info = MODELS[lang]
    return {
        "language": lang,
        "name": info.name,
        "rtl": info.rtl,
        "sourceLanguage": source_language,
        "engine": {"name": "ctranslate2", "model": info.dirname, "licence": info.licence},
        "segments": [
            {"id": f"s{i + 1}", "startMs": s["startMs"], "endMs": s["endMs"], "source": s["source"], "text": t}
            for i, (s, t) in enumerate(zip(segments, texts))
        ],
    }


def translate_transcript(transcript: dict, langs: list[str], opts: MTOptions = MTOptions(), progress=None) -> tuple[dict[str, dict], dict]:
    """Return ({lang: track}, stats). stats per language: segments, words, seconds, load seconds."""
    src_lang = (transcript.get("language") or "en") if isinstance(transcript, dict) else "en"
    words = transcript["words"] if isinstance(transcript, dict) else transcript
    segments = segment_transcript(words)
    texts = [s["source"] for s in segments]
    tracks, stats = {}, {}
    for li, lang in enumerate(langs):
        if progress:
            progress({"stage": "load", "language": lang, "index": li, "languages": len(langs)})
        tr = Translator(lang, opts, progress)
        t0 = time.time()

        def on_batch(done: int, total: int, lang=lang, li=li) -> None:
            if progress:
                progress({"stage": "translate", "language": lang, "index": li, "languages": len(langs), "done": done, "total": total})

        out = tr.translate(texts, on_batch) if texts else []
        dt = time.time() - t0
        tracks[lang] = build_track(lang, src_lang, segments, out, tr)
        stats[lang] = {"segments": len(texts), "sourceWords": sum(len(t.split()) for t in texts), "seconds": round(dt, 3), "loadSeconds": round(tr.load_s, 3)}
    return tracks, stats


def write_subtitles(track_path: Path, words_path: Path | None, project_path: Path | None, srt: Path, vtt: Path) -> None:
    cmd = ["node", str(SUBTITLES_JS), "--track", str(track_path), "--srt", str(srt), "--vtt", str(vtt)]
    if words_path:
        cmd += ["--words", str(words_path)]
    if project_path:
        cmd += ["--project", str(project_path)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"lens-subtitles failed: {r.stderr.strip()}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="lens-translate", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("transcript", help="lens-transcribe output (or a bare word list)")
    ap.add_argument("--to", required=True, help=f"target languages, comma-separated ({', '.join(MODELS)})")
    ap.add_argument("-o", "--out", default=None, help="folder for <lang>.track.json, .srt, .vtt")
    ap.add_argument("--project", default=None, help="project.json to add the tracks to")
    ap.add_argument("--project-out", default=None, help="where to write the project (default: --project, in place)")
    ap.add_argument("--select", default=None, help="caption language to select in the project")
    ap.add_argument("--beam", type=int, default=4)
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--no-download", action="store_true", help="fail instead of downloading a missing model")
    ap.add_argument("--progress", action="store_true", help="JSON progress lines on stdout")
    a = ap.parse_args(argv)
    langs = [x.strip() for x in a.to.split(",") if x.strip()]
    bad = [x for x in langs if x not in MODELS]
    if bad:
        print(f"lens-translate: no model for {', '.join(bad)} (known: {', '.join(MODELS)})", file=sys.stderr)
        return 2
    if not a.out and not a.project:
        print("lens-translate: give -o and/or --project", file=sys.stderr)
        return 2

    def progress(ev: dict) -> None:
        if a.progress:
            print(json.dumps(ev), flush=True)

    transcript = json.loads(Path(a.transcript).read_text())
    t0 = time.time()
    try:
        tracks, stats = translate_transcript(transcript, langs, MTOptions(beam_size=a.beam, threads=a.threads, download=not a.no_download), progress)
    except RuntimeError as e:
        print(f"lens-translate: {e}", file=sys.stderr)
        return 1
    if a.out:
        out = Path(a.out)
        out.mkdir(parents=True, exist_ok=True)
        for lang, track in tracks.items():
            tp = out / f"{lang}.track.json"
            tp.write_text(json.dumps(track, ensure_ascii=False, indent=1))
            try:
                write_subtitles(tp, Path(a.transcript), Path(a.project) if a.project else None, out / f"{lang}.srt", out / f"{lang}.vtt")
            except (RuntimeError, FileNotFoundError) as e:
                print(f"lens-translate: {e}", file=sys.stderr)
                return 1
    if a.project:
        pp = Path(a.project)
        project = json.loads(pp.read_text())
        tr = project.setdefault("translations", {"language": None, "tracks": []})
        tr.setdefault("tracks", [])
        for lang, track in tracks.items():
            tr["tracks"] = [t for t in tr["tracks"] if t.get("language") != lang] + [track]
        if a.select:
            tr["language"] = None if a.select == "source" else a.select
        tr.setdefault("language", None)
        Path(a.project_out or a.project).write_text(json.dumps(project, ensure_ascii=False, indent=1))
    for lang, s in stats.items():
        rate = s["sourceWords"] / s["seconds"] if s["seconds"] > 0 else 0
        msg = (f"lens-translate: {lang} {s['segments']} segments, {s['sourceWords']} words in {s['seconds']:.2f}s "
               f"({rate:.0f} words/s; model load {s['loadSeconds']:.2f}s, {MODELS[lang].licence})")
        print(msg, file=sys.stderr)
    progress({"stage": "done", "languages": langs, "seconds": round(time.time() - t0, 3), "stats": stats})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
