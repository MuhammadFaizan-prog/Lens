#!/usr/bin/env python3
"""Re-create the caption fonts in assets/fonts from github.com/google/fonts (SIL OFL 1.1).

The TTFs are committed; this script documents exactly where each came from and how it was made, and
re-creates them byte-for-byte from the pinned commit. Static families are copied unchanged. Variable
families are instanced to static Regular (wght 400) and Bold (wght 700) with fontTools'
varLib.instancer (wdth = 100 where the font has that axis); the glyph set is not subset. None of the
instanced families declares a Reserved Font Name in its OFL.txt (checked by this script), so the
instances keep their names. Each family's licence is written next to it as <Family>-OFL.txt.

    pip install fonttools && python3 assets/fonts/fetch_fonts.py
"""
from __future__ import annotations

import hashlib
import io
import sys
import urllib.parse
import urllib.request
from pathlib import Path

GF_COMMIT = "5bb28733cec313b63fbd415b574b5ae35c8aa8b8"  # google/fonts main on 2026-11-08
BASE = f"https://raw.githubusercontent.com/google/fonts/{GF_COMMIT}/"
HERE = Path(__file__).resolve().parent

# out-name prefix, google/fonts dir, source files (static: [regular, bold] or [regular]; variable: [vf])
FAMILIES = [
    ("Poppins", "ofl/poppins", ["Poppins-Regular.ttf", "Poppins-Bold.ttf"], False),
    ("Montserrat", "ofl/montserrat", ["Montserrat[wght].ttf"], True),
    ("Roboto", "ofl/roboto", ["Roboto[wdth,wght].ttf"], True),
    ("OpenSans", "ofl/opensans", ["OpenSans[wdth,wght].ttf"], True),
    ("Oswald", "ofl/oswald", ["Oswald[wght].ttf"], True),
    ("BebasNeue", "ofl/bebasneue", ["BebasNeue-Regular.ttf"], False),
    ("DMSerifDisplay", "ofl/dmserifdisplay", ["DMSerifDisplay-Regular.ttf"], False),
    ("Caveat", "ofl/caveat", ["Caveat[wght].ttf"], True),
]


# SHA-256 of every source font file at GF_COMMIT
SHA256 = {
    "Poppins-Regular.ttf": "7e65201e9b79159e2300267cc885e16c8dcef2424cdfa09a29bfb0980a94a7ba",
    "Poppins-Bold.ttf": "983676516167748b74de6f4771fb384c664fd913acb8b471122ecacf5da5ea6c",
    "Montserrat[wght].ttf": "0f7b311b2f3279e4eef9b2f968bcdbab6e28f4daeb1f049f4f278a902bcd82f7",
    "Roboto[wdth,wght].ttf": "d7598e12c5dbef095ff8272cfc55da0250bd07fbdecbac8a530b9b277872a134",
    "OpenSans[wdth,wght].ttf": "36643644f318a812aab2d2ed3bb98f8cf0872527f835fe9398d95fe6b9adb878",
    "Oswald[wght].ttf": "5b38c246e255a12f5712d640d56bcced0472466fc68983d2d0410ec0457c2817",
    "BebasNeue-Regular.ttf": "08e4623805102d819f58601e46e345648846075e363b2ceb23313c2d1c83ec73",
    "DMSerifDisplay-Regular.ttf": "8cc3643535edf039aa5d95440a8542735e9197e4f4b8d9303e980fefbf5ab616",
    "Caveat[wght].ttf": "0bdb6b660482d31531b3945849fba5916b3ef8695da7024a9e6b9ee3c4157988",
}


def get(path: str) -> bytes:
    url = BASE + urllib.parse.quote(path)
    with urllib.request.urlopen(url, timeout=60) as r:
        data = r.read()
    name = path.rsplit("/", 1)[-1]
    if name in SHA256 and hashlib.sha256(data).hexdigest() != SHA256[name]:
        raise SystemExit(f"{name}: SHA-256 mismatch")
    return data


def main() -> int:
    from fontTools.ttLib import TTFont
    from fontTools.varLib import instancer

    for name, d, files, variable in FAMILIES:
        lic = get(f"{d}/OFL.txt")
        (HERE / f"{name}-OFL.txt").write_bytes(lic)
        # the copyright header (before the licence text) is where a Reserved Font Name is declared
        if variable and b"Reserved Font Name" in lic.split(b"This Font Software is licensed")[0]:
            print(f"{name}: OFL declares a Reserved Font Name; an instance would need renaming", file=sys.stderr)
            return 1
        if not variable:
            for f in files:
                data = get(f"{d}/{f}")
                (HERE / f).write_bytes(data)
                print(f, len(data), hashlib.sha256(data).hexdigest())
            continue
        src = get(f"{d}/{files[0]}")
        print(files[0], "sha256", hashlib.sha256(src).hexdigest())
        for style, wght in (("Regular", 400), ("Bold", 700)):
            font = TTFont(io.BytesIO(src))
            axes = {"wght": wght}
            if any(a.axisTag == "wdth" for a in font["fvar"].axes):
                axes["wdth"] = 100
            inst = instancer.instantiateVariableFont(font, axes, updateFontNames=False)
            out = HERE / f"{name}-{style}.ttf"
            inst.save(str(out))
            print(out.name, out.stat().st_size)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
