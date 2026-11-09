"""Translation model catalogue and on-disk cache.

Every model is an Argos Translate package (.argosmodel: a zip holding a CTranslate2 model and a
SentencePiece tokenizer). Lens loads the CTranslate2 model and the tokenizer directly; the Argos
library and the Stanza sentence splitter inside the package are not used (Lens translates one
caption segment at a time). Licences and attribution: docs/Translation.md.

Models are downloaded once into $LENS_MT_MODEL_DIR (default ~/.cache/lens-mt) and checked
against the SHA-256 below; translation itself never touches the network.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import tempfile
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ModelInfo:
    source: str
    target: str
    name: str          # target language name, in that language
    package: str       # Argos package file name
    sha256: str
    licence: str
    attribution: str
    rtl: bool = False

    @property
    def url(self) -> str:
        return f"https://argos-net.com/v1/{self.package}"

    @property
    def dirname(self) -> str:
        return self.package.removesuffix(".argosmodel")


OPUS_MT = ("OPUS-MT, Jörg Tiedemann and Santhosh Thottingal, \"OPUS-MT — Building open translation services "
           "for the World\", EAMT 2020; converted to CTranslate2 by the Argos Translate project")
ARGOS = "Argos Translate (argosopentech), trained with OpenNMT on OPUS corpora"

MODELS: dict[str, ModelInfo] = {
    "es": ModelInfo("en", "es", "Español", "translate-en_es-1_0.argosmodel",
                    "d698d0ef87ad70d5d184b7fa6965905bf4368f09a2bb9ffb165a79bac96af0c4", "MIT / CC0-1.0",
                    ARGOS + " (OpenSubtitles, ParaCrawl, UNPC)"),
    "fr": ModelInfo("en", "fr", "Français", "translate-en_fr-1_9.argosmodel",
                    "3a65ed83364f4e7b06e30f9dd823db1934899ed3ce839e63f46dc7b09dc797b4", "CC-BY-4.0", OPUS_MT),
    "de": ModelInfo("en", "de", "Deutsch", "translate-en_de-1_3.argosmodel",
                    "6cd847f0c06c9c66013e6b0932e07fd54a6d90894659c02bf6c5247b72fb25b1", "MIT / CC0-1.0", ARGOS),
    "ur": ModelInfo("en", "ur", "اردو", "translate-en_ur-1_9.argosmodel",
                    "5ca67bf37de95941e0eb8b6ad07db197023d13290ab5bd61851d3edc31f0a859", "CC-BY-4.0", OPUS_MT, rtl=True),
    "ar": ModelInfo("en", "ar", "العربية", "translate-en_ar-1_0.argosmodel",
                    "e2a6e84337f7ebbb55f9dc61dcba3a861c0d786ae5a46fa198fd8d6473f5c775", "MIT / CC0-1.0",
                    ARGOS + " (OpenSubtitles, UNPC)", rtl=True),
}


def model_root() -> Path:
    return Path(os.environ.get("LENS_MT_MODEL_DIR", Path.home() / ".cache" / "lens-mt"))


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def model_dir(lang: str, download: bool = True, progress=None) -> Path:
    """Directory holding model/ and sentencepiece.model for en -> lang; downloads it on first use."""
    info = MODELS.get(lang)
    if info is None:
        raise RuntimeError(f"no model for en -> {lang}; known: {', '.join(sorted(MODELS))}")
    root = model_root()
    dest = root / info.dirname
    if (dest / "model" / "model.bin").exists():
        return dest
    if not download:
        raise RuntimeError(f"model for {lang} not in {root}; run once with downloads allowed")
    root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=root) as tmp:
        arc = Path(tmp) / info.package
        if progress:
            progress({"stage": "download", "language": lang, "url": info.url})
        urllib.request.urlretrieve(info.url, arc)
        got = _sha256(arc)
        if got != info.sha256:
            raise RuntimeError(f"{info.package}: SHA-256 {got} does not match the catalogue ({info.sha256})")
        with zipfile.ZipFile(arc) as z:
            z.extractall(Path(tmp) / "x")
        meta = next((Path(tmp) / "x").rglob("metadata.json"))
        shutil.move(str(meta.parent), str(dest))
    return dest
