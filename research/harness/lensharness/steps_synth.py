"""Synthetic click-through sessions with known control texts, for the auto step-label test (demand #4).

A fake web app (top menu row, left sidebar, page content with buttons and a search field) is drawn
with PIL and recorded cursorless at 1280x720 / 30 fps, with an events.jsonl of moves and clicks.
Ground truth (gt.json) lists every click with the label a person would write by Lens's convention:
"Open <item>" for navigation (sidebar items, top menu items, tabs) and "Click <text>" for buttons,
links and fields. All UI text, layout and art are made up here.

Variants:
  dev      light theme, DejaVu Sans; the step labeller's rules and constants were set looking at it
  heldout  dark theme, Liberation Sans (SIL OFL), other words, sizes, positions and button styles;
           written at the same time as dev and measured once
"""
from __future__ import annotations

import json
import math
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

W, H, FPS = 1280, 720, 30


@dataclass
class Theme:
    bg: tuple
    panel: tuple
    side: tuple
    side_text: tuple
    side_active: tuple
    text: tuple
    muted: tuple
    accent: tuple
    accent_text: tuple
    border: tuple
    font: str
    font_bold: str
    size: int


THEMES = {
    "dev": Theme(bg=(246, 247, 249), panel=(255, 255, 255), side=(236, 238, 242), side_text=(40, 44, 52), side_active=(214, 224, 250),
                 text=(30, 33, 40), muted=(120, 126, 136), accent=(37, 99, 235), accent_text=(255, 255, 255), border=(205, 210, 218),
                 font="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", font_bold="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", size=16),
    "heldout": Theme(bg=(24, 26, 32), panel=(33, 36, 44), side=(18, 20, 25), side_text=(200, 205, 214), side_active=(52, 58, 72),
                     text=(230, 232, 236), muted=(140, 146, 158), accent=(16, 163, 127), accent_text=(255, 255, 255), border=(70, 76, 90),
                     font="/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
                     font_bold="/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf", size=15),
}

# Pages: buttons as (text, style) with style filled | outline | ghost, plus a search field placeholder.
VARIANTS = {
    "dev": {
        "menu": ["File", "Edit", "View", "Help"],
        "side": ["Dashboard", "Projects", "Reports", "Settings", "Billing"],
        "pages": {
            "Dashboard": {"buttons": [("New project", "filled"), ("Import data", "outline"), ("Share", "ghost")], "field": "Search"},
            "Projects": {"buttons": [("Create", "filled"), ("Archive", "outline"), ("Export CSV", "outline")], "field": "Find a project"},
            "Reports": {"buttons": [("Run report", "filled"), ("Schedule", "outline")], "field": None},
            "Settings": {"buttons": [("Save changes", "filled"), ("Cancel", "ghost"), ("Reset password", "outline")], "field": "Display name"},
            "Billing": {"buttons": [("Upgrade plan", "filled"), ("Download invoice", "outline")], "field": None},
        },
        "start": "Dashboard",
        "layout": {"side_w": 200, "menu_h": 34, "row_h": 40, "btn_y": 120, "btn_x": 240, "field_y": 190},
        "steps": [("side", "Projects"), ("btn", "Create"), ("btn", "Export CSV"), ("side", "Settings"), ("btn", "Reset password"),
                  ("btn", "Save changes"), ("side", "Billing"), ("btn", "Upgrade plan"), ("btn", "Download invoice"), ("menu", "View"),
                  ("side", "Dashboard"), ("field", "Search"), ("btn", "New project"), ("btn", "Share")],
    },
    "heldout": {
        "menu": ["Workspace", "Insert", "Format", "Window"],
        "side": ["Home", "Inbox", "Team", "Integrations", "Analytics", "Archive"],
        "pages": {
            "Home": {"buttons": [("Publish", "filled"), ("Preview", "outline"), ("Duplicate", "ghost")], "field": "Filter"},
            "Inbox": {"buttons": [("Compose", "filled"), ("Mark all read", "ghost"), ("Send", "outline")], "field": "Search mail"},
            "Team": {"buttons": [("Invite member", "filled"), ("Remove", "outline"), ("Change role", "outline")], "field": None},
            "Integrations": {"buttons": [("Connect Slack", "filled"), ("Disconnect", "outline"), ("Add webhook", "ghost")], "field": None},
            "Analytics": {"buttons": [("Last 30 days", "outline"), ("Download report", "filled")], "field": "Metric"},
            "Archive": {"buttons": [("Restore", "filled"), ("Delete forever", "outline")], "field": None},
        },
        "start": "Home",
        "layout": {"side_w": 232, "menu_h": 40, "row_h": 44, "btn_y": 150, "btn_x": 280, "field_y": 230},
        "steps": [("side", "Inbox"), ("btn", "Compose"), ("btn", "Send"), ("side", "Team"), ("btn", "Invite member"), ("btn", "Remove"),
                  ("side", "Integrations"), ("btn", "Connect Slack"), ("btn", "Disconnect"), ("menu", "Insert"), ("side", "Analytics"),
                  ("btn", "Last 30 days"), ("btn", "Download report"), ("side", "Home"), ("field", "Filter"), ("btn", "Publish")],
    },
}


