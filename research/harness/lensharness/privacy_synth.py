"""Synthetic screen session with planted (fake) secrets, for the privacy-redaction tests.

Everything is drawn here (PIL + DejaVu fonts); no third-party media. A fake "Acme Console" app with a
static top bar and sidebar, a scrolling main document, a card that moves across the screen and
notification banners that slide in at the top right. The secrets are fake values (documentation
example keys, the public 4242 test card, a 555 phone number) mixed with decoy text that must not be
flagged: normal words, short numbers, hex colours, versions, dates, prices, a non-Luhn 16-digit
number, a short git sha, file paths, camelCase identifiers.

Ground truth (gt.json): for every secret, its type, its text and its visible box in source px on
every frame where it is at least half visible (clipped to what is on screen).

  python3 -m lensharness.privacy_synth --out DIR [--variant dev|heldout] [--duration-ms 60000] [--fps 30]

Two variants: "dev" (the scanner's constants were tuned while looking at it) and "heldout" (written
at the same time, used only for the test measurements): dark theme, other secrets, decoys, sizes,
scroll schedule, card path and banner positions.
"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 720
SANS = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
SANS_B = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"

# Main scrolling panel (viewport) in screen px.
PX0, PY0, PX1, PY1 = 236, 64, 1264, 712
DOC_W = PX1 - PX0

# Fake secrets (none is real: AKIAIOSFODNN7EXAMPLE is AWS's documentation example, 4242... is the
# public Stripe test card, 555-01xx numbers are reserved for fiction).
DEV_SECRETS = {
    "email": "jane.doe@acme-corp.com",
    "email2": "billing@northwind.io",
    "sk": "sk-proj-4fT9xQ2LmZ8vB1nR7kW3yH6cJ0pD",
    "card": "4242 4242 4242 4242",
    "card2": "5555 5555 5555 4444",
    "phone": "+1 (415) 555-0132",
    "jwt": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1rwW1gFWFOEjXk",
    "ip": "192.168.14.207",
    "ghp": "ghp_8Kd2mQ7xL4vN9pR1sT6wY3zB5cF0hJ2aE7gU",
    "akia": "AKIAIOSFODNN7EXAMPLE",
}
SECRET_TYPE = {"email": "email", "email2": "email", "sk": "api_key", "card": "card", "card2": "card", "phone": "phone",
               "jwt": "jwt", "ip": "ip", "ghp": "api_key", "akia": "api_key", "tok": "token"}

DEV_DECOYS = [
    "Billing overview", "Order #4521 shipped in 3 days", "Theme colour #1a2b3c, accent #FF8800",
    "Version 2.14.3", "Updated 2026-11-09 at 10:45", "Total $1,299.00", "Reference 1234 5678 9012 3456",
    "Commit 2309c66 on main", "src/components/AppHeader.tsx", "internationalization settings",
    "useEffectCallback(handler)", "ZIP 94107, Room 12B", "Invoice 0042-17", "Qty 3 x 250 ml",
]

# The held-out variant: written together with the dev one, never used while tuning the scanner.
# Dark theme, other fonts sizes, other secrets (a UK phone, an Amex test card, a GitLab token, a
# generic high-entropy token with no known prefix), other decoys, other motion.
HELD_SECRETS = {
    "email": "m.okafor@example.org",
    "email2": "ops-team@contoso.net",
    "sk": "sk-ant-api03-Zq7Rr2Vb9Xk1Lm4Np8Tc3Wd6",
    "card": "4000 0566 5566 5556",
    "card2": "3782 822463 10005",
    "phone": "+44 20 7946 0958",
    "jwt": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTQyIiwiaWF0IjoxNzAwMDAwMDAwfQ.k3J9sQ2vT8xLmZ0pR4wB7nC1yD6fH5gA",
    "ip": "10.42.7.199",
    "ghp": "glpat" + "-x7Kp2RqT9mWz4LsV8nYb",
    "akia": "AKIA4Q7XZT2EXAMPLE9K",
    "tok": "api_token=Q2x9vR7mT4kZ8pL1wN6sB3cY5",
}
HELD_DECOYS = [
    "Build 1043 passed in 52 s", "Background #0f172a, border #334155", "Release 3.0.12", "Extension 214",
    "Meeting at 14:30 on 2026-12-01", "Price €24.99 per seat", "Reference 4111 2222 3333 4444",
    "Short id 7f3a2c1", "docs/README.md", "camelCaseIdentifier", "Batch 2026-11 #88", "Port 8080 and 443",
]

# A second held-out set, written after the first held-out run had been used to find two bugs, so
# that one measurement is again on text and motion nobody looked at while changing the scanner.
FRESH_SECRETS = {
    "email": "r.tanaka@fabrikam.co.jp",
    "email2": "security@tailspin.dev",
    "sk": "sk-proj-Hq3Ld8Wm2Pz6Xt9Rb4Kc7Vn1Ys5",
    "card": "6011 0009 9013 9424",
    "card2": "5105 1051 0510 5100",
    "phone": "(212) 555-0147",
    "jwt": "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJvcHMiLCJyb2xlIjoiYWRtaW4ifQ.Tq8Lw3Zr6Pm1Xk9Vb4Nc7Hd2Fs5Jg0Ya",
    "ip": "172.16.254.3",
    "ghp": "ghp_Zx4Qw8Er2Ty6Ui0Op3As7Df1Gh5Jk9Lz2Xc6",
    "akia": "AKIAZ3MX7QPR2EXAMPLE",
    "tok": "client_secret=Hn7Kq2Wz9Lp4Xr6Tv1Bm8Cs3",
}

VARIANTS = {
    "dev": {"secrets": DEV_SECRETS, "decoys": DEV_DECOYS, "dark": False, "size": 19, "mono": 19,
            "scroll": [(0, 0), (4000, 0), (12000, 700), (18000, 700), (26000, 1500), (32000, 1500), (38000, 900), (44000, 900), (52000, 1900), (60000, 1900)],
            "card": (36000, 50000, 300, 560, 230, 170), "notifs": [(20000, 23500, "top"), (47000, 50500, "top")]},
    "heldout": {"secrets": HELD_SECRETS, "decoys": HELD_DECOYS, "dark": True, "size": 17, "mono": 18,
                "scroll": [(0, 0), (2500, 0), (9000, 520), (15000, 520), (21000, 1250), (27000, 1250), (31000, 600), (36000, 600), (45000, 1750), (52000, 1750), (56000, 2050), (60000, 2050)],
                "card": (30000, 42000, 760, -480, 520, -140), "notifs": [(12000, 15000, "bottom"), (49000, 53000, "top")]},
    "fresh": {"secrets": FRESH_SECRETS, "decoys": HELD_DECOYS, "dark": False, "size": 20, "mono": 17,
              "scroll": [(0, 0), (3000, 0), (7000, 400), (11000, 400), (19000, 1500), (24000, 1500), (29000, 300), (35000, 300), (44000, 1100), (50000, 1100), (57000, 2000), (60000, 2000)],
              "card": (14000, 27000, 330, 420, 360, 220), "notifs": [(31000, 34000, "top"), (52000, 55500, "bottom")]},
}
V = VARIANTS["dev"]
SECRETS = DEV_SECRETS
DECOYS = DEV_DECOYS


@dataclass
class Item:
    """One drawn text line: `parts` are (text, secret_key | None) runs drawn left to right."""
    y: int
    parts: list[tuple[str, str | None]]
    font: str = SANS
    size: int = 19
    x: int = 24
    colour: tuple[int, int, int] = (40, 44, 52)
    boxes: list[tuple[str, tuple[int, int, int, int]]] = field(default_factory=list)


def _doc_items() -> list[Item]:
    """The main document's lines (doc coordinates, y top of line)."""
    P = "Lorem ipsum style filler is not used; these are plain sentences about the console."
    lines: list[Item] = []
    y = 24

    def add(parts, **kw):
        nonlocal y
        it = Item(y=y, parts=parts, **kw)
        lines.append(it)
        y += kw.pop("gap", 0) or (int(it.size * 1.9) if it.size < 24 else 46)
        return it

    add([("Account settings", None)], font=SANS_B, size=28)
    add([("Manage your profile, billing and API access for the workspace.", None)])
    add([("Primary contact: ", None), (SECRETS["email"], "email")])
    add([("Theme colour #1a2b3c, accent #FF8800", None)])
    add([("Version 2.14.3 · Updated 2026-11-09 at 10:45", None)])
    y += 40
    add([("Billing overview", None)], font=SANS_B, size=24)
    add([("Order #4521 shipped in 3 days. Total $1,299.00", None)])
    add([("Card on file: ", None), (SECRETS["card"], "card")], font=MONO, size=19)
    add([("Reference 1234 5678 9012 3456 (internal ledger id)", None)], font=MONO, size=19)
    add([("Invoice 0042-17 · Qty 3 x 250 ml · ZIP 94107, Room 12B", None)])
    add([("Support line: ", None), (SECRETS["phone"], "phone")])
    for i in range(5):
        add([(f"Usage note {i + 1}: requests are grouped by project and billed at the end of the month.", None)])
    y += 60
    add([("API access", None)], font=SANS_B, size=24)
    add([("Secret key: ", None), (SECRETS["sk"], "sk")], font=MONO, size=19)
    add([("Commit 2309c66 on main · src/components/AppHeader.tsx", None)], font=MONO, size=18)
    add([("useEffectCallback(handler) runs once per render; internationalization settings apply.", None)], font=MONO, size=17)
    add([("Session token:", None)])
    add([(SECRETS["jwt"], "jwt")], font=MONO, size=16)
    for i in range(6):
        add([(f"Changelog item {i + 1}: the dashboard now remembers your last filter and sort order.", None)])
    y += 80
    add([("Network", None)], font=SANS_B, size=24)
    add([("Gateway address ", None), (SECRETS["ip"], "ip"), ("  port 8443", None)], font=MONO, size=19)
    add([("Subnets are managed by the platform team; ask in the infra channel.", None)])
    for i in range(8):
        add([(f"Audit entry {i + 1}: settings page viewed, no changes were saved.", None)])
    y += 60
    add([("Team", None)], font=SANS_B, size=24)
    add([("Invoices go to ", None), (SECRETS["email2"], "email2")])
    add([("Backup card ", None), (SECRETS["card2"], "card2")], font=MONO, size=19)
    for i in range(14):
        add([(f"Member {i + 1} joined the workspace and accepted the default notification rules.", None)])
    _ = P
    return lines


