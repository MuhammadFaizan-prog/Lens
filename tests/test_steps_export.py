"""Steps export (demand #7): interactive demo + step guide from one recording.

Everything goes through the real path: `lens export demo|guide` (packages/cli) -> engine
stepsExportInput -> compositor/export_steps.py. Bounds, written before the first measurement
(docs/InteractiveDemo.md, docs/Tracker.md):

- Hotspot: in every exported still, the hotspot (demo.json, image px) sits on the click: the centroid
  of a magenta marker drawn into the recording at the click point (an independent truth: wherever
  crop, layout, scaling or the video's zoom put that source pixel, the marker is there) is within
  HOTSPOT_TOL_PX = 2.0 px on each axis. Two sessions: the whole screen (crop + padding + 16:9 layout of
  a 16:10 recording), and demo.zoom = video with a 1.8x zoom over one click.
- Privacy: with every privacy detection accepted, OCR finds no run of min(6, len) characters of any
  planted secret in any demo still or guide image (0 leaks), both in each secret's own region and in
  the whole image (notification banners: own region only, see the test); the same OCR on the same export with the detections dismissed reads >= 70% of
  the secret regions (control: the check can see text there).
- Guide PDF: pages = steps + 1 (cover + one per step); "Step k of N" appears once for each k; one
  image per step page; each step image (PNG and the image inside the PDF) carries the highlight
  box: >= 90% of the box outline's pixels within 60 (RGB distance) of the brand primary.
- Markdown / HTML: one numbered step heading and one image per step; the HTML is self-contained.
- Demo HTML: self-contained (no http(s) / protocol-relative reference except the CTA link, a CSP
  that forbids network requests).
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "research" / "harness"))
sys.path.insert(0, str(ROOT / "redact"))
sys.path.insert(0, str(ROOT / "compositor"))

LENS = ROOT / "packages" / "cli" / "dist" / "cli.js"
HOTSPOT_TOL_PX = 2.0
BOX_COVER_MIN = 0.90
BOX_COLOUR_DIST = 60.0
CONTROL_READABLE_MIN = 0.70
OUT = ROOT / "out" / "steps-export"

needs_cli = pytest.mark.skipif(shutil.which("node") is None or not LENS.exists(), reason="lens CLI not built (npm run build)")


def lens(*args: str) -> dict:
    r = subprocess.run(["node", str(LENS), *args, "--json"], capture_output=True, text=True, cwd=ROOT)
    out = json.loads(r.stdout.strip().splitlines()[-1])
    assert r.returncode == 0 and out["ok"], (r.returncode, out, r.stderr[-2000:])
    return out["result"]


def magenta_centroid(img: np.ndarray) -> tuple[float, float, int]:
    b, g, r = (img[..., i].astype(np.int32) for i in range(3))
    m = (r > 170) & (b > 170) & (g < 110)
    n, lab, stats, cents = cv2.connectedComponentsWithStats(m.astype(np.uint8), 8)
    if n <= 1:
        return float("nan"), float("nan"), 0
    k = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    ys, xs = np.nonzero(lab == k)
    # weight by how magenta each pixel is (anti-aliased edge pixels count less)
    w = ((r + b) / 2 - g)[ys, xs].astype(np.float64)
    return float((xs * w).sum() / w.sum()), float((ys * w).sum() / w.sum()), int(len(xs))


# ------------------------------------------------------------------ unit


def test_label_redaction_hides_secrets_in_text():
    from lens_compositor.stepsexport import redact_text

    s = redact_text("Click jane.doe@example.org")
    assert "jane" not in s and "example" not in s and "•••" in s
    assert redact_text("Click Save") == "Click Save"
    k = redact_text("Copy sk-proj-Q7f3kD9mX2pL8vR4tY6wZ1aB")
    assert "Q7f3kD9mX2" not in k


def test_affine_matches_renderer_formula():
    from lens_compositor.stepsexport import frame_affine

    plan = {"source": {"crop": [40, 30, 1200, 744]}}
    f = {"layout": {"screen": [71.6, 43.2, 1136.8, 704.8]}, "cam": [600, 372, 1.0]}
    A = frame_affine(plan, f)
    # the crop's top-left source pixel lands on the screen rect's (rounded) top-left
    assert A.map(40, 30) == pytest.approx((72, 43))
    # and the far corner on the far edge
    assert A.map(1240, 774) == pytest.approx((72 + 1137, 43 + 705))


# ------------------------------------------------------------------ hotspot


@pytest.fixture(scope="module")
def marker_sessions(tmp_path_factory):
    from lensharness.demo_synth import generate

    out = {}
    for name, zoom in (("whole", False), ("zoomed", True)):
        d = tmp_path_factory.mktemp(f"steps-{name}")
        generate(d, zoom=zoom)
        res = lens("export", "demo", "-C", str(d))
        out[name] = (d, res)
    return out


@needs_cli
def test_hotspot_sits_on_the_click(marker_sessions):
    report, worst = {}, 0.0
    for name, (d, res) in marker_sessions.items():
        demo = Path(res["out"])
        data = json.loads((demo / "demo.json").read_text())
        assert len(data["steps"]) == 6
        rows = []
        for s in data["steps"]:
            img = cv2.imread(str(demo / s["image"]))
            assert img.shape[1] == s["width"] and img.shape[0] == s["height"]
            mx, my, npx = magenta_centroid(img)
            assert npx >= 20, f"{name} step {s['n']}: marker not found in the still"
            dx, dy = s["hotspot"]["x"] - mx, s["hotspot"]["y"] - my
            worst = max(worst, abs(dx), abs(dy))
            rows.append({"n": s["n"], "hotspot": [s["hotspot"]["x"], s["hotspot"]["y"]], "marker": [round(mx, 2), round(my, 2)],
                         "dx": round(dx, 3), "dy": round(dy, 3)})
            assert abs(dx) <= HOTSPOT_TOL_PX and abs(dy) <= HOTSPOT_TOL_PX, (name, rows[-1])
            # the fraction the page uses to place it in the responsive layout (pixel centre -> CSS edge)
            assert s["hotspot"]["fx"] == pytest.approx((s["hotspot"]["x"] + 0.5) / s["width"], abs=1e-5)
        report[name] = rows
    if "zoomed" in marker_sessions:  # the zoom really was applied to step 3's still
        d, res = marker_sessions["zoomed"]
        z = json.loads((Path(res["out"]) / "demo.json").read_text())["steps"][2]["map"]
        w = json.loads((Path(marker_sessions["whole"][1]["out"]) / "demo.json").read_text())["steps"][2]["map"]
        assert z[1] > 1.6 * w[1]
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "hotspot-report.json").write_text(json.dumps({"worstAxisErrorPx": round(worst, 3), "bound": HOTSPOT_TOL_PX, "sessions": report}, indent=1))
    print(f"\n[hotspot] worst axis error {worst:.3f} px over {sum(len(v) for v in report.values())} stills (bound {HOTSPOT_TOL_PX})")


@needs_cli
def test_demo_html_is_self_contained(marker_sessions):
    d, res = marker_sessions["whole"]
    html = (Path(res["out"]) / "index.html").read_text()
    assert "Content-Security-Policy" in html and "default-src 'none'" in html
    refs = re.findall(r"""(?:src|href)\s*=\s*["']([^"']+)["']|url\(\s*["']?([^)"']+)""", html)
    ext = [a or b for a, b in refs if re.match(r"^(https?:)?//", a or b)]
    assert ext == ["https://example.com/start"], ext  # only the CTA link
    data = json.loads(re.search(r'<script type="application/json" id="lens-demo-data">(.*?)</script>', html, re.S).group(1))
    assert data["cta"]["url"] == "https://example.com/start" and len(data["steps"]) == 6
    imgs = json.loads(re.search(r'<script type="application/json" id="lens-demo-images">(.*?)</script>', html, re.S).group(1))
    assert len(imgs) == 6 and all(u.startswith("data:image/jpeg;base64,") for u in imgs)


# ------------------------------------------------------------------ guide


def _box_cover(rgb: np.ndarray, box: list[float], stroke: int, colour: tuple[int, int, int]) -> float:
    x0, y0, x1, y1 = (int(round(v)) for v in box)
    h, w = rgb.shape[:2]
    pts = []
    for x in range(x0 + stroke, x1 - stroke, 2):
        pts += [(x, y0), (x, y1)]
    for y in range(y0 + stroke, y1 - stroke, 2):
        pts += [(x0, y), (x1, y)]
    hit = 0
    for x, y in pts:
        # the stroke is centred on the rect edge; look across it (+-stroke) for the box colour
        ok = False
        for o in range(-stroke, stroke + 1):
            xx, yy = (x, min(h - 1, max(0, y + o))) if y in (y0, y1) else (min(w - 1, max(0, x + o)), y)
            if np.linalg.norm(rgb[yy, xx].astype(float) - colour) <= BOX_COLOUR_DIST:
                ok = True
                break
        hit += ok
    return hit / max(1, len(pts))


@needs_cli
@pytest.mark.skipif(shutil.which("pdfinfo") is None, reason="needs poppler-utils (pdfinfo, pdftotext, pdfimages)")
def test_guide_pdf_markdown_html(marker_sessions, tmp_path):
    d, _ = marker_sessions["whole"]
    res = lens("export", "guide", "-C", str(d))
    g = Path(res["out"])
    info = json.loads((g / "guide.json").read_text())
    n = len(info["steps"])
    assert n == 6 and res["guide"]["pages"] == n + 1
    primary = (0xE8, 0x13, 0x2A)
    pages = int(re.search(r"Pages:\s+(\d+)", subprocess.run(["pdfinfo", str(g / "guide.pdf")], capture_output=True, text=True).stdout).group(1))
    assert pages == n + 1
    text = subprocess.run(["pdftotext", "-layout", str(g / "guide.pdf"), "-"], capture_output=True, text=True).stdout
    for k in range(1, n + 1):
        assert text.count(f"Step {k} of {n}") == 1, k
    for s in info["steps"]:
        assert s["label"] in text
    # images inside the PDF: one per step page, each with the highlight box
    subprocess.run(["pdfimages", "-png", str(g / "guide.pdf"), str(tmp_path / "pi")], check=True)
    pdf_imgs = sorted(tmp_path.glob("pi-*.png"))
    assert len(pdf_imgs) == n
    covers = []
    for s, p in zip(info["steps"], pdf_imgs):
        png = cv2.cvtColor(cv2.imread(str(g / s["image"])), cv2.COLOR_BGR2RGB)
        emb = cv2.cvtColor(cv2.imread(str(p)), cv2.COLOR_BGR2RGB)
        assert emb.shape == png.shape and int(np.abs(emb.astype(int) - png).max()) == 0  # lossless in the PDF
        c = _box_cover(png, s["box"], s["stroke"], primary)
        covers.append(round(c, 3))
        assert c >= BOX_COVER_MIN, (s["n"], c)
        # control: the same check on a box-sized rect elsewhere does not find the colour
        bx = [4, 4, 4 + s["box"][2] - s["box"][0], 4 + s["box"][3] - s["box"][1]]
        if bx[2] < s["box"][0] or bx[3] < s["box"][1]:
            assert _box_cover(png, bx, s["stroke"], primary) < 0.2
    md = (g / "guide.md").read_text()
    assert len(re.findall(r"^## Step \d+ of 6: ", md, re.M)) == n
    for s in info["steps"]:
        assert f"]({s['image']})" in md and (g / s["image"]).exists()
    html = (g / "guide.html").read_text()
    assert html.count('class="lg-step"') == n and html.count("data:image/png;base64,") >= n
    assert not re.search(r"""(?:src)\s*=\s*["'](https?:)?//""", html)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "guide-report.json").write_text(json.dumps({"pages": pages, "steps": n, "boxCover": covers}, indent=1))
    print(f"\n[guide] {pages} pages, {n} steps, box outline cover {covers}")


# ------------------------------------------------------------------ privacy


@pytest.fixture(scope="module")
def privacy_session(tmp_path_factory):
    from lens_redact.ocr import tesseract_available

    if not tesseract_available():
        pytest.skip("tesseract not installed")
    from lensharness.privacy_synth import generate

    d = tmp_path_factory.mktemp("steps-privacy")
    gt = generate(d, duration_ms=30000, variant="fresh")
    fps = gt["fps"]
    # six steps, each clicked on a planted secret visible at that moment (the guide crops centre on it)
    keys = [k for k, v in gt["secrets"].items() if v["text"]]
    drafts, used = [], set()
    for i, t in enumerate([2500, 7000, 11500, 16000, 21000, 26500]):
        f = str(int(round((t - 80) * fps / 1000)))
        vis = [k for k in keys if f in gt["secrets"][k]["frames"] and k not in used] or [k for k in keys if f in gt["secrets"][k]["frames"]]
        if vis:
            k = vis[0]
            used.add(k)
            x, y, w, h = gt["secrets"][k]["frames"][f]
            cx, cy = x + w / 2, y + h / 2
        else:
            cx, cy = 760, 420
        drafts.append({"id": f"st{i + 1}", "clickMs": t, "x": cx, "y": cy, "label": f"Click item {i + 1}", "target": "", "verb": "Click",
                       "confidence": 0.5, "state": "accepted"})
    project = {"output": {"aspect": "16:9", "resolution": 720, "fps": 30}, "stepLabels": {"drafts": drafts, "generatedAt": None},
               "demo": {"title": "Console tour", "cta": {"enabled": True, "title": "Done", "text": "", "buttonLabel": "Open", "url": "https://example.com"}}}
    (d / "project.json").write_text(json.dumps(project))
    lens("privacy", "scan", "-C", str(d))
    acc = lens("privacy", "accept", "-C", str(d))
    exports = {}
    for kind in ("demo", "guide"):
        exports[kind] = Path(lens("export", kind, "-C", str(d), "--out", str(d / f"masked-{kind}"))["out"])
    # control: same export with every detection dismissed
    lens("privacy", "dismiss", "-C", str(d))
    for kind in ("demo", "guide"):
        exports["open-" + kind] = Path(lens("export", kind, "-C", str(d), "--out", str(d / f"open-{kind}"))["out"])
    lens("privacy", "accept", "-C", str(d))
    return d, gt, exports, acc


def _images(exports: dict, which: str) -> list[tuple[str, Path, list[float], float]]:
    """(name, file, source->image map, still source ms) for every demo still and guide image."""
    demo = json.loads((exports[f"{which}demo"] / "demo.json").read_text())
    guide = json.loads((exports[f"{which}guide"] / "guide.json").read_text())
    out = [(f"demo-{s['n']}", exports[f"{which}demo"] / s["image"], s["map"], s["stillMs"]) for s in demo["steps"]]
    out += [(f"guide-{s['n']}", exports[f"{which}guide"] / s["image"], s["map"], demo["steps"][i]["stillMs"]) for i, s in enumerate(guide["steps"])]
    return out


def _regions(gt: dict, images, secrets):
    from lensharness.leakcheck import prep_crop

    crops, keys = [], []
    for name, f, (ax, kx, ay, ky), still_ms in images:
        img = cv2.imread(str(f))
        fr = str(int(round(still_ms * gt["fps"] / 1000)))
        for k, s in secrets.items():
            b = s["frames"].get(fr)
            if not b:
                continue
            x0, y0 = ax + kx * b[0], ay + ky * b[1]
            c = prep_crop(img, (x0, y0, kx * b[2], ky * b[3]))
            if c is not None:
                crops.append(c)
                keys.append((name, k))
    return crops, keys


@needs_cli
def test_no_secret_readable_in_demo_or_guide(privacy_session):
    from lensharness.leakcheck import leaks, ocr_crops
    from lens_redact.ocr import ocr_images

    d, gt, exports, acc = privacy_session
    secrets = {k: v for k, v in gt["secrets"].items() if v["text"]}
    masked = _images({"demo": exports["demo"], "guide": exports["guide"]}, "")
    opened = _images({"open-demo": exports["open-demo"], "open-guide": exports["open-guide"]}, "open-")
    assert len(masked) == 12
    # 1. each visible secret's own region, masked export
    crops, keys = _regions(gt, masked, secrets)
    leaked = [(n, k) for (n, k), t in zip(keys, ocr_crops(crops)) if leaks(t, secrets[k]["text"])]
    # 2. the whole of every image (2x), any secret anywhere. Notification banners are checked in their
    # own region only (step 1): their body is an ordinary sentence ("Your invoice is ready") whose
    # words also occur in normal page text ("invoices are issued..." shares the 7-letter run).
    whole = ocr_images([cv2.cvtColor(cv2.imread(str(f)), cv2.COLOR_BGR2GRAY) for _, f, _, _ in masked], psm=11, workers=2, scale=2.0)
    for (name, *_), words in zip(masked, whole):
        txt = " ".join(w.text for w in words)
        leaked += [(name, k) for k, s in secrets.items() if s["type"] != "notification" and leaks(txt, s["text"])]
    # 3. control: the same regions in the export without masks are readable
    ccrops, ckeys = _regions(gt, opened, secrets)
    readable = sum(leaks(t, secrets[k]["text"]) for (n, k), t in zip(ckeys, ocr_crops(ccrops)))
    control = readable / max(1, len(ckeys))
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "leak-report.json").write_text(json.dumps({"images": len(masked), "secretRegions": len(keys), "leaks": leaked,
                                                      "controlReadable": round(control, 3), "controlRegions": len(ckeys)}, indent=1))
    print(f"\n[leak] {len(masked)} images, {len(keys)} secret regions + whole-image OCR: {len(leaked)} leaks; control read {readable}/{len(ckeys)} ({control:.2f})")
    assert len(keys) >= 6, "the test must check secrets in the stills"
    assert control >= CONTROL_READABLE_MIN
    assert not leaked, leaked
