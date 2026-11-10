"""v0.1.4 field backdrops in the Python compositor (backdrop_field.py, twin of backdropField.ts).

Bounds (set before the first run):
 - every field backdrop the engine lists renders to the same RGB bytes as the TypeScript renderer:
   sha256 equals packages/engine/test/fixtures/backdrop-field-hashes.json (written and checked by the
   engine's vitest), at 160x90;
 - rendering twice gives identical bytes (deterministic), and a 4K-sized call works by row chunks;
 - make_background() draws a field backdrop through style.backdropArt, blur included;
 - the original twelve still draw exactly as in v0.1.3 (pixel hashes recorded from de0daa3's
   backdrop_art.py at 320x180), so old projects render identically (Rules.md §4).
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "compositor"))

from lens_compositor.backdrop_art import draw_backdrop_art  # noqa: E402
from lens_compositor.backdrop_field import FIELD_STYLES, draw_backdrop_field  # noqa: E402
from lens_compositor.render import make_background  # noqa: E402

GOLDEN = json.loads((ROOT / "packages/engine/test/fixtures/backdrop-field-hashes.json").read_text())


def _table() -> dict[str, dict]:
    """The engine's backdrop table (backdropArt.ts), read from its source so the twins cannot drift."""
    src = (ROOT / "packages/engine/src/backdropArt.ts").read_text()
    out = {}
    for m in re.finditer(r'\{ id: "([a-z0-9-]+)", name: "[^"]*", colors: \[([^\]]*)\], style: "([a-z0-9]+)",(?: variant: (\d+),)? seed: (\d+)', src):
        out[m.group(1)] = {"id": m.group(1), "colors": re.findall(r'"(#[0-9a-f]{6})"', m.group(2)), "style": m.group(3),
                           "variant": int(m.group(4) or 0), "seed": int(m.group(5))}
    return out


TABLE = _table()
FIELDS = {k: v for k, v in TABLE.items() if v["style"] in FIELD_STYLES}

V013_CLASSIC = {
    "aurora": "6bc71dd7c81cb4b2346dabf1867170eb", "dusk": "ff937249eed615a14071858b534c66fc",
    "lagoon": "8a3426ae0334bc9e6ce4045ce68b8b2a", "ember": "b6efea8c1a83d48d3b466ae2636332b1",
    "orchard": "80b899effac0a7098dff5e1ccddb6080", "nebula": "13fa8d3f1020ed24a08f9f7558fd9b24",
    "sandstone": "ea443426b12027cc102de532ec32f90a", "glacier": "6c6275bb6d0f246344d2c822726cde4d",
    "citrus": "63db302a80b222418a71457cdfe06a9c", "slate": "b25764db46bf134b89c80ae0a7abe3b7",
    "bloom": "08b2464aa2ef3b881aee712e1650eebe", "tide": "a344ed65c21832132b36300ef73b05d7",
}


def _rgb_hash(bgr: np.ndarray) -> str:
    return hashlib.sha256(bgr[..., ::-1].astype(np.uint8).tobytes()).hexdigest()[:32]


def test_table_parsed():
    assert len(TABLE) == 12 + len(FIELDS) and len(FIELDS) >= 36
    assert set(FIELDS) == set(GOLDEN["hashes"])


@pytest.mark.parametrize("bid", sorted(FIELDS))
def test_field_matches_typescript_bytes(bid):
    art = FIELDS[bid]
    a = draw_backdrop_field(art, GOLDEN["width"], GOLDEN["height"])
    assert a.shape == (GOLDEN["height"], GOLDEN["width"], 3)
    assert _rgb_hash(a) == GOLDEN["hashes"][bid]
    assert np.array_equal(a, draw_backdrop_field(art, GOLDEN["width"], GOLDEN["height"]))


def test_field_through_make_background_with_blur():
    art = FIELDS["synth-sunset"]
    style = {"background": {"kind": "image", "imagePath": "builtin:synth-sunset", "colors": ["#0d0221"], "blur": 0}, "backdropArt": art}
    sharp = make_background(style, 320, 180)
    assert np.abs(sharp - draw_backdrop_art(art, 320, 180)).max() <= 1.0  # only the debanding dither differs
    soft = make_background({**style, "background": {**style["background"], "blur": 6}}, 320, 180)
    assert soft.shape == sharp.shape and float(np.abs(soft - sharp).mean()) > 1


def test_field_renders_large_in_chunks():
    # a 4K-wide strip: exercises the row chunking and the per-column precomputation at full width
    a = draw_backdrop_field(FIELDS["silk-neon"], 3840, 300)
    assert a.shape == (300, 3840, 3) and a.dtype == np.float32 and float(a.std()) > 5


@pytest.mark.parametrize("bid", sorted(V013_CLASSIC))
def test_classic_twelve_unchanged(bid):
    out = draw_backdrop_art(TABLE[bid], 320, 180)
    assert hashlib.sha256(np.round(out).astype(np.uint8).tobytes()).hexdigest()[:32] == V013_CLASSIC[bid]