def _held_items(name: str = "heldout") -> list[Item]:
    """Held-out document: other wording, order, sizes and a token with no known prefix."""
    S = VARIANTS[name]["secrets"]
    lines: list[Item] = []
    y = 30
    sz, ms = VARIANTS[name]["size"], VARIANTS[name]["mono"]

    def add(parts, **kw):
        nonlocal y
        kw.setdefault("size", sz)
        it = Item(y=y, parts=parts, **kw)
        lines.append(it)
        y += int(it.size * 2.0) if it.size < 24 else 48
        return it

    add([("Workspace profile", None)], font=SANS_B, size=26)
    add([("Build 1043 passed in 52 s · Release 3.0.12", None)])
    add([("Owner ", None), (S["email"], "email"), (" (billing admin)", None)])
    add([("Background #0f172a, border #334155", None)], font=MONO, size=ms)
    for i in range(3):
        add([(f"Step {i + 1}: open the project, choose a region and confirm the plan.", None)])
    add([("Escalations: call ", None), (S["phone"], "phone"), (", Extension 214", None)])
    add([("Meeting at 14:30 on 2026-12-01 · Price €24.99 per seat", None)])
    y += 50
    add([("Payment methods", None)], font=SANS_B, size=22)
    add([("Visa debit ", None), (S["card"], "card")], font=MONO, size=ms)
    add([("Reference 4111 2222 3333 4444 · Batch 2026-11 #88", None)], font=MONO, size=ms)
    add([("Amex ", None), (S["card2"], "card2"), (" expires 08/29", None)], font=MONO, size=ms)
    for i in range(6):
        add([(f"Note {i + 1}: invoices are issued on the first working day of each month.", None)])
    y += 70
    add([("Credentials", None)], font=SANS_B, size=22)
    add([("ANTHROPIC_API_KEY=", None), (S["sk"], "sk")], font=MONO, size=ms)
    add([("Short id 7f3a2c1 · docs/README.md · camelCaseIdentifier", None)], font=MONO, size=ms)
    add([("curl -H \"Authorization: Bearer ...\" with", None)], font=MONO, size=ms)
    add([(S["jwt"], "jwt")], font=MONO, size=15)
    add([("Webhook ", None), (S["tok"], "tok")], font=MONO, size=ms)
    for i in range(7):
        add([(f"History {i + 1}: a teammate rotated a credential and left a comment.", None)])
    y += 60
    add([("Infrastructure", None)], font=SANS_B, size=22)
    add([("Bastion host ", None), (S["ip"], "ip"), (" · Port 8080 and 443", None)], font=MONO, size=ms)
    for i in range(9):
        add([(f"Event {i + 1}: the nightly backup finished without warnings.", None)])
    y += 40
    add([("Contacts", None)], font=SANS_B, size=22)
    add([("Escalate to ", None), (S["email2"], "email2")])
    for i in range(16):
        add([(f"Seat {i + 1} is assigned and synced with the directory.", None)])
    return lines