@dataclass
class Widget:
    kind: str
    text: str
    box: tuple  # x0, y0, x1, y1
    style: str = "filled"


@dataclass
class Page:
    name: str
    widgets: list = field(default_factory=list)


def _font(path: str, size: int):
    return ImageFont.truetype(path, size)


def layout_page(v: dict, th: Theme, page: str) -> list[Widget]:
    L = v["layout"]
    f = _font(th.font, th.size)
    fb = _font(th.font_bold, th.size)
    ws: list[Widget] = []
    x = 16
    for m in v["menu"]:
        tw = f.getlength(m)
        ws.append(Widget("menu", m, (x, 0, x + tw + 24, L["menu_h"])))
        x += tw + 24 + 6
    y = L["menu_h"] + 24
    for s in v["side"]:
        ws.append(Widget("side", s, (12, y, L["side_w"] - 12, y + L["row_h"] - 6)))
        y += L["row_h"]
    x = L["btn_x"]
    for text, style in v["pages"][page]["buttons"]:
        tw = (fb if style == "filled" else f).getlength(text)
        ws.append(Widget("btn", text, (x, L["btn_y"], x + tw + 36, L["btn_y"] + 38), style))
        x += tw + 36 + 18
    fld = v["pages"][page]["field"]
    if fld:
        ws.append(Widget("field", fld, (L["btn_x"], L["field_y"], L["btn_x"] + 360, L["field_y"] + 38)))
    return ws


def draw_page(v: dict, th: Theme, page: str, pressed: str | None = None, menu_open: str | None = None) -> np.ndarray:
    L = v["layout"]
    img = Image.new("RGB", (W, H), th.bg)
    d = ImageDraw.Draw(img)
    f = _font(th.font, th.size)
    fb = _font(th.font_bold, th.size)
    fh = _font(th.font_bold, th.size + 8)
    d.rectangle((0, 0, W, L["menu_h"]), fill=th.panel)
    d.line((0, L["menu_h"], W, L["menu_h"]), fill=th.border)
    d.rectangle((0, L["menu_h"] + 1, L["side_w"], H), fill=th.side)
    ws = layout_page(v, th, page)

    def centre_text(box, text, font, fill):
        x0, y0, x1, y1 = box
        tb = d.textbbox((0, 0), text, font=font)
        d.text(((x0 + x1) / 2 - (tb[2] - tb[0]) / 2 - tb[0], (y0 + y1) / 2 - (tb[3] - tb[1]) / 2 - tb[1]), text, font=font, fill=fill)

    for w in ws:
        dark = 0.82 if w.text == pressed else 1.0
        if w.kind == "menu":
            if w.text == menu_open or w.text == pressed:
                d.rectangle(w.box, fill=th.side_active)
            centre_text(w.box, w.text, f, th.text)
        elif w.kind == "side":
            if w.text == page:
                d.rounded_rectangle(w.box, 7, fill=th.side_active)
            x0, y0, x1, y1 = w.box
            d.ellipse((x0 + 10, (y0 + y1) / 2 - 5, x0 + 20, (y0 + y1) / 2 + 5), fill=th.muted)
            tb = d.textbbox((0, 0), w.text, font=f)
            d.text((x0 + 32, (y0 + y1) / 2 - (tb[3] - tb[1]) / 2 - tb[1]), w.text, font=f, fill=th.side_text)
        elif w.kind == "btn":
            if w.style == "filled":
                col = tuple(int(c * dark) for c in th.accent)
                d.rounded_rectangle(w.box, 8, fill=col)
                centre_text(w.box, w.text, fb, th.accent_text)
            elif w.style == "outline":
                d.rounded_rectangle(w.box, 8, fill=tuple(int(c * dark) for c in th.panel), outline=th.border, width=1)
                centre_text(w.box, w.text, f, th.text)
            else:
                centre_text(w.box, w.text, f, th.accent)
        elif w.kind == "field":
            d.rounded_rectangle(w.box, 6, fill=th.panel, outline=th.border, width=1)
            x0, y0, x1, y1 = w.box
            tb = d.textbbox((0, 0), w.text, font=f)
            d.text((x0 + 12, (y0 + y1) / 2 - (tb[3] - tb[1]) / 2 - tb[1]), w.text, font=f, fill=th.muted)
    # page heading and filler content (decoy text further from the controls)
    d.text((L["btn_x"], L["menu_h"] + 26), page, font=fh, fill=th.text)
    rng = np.random.default_rng(len(page) * 31 + L["btn_x"])
    for r in range(5):
        y = L["field_y"] + 90 + r * 70
        d.rounded_rectangle((L["btn_x"], y, W - 60, y + 56), 8, fill=th.panel, outline=th.border)
        d.text((L["btn_x"] + 16, y + 9), f"{page} item {r + 1}", font=fb, fill=th.text)
        d.rectangle((L["btn_x"] + 16, y + 34, L["btn_x"] + 16 + int(rng.uniform(120, 420)), y + 40), fill=th.border)
    if menu_open:
        mw = next(w for w in ws if w.kind == "menu" and w.text == menu_open)
        x0 = mw.box[0]
        d.rectangle((x0, L["menu_h"], x0 + 180, L["menu_h"] + 120), fill=th.panel, outline=th.border)
        for i, item in enumerate(["New", "Open recent", "Close"]):
            d.text((x0 + 14, L["menu_h"] + 12 + i * 34), item, font=f, fill=th.text)
    return np.asarray(img)[:, :, ::-1].copy()


