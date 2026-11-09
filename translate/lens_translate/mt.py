"""On-device machine translation with CTranslate2 (MIT) + SentencePiece (Apache-2.0).

One Translator per language pair. Input is a list of caption segments (whole sentences or phrases);
each is tokenized with the package's SentencePiece model, translated with beam search on the CPU
(int8 where the CPU supports it), and detokenized. No network access.
"""
from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass
from pathlib import Path

from .models import MODELS, model_dir


@dataclass
class MTOptions:
    beam_size: int = 4
    threads: int = 0          # 0 = all cores
    batch_size: int = 16
    download: bool = True


def _detok(pieces: list[str]) -> str:
    # Works for both package kinds: Argos-trained (shared vocab) and OPUS-MT ports (target pieces
    # that the source SentencePiece model would not decode).
    s = "".join(pieces).replace("\u2581", " ")
    s = re.sub(r"\s+", " ", s).strip()
    # no space before closing punctuation (Latin and Arabic script)
    s = re.sub(r"\s+([,.;:!?\u060C\u061F\u06D4)\]])", r"\1", s)
    return s


class Translator:
    def __init__(self, lang: str, opts: MTOptions = MTOptions(), progress=None):
        import ctranslate2
        import sentencepiece as spm

        self.lang = lang
        self.info = MODELS[lang]
        self.opts = opts
        d: Path = model_dir(lang, download=opts.download, progress=progress)
        threads = opts.threads or int(os.environ.get("LENS_MT_THREADS", "0")) or (os.cpu_count() or 2)
        t0 = time.time()
        self.model = ctranslate2.Translator(str(d / "model"), device="cpu", compute_type="auto", inter_threads=1, intra_threads=threads)
        self.sp = spm.SentencePieceProcessor(model_file=str(d / "sentencepiece.model"))
        self.load_s = time.time() - t0

    def translate(self, texts: list[str], on_batch=None) -> list[str]:
        out: list[str] = []
        for i in range(0, len(texts), self.opts.batch_size):
            chunk = texts[i:i + self.opts.batch_size]
            toks = [self.sp.encode(t, out_type=str) for t in chunk]
            res = self.model.translate_batch(toks, beam_size=self.opts.beam_size, max_decoding_length=256)
            out.extend(_detok(r.hypotheses[0]) for r in res)
            if on_batch:
                on_batch(len(out), len(texts))
        return out