THEMES = {
    False: {"doc": (252, 252, 253), "text": (40, 44, 52), "secret": (20, 24, 30), "rule": (226, 228, 232), "chrome": (238, 240, 244),
            "bar": (32, 36, 46), "side": (246, 247, 250), "side_text": (70, 76, 90), "card": (255, 255, 255), "card_line": (200, 206, 218),
            "card_text": (60, 66, 80), "note": (250, 250, 252), "note_line": (180, 186, 198), "note_t1": (30, 34, 44), "note_t2": (70, 76, 90)},
    True: {"doc": (24, 27, 34), "text": (200, 206, 216), "secret": (236, 240, 246), "rule": (50, 56, 68), "chrome": (18, 20, 26),
           "bar": (10, 12, 16), "side": (30, 33, 40), "side_text": (170, 178, 190), "card": (44, 48, 58), "card_line": (90, 98, 114),
           "card_text": (210, 216, 226), "note": (54, 58, 68), "note_line": (96, 104, 120), "note_t1": (236, 240, 246), "note_t2": (190, 196, 206)},
}
T = THEMES[False]
DOC_ITEMS = _doc_items()
DOC_H = DOC_ITEMS[-1].y + 400
SCROLL_KEYS: list = VARIANTS["dev"]["scroll"]
NOTIFS: list = VARIANTS["dev"]["notifs"]