def _ease(u: float) -> float:
    return 2 * u * u if u < 0.5 else 1 - (-2 * u + 2) ** 2 / 2


def generate(out: str | Path, variant: str = "dev", max_steps: int | None = None) -> dict:
    """Write screen.mp4, meta.json, events.jsonl and gt.json; returns the ground truth.
    max_steps keeps only the first n steps (the editor's short sample)."""
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    v = dict(VARIANTS[variant])
    if max_steps is not None:
        v["steps"] = v["steps"][:max_steps]
    th = THEMES[variant]
    page = v["start"]
    events: list[dict] = []
    timeline: list[tuple[float, str, str | None, str | None]] = []  # (t, page, pressed, menu_open) state changes
    gt = []
    cur = (W * 0.6, H * 0.6)
    t = 600.0
    timeline.append((0.0, page, None, None))
    for kind, text in v["steps"]:
        ws = layout_page(v, th, page)
        w = next(x for x in ws if x.kind == kind and x.text == text)
        x0, y0, x1, y1 = w.box
        # click near the control's text centre (fields: left part where the placeholder is)
        tx = x0 + 60 if kind == "field" else (x0 + 50 if kind == "side" else (x0 + x1) / 2)
        ty = (y0 + y1) / 2
        dur = 520.0
        n = int(dur / 16)
        for i in range(n + 1):
            u = _ease(i / n)
            events.append({"t": round(t + i * 16, 1), "type": "move", "x": round(cur[0] + (tx - cur[0]) * u, 1), "y": round(cur[1] + (ty - cur[1]) * u, 1)})
        t += dur + 140
        events.append({"t": round(t, 1), "type": "down", "x": tx, "y": ty, "button": "left"})
        events.append({"t": round(t + 90, 1), "type": "up", "x": tx, "y": ty, "button": "left"})
        gt.append({"clickMs": round(t, 1), "x": tx, "y": ty, "label": f"{'Open' if kind in ('side', 'menu') else 'Click'} {text}", "kind": kind, "text": text})
        timeline.append((t, page, text, None))
        if kind == "side":
            page = text
            timeline.append((t + 150, page, None, None))
        elif kind == "menu":
            timeline.append((t + 150, page, None, text))
            timeline.append((t + 1100, page, None, None))
        else:
            timeline.append((t + 140, page, None, None))
        if kind == "field":
            for j, ch in enumerate("lens"):
                events.append({"t": round(t + 300 + j * 110, 1), "type": "key", "key": ch, "modifiers": []})
        cur = (tx, ty)
        t += 1300
    dur_ms = int(t + 600)
    timeline.sort(key=lambda s: s[0])
    nframes = int(round(dur_ms * FPS / 1000))
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                            "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-pix_fmt", "yuv420p", str(out / "screen.mp4")], stdin=subprocess.PIPE)
    assert enc.stdin
    cache: dict = {}
    k = 0
    for fi in range(nframes):
        tf = fi * 1000 / FPS
        while k + 1 < len(timeline) and timeline[k + 1][0] <= tf:
            k += 1
        key = timeline[k][1:]
        if key not in cache:
            cache[key] = draw_page(v, th, *key)
        enc.stdin.write(cache[key].tobytes())
    enc.stdin.close()
    enc.wait()
    events.sort(key=lambda e: e["t"])
    (out / "events.jsonl").write_text("\n".join(json.dumps(e) for e in events) + "\n")
    (out / "meta.json").write_text(json.dumps({"width": W, "height": H, "fps": FPS, "durationMs": dur_ms, "pixelRatio": 1}))
    truth = {"variant": variant, "steps": gt}
    (out / "gt.json").write_text(json.dumps(truth, indent=1))
    return truth


if __name__ == "__main__":
    import sys
    generate(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "dev")