def use_variant(name: str) -> None:
    """Switch the module to the dev or the held-out session (secrets, document, theme, motion)."""
    global V, SECRETS, DECOYS, T, DOC_ITEMS, DOC_H, SCROLL_KEYS, NOTIFS
    V = VARIANTS[name]
    SECRETS, DECOYS, T = V["secrets"], V["decoys"], THEMES[V["dark"]]
    DOC_ITEMS = _doc_items() if name == "dev" else _held_items(name)
    for it in DOC_ITEMS:
        if it.colour == (40, 44, 52):
            it.colour = T["text"]
    DOC_H = DOC_ITEMS[-1].y + 400
    SCROLL_KEYS, NOTIFS = V["scroll"], V["notifs"]


def _font(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size)


def _draw_item(d: ImageDraw.ImageDraw, it: Item, ox: int = 0, oy: int = 0) -> list[tuple[str, tuple[int, int, int, int]]]:
    f = _font(it.font, it.size)
    x = it.x + ox
    boxes = []
    for text, key in it.parts:
        if key:
            b = d.textbbox((x, it.y + oy), text, font=f)
            boxes.append((key, (b[0], b[1], b[2] - b[0], b[3] - b[1])))
            d.text((x, it.y + oy), text, font=f, fill=T["secret"])
        else:
            d.text((x, it.y + oy), text, font=f, fill=it.colour)
        x += int(round(d.textlength(text, font=f)))
    return boxes


def render_document() -> tuple[Image.Image, dict[str, tuple[int, int, int, int]]]:
    img = Image.new("RGB", (DOC_W, DOC_H), T["doc"])
    d = ImageDraw.Draw(img)
    boxes: dict[str, tuple[int, int, int, int]] = {}
    for it in DOC_ITEMS:
        for k, b in _draw_item(d, it):
            boxes[k] = b
    # light separators
    for it in DOC_ITEMS:
        if it.font == SANS_B and it.y > 40:
            d.line([(16, it.y - 14), (DOC_W - 16, it.y - 14)], fill=T["rule"], width=1)
    return img, boxes


def render_chrome() -> tuple[Image.Image, dict[str, tuple[int, int, int, int]]]:
    """Static top bar + sidebar (screen coordinates). The sidebar carries the AWS key."""
    img = Image.new("RGB", (W, H), T["chrome"])
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 52], fill=T["bar"])
    d.text((20, 13), "Acme Console", font=_font(SANS_B, 21), fill=(240, 240, 245))
    for i, t in enumerate(["Overview", "Billing", "Deploys", "Docs"]):
        d.text((260 + i * 120, 16), t, font=_font(SANS, 17), fill=(190, 196, 210))
    d.rectangle([0, 52, 224, H], fill=T["side"])
    for i, t in enumerate(["Overview", "Billing", "API keys", "Team", "Settings", "Audit log", "Version 2.14.3"]):
        d.text((22, 84 + i * 40), t, font=_font(SANS, 18), fill=T["side_text"])
    d.text((18, 400), "AWS access key", font=_font(SANS_B, 15), fill=T["side_text"])
    boxes = {}
    it = Item(y=426 if not V["dark"] else 560, x=14, parts=[(SECRETS["akia"], "akia")], font=MONO, size=15)
    for k, b in _draw_item(d, it):
        boxes[k] = b
    d.text((18, 470), "Region eu-west-1", font=_font(SANS, 15), fill=T["side_text"])
    d.rectangle([PX0 - 4, PY0 - 4, PX1 + 4, PY1 + 4], outline=(214, 218, 226))
    return img, boxes


def _ease(u: float) -> float:
    u = min(1.0, max(0.0, u))
    return u * u * (3 - 2 * u)




def scroll_at(t: float, duration_ms: float) -> float:
    keys = [(k * duration_ms / 60000, v) for k, v in SCROLL_KEYS]
    for (t0, v0), (t1, v1) in zip(keys, keys[1:]):
        if t0 <= t <= t1:
            return v0 + (v1 - v0) * _ease((t - t0) / max(1e-6, t1 - t0))
    return keys[-1][1]


def card_at(t: float, duration_ms: float):
    """The floating deploy-token card: visible 36-50 s (scaled), moving along a curve. Returns (x, y) or None."""
    s = duration_ms / 60000
    a, b, x0, dx, y0, dy = V["card"]
    t0, t1 = a * s, b * s
    if not (t0 <= t < t1):
        return None
    u = (t - t0) / (t1 - t0)
    x = x0 + dx * u
    y = y0 + dy * math.sin(u * math.pi * 1.5)
    return int(round(x)), int(round(y))


NOTE_W, NOTE_H = 360, 78
NOTE_TEXT = [("Messages · Sam Lee", "standup moved to 10:45"), ("Mail · Priya Shah", "Your invoice is ready")]


def notif_at(t: float, duration_ms: float):
    s = duration_ms / 60000
    for i, (a, b, where) in enumerate(NOTIFS):
        a, b = a * s, b * s
        if a <= t < b:
            slide = 260.0
            u_in = _ease((t - a) / slide)
            u_out = _ease((b - t) / slide)
            u = min(u_in, u_out)
            x = int(round(W + 10 - (NOTE_W + 26) * u))
            return i, (x, 64 if where == "top" else H - NOTE_H - 24)
    return None


def _draw_card(img: Image.Image, x: int, y: int) -> tuple[int, int, int, int]:
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([x, y, x + 470, y + 86], radius=10, fill=T["card"], outline=T["card_line"], width=2)
    d.text((x + 16, y + 12), "Deploy token", font=_font(SANS_B, 16), fill=T["card_text"])
    it = Item(y=y + 44, x=x + 16, parts=[(SECRETS["ghp"], "ghp")], font=MONO, size=17)
    return _draw_item(d, it)[0][1]


def _draw_notif(img: Image.Image, i: int, x: int, y: int) -> tuple[int, int, int, int]:
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([x, y, x + NOTE_W, y + NOTE_H], radius=14, fill=T["note"], outline=T["note_line"], width=1)
    d.ellipse([x + 14, y + 20, x + 50, y + 56], fill=(90, 120, 220))
    d.text((x + 64, y + 12), NOTE_TEXT[i][0], font=_font(SANS_B, 15), fill=T["note_t1"])
    d.text((x + 64, y + 38), NOTE_TEXT[i][1], font=_font(SANS, 15), fill=T["note_t2"])
    return (x, y, NOTE_W, NOTE_H)


def _clip(b, x0, y0, x1, y1):
    bx, by, bw, bh = b
    cx0, cy0, cx1, cy1 = max(bx, x0), max(by, y0), min(bx + bw, x1), min(by + bh, y1)
    if cx1 <= cx0 or cy1 <= cy0:
        return None
    return (cx0, cy0, cx1 - cx0, cy1 - cy0)


def generate(out: Path, duration_ms: int = 60000, fps: int = 30, crf: int = 16, variant: str = "dev") -> dict:
    use_variant(variant)
    out.mkdir(parents=True, exist_ok=True)
    doc, doc_boxes = render_document()
    chrome, chrome_boxes = render_chrome()
    n = int(round(duration_ms * fps / 1000))
    gt = {"variant": variant, "fps": fps, "durationMs": duration_ms, "width": W, "height": H, "secrets": {}, "decoys": DECOYS}
    for k in SECRETS:
        gt["secrets"][k] = {"type": SECRET_TYPE[k], "text": SECRETS[k], "frames": {}}
    for i in range(len(NOTIFS)):
        gt["secrets"][f"notif{i}"] = {"type": "notification", "text": NOTE_TEXT[i][1], "frames": {}}
    ff = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(fps), "-i", "-",
                           "-c:v", "libx264", "-preset", "veryfast", "-crf", str(crf), "-pix_fmt", "yuv420p", str(out / "screen.mp4")],
                          stdin=subprocess.PIPE)
    events: list[dict] = []
    prev_scroll = 0.0
    for f in range(n):
        t = f * 1000 / fps
        sc = int(round(scroll_at(t, duration_ms)))
        frame = chrome.copy()
        view = doc.crop((0, sc, DOC_W, sc + (PY1 - PY0)))
        frame.paste(view, (PX0, PY0))
        vis: dict[str, tuple] = {}
        for k, (bx, by, bw, bh) in doc_boxes.items():
            b = (bx + PX0, by - sc + PY0, bw, bh)
            c = _clip(b, PX0, PY0, PX1, PY1)
            if c and c[3] >= 0.5 * bh:
                vis[k] = c
        for k, b in chrome_boxes.items():
            vis[k] = b
        cp = card_at(t, duration_ms)
        if cp:
            b = _draw_card(frame, *cp)
            # the card covers document text under it
            cx0, cy0, cx1, cy1 = cp[0], cp[1], cp[0] + 470, cp[1] + 86
            for k in list(vis):
                vx, vy, vw, vh = vis[k]
                if k != "akia" and vx < cx1 and vx + vw > cx0 and vy < cy1 and vy + vh > cy0:
                    rest = _visible_outside(vis[k], (cx0, cy0, cx1, cy1))
                    if rest is None:
                        del vis[k]
                    else:
                        vis[k] = rest
            c = _clip(b, 0, 0, W, H)
            if c:
                vis["ghp"] = c
        nt = notif_at(t, duration_ms)
        if nt:
            i, (x, y) = nt
            b = _draw_notif(frame, i, x, y)
            c = _clip(b, 0, 0, W, H)
            if c and c[2] >= 40:
                vis[f"notif{i}"] = c
            for k in list(vis):
                if k.startswith("notif"):
                    continue
                vx, vy, vw, vh = vis[k]
                if vx < x + NOTE_W and vx + vw > x and vy < y + NOTE_H and vy + vh > y:
                    rest = _visible_outside(vis[k], (x, y, x + NOTE_W, y + NOTE_H))
                    if rest is None:
                        del vis[k]
                    else:
                        vis[k] = rest
        for k, b in vis.items():
            gt["secrets"][k]["frames"][str(f)] = list(map(int, b))
        ff.stdin.write(np.asarray(frame, np.uint8).tobytes())
        # event log: the pointer sits over the panel and wheel events drive the scroll
        if f % 2 == 0:
            events.append({"t": round(t, 2), "type": "move", "x": 760 + 40 * math.sin(t / 3000), "y": 420 + 30 * math.cos(t / 2700)})
        if abs(sc - prev_scroll) >= 1:
            events.append({"t": round(t, 2), "type": "scroll", "x": 760, "y": 420, "dx": 0, "dy": sc - prev_scroll})
            prev_scroll = sc
    ff.stdin.close()
    if ff.wait() != 0:
        raise RuntimeError("ffmpeg failed")
    (out / "events.jsonl").write_text("\n".join(json.dumps(e) for e in events) + "\n")
    meta = {"width": W, "height": H, "fps": fps, "durationMs": duration_ms, "pixelRatio": 1}
    (out / "meta.json").write_text(json.dumps(meta))
    (out / "gt.json").write_text(json.dumps(gt))
    return gt


def _visible_outside(b, occ):
    """The part of box b left visible beside an occluder, if it is still a readable chunk."""
    bx, by, bw, bh = b
    ox0, oy0, ox1, oy1 = occ
    # occluder covers full height of the box: keep the larger horizontal remainder
    if oy0 <= by and oy1 >= by + bh:
        left = (bx, by, max(0, ox0 - bx), bh)
        right = (ox1, by, max(0, bx + bw - ox1), bh)
        best = max(left, right, key=lambda r: r[2])
        return best if best[2] >= 24 else None
    if ox0 <= bx and ox1 >= bx + bw:
        top = (bx, by, bw, max(0, oy0 - by))
        bot = (bx, oy1, bw, max(0, by + bh - oy1))
        best = max(top, bot, key=lambda r: r[3])
        return best if best[3] >= 0.5 * bh else None
    return b  # partial corner overlap: keep the whole box (conservative)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--duration-ms", type=int, default=60000)
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--variant", choices=list(VARIANTS), default="dev")
    a = ap.parse_args()
    g = generate(Path(a.out), a.duration_ms, a.fps, variant=a.variant)
    print({k: len(v["frames"]) for k, v in g["secrets"].items()})
