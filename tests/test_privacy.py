"""Automatic privacy redaction (demand #3): classifiers, detection on a synthetic screen session,
and what is left readable in the rendered export.

The session (research/harness/lensharness/privacy_synth.py) is a fake console with planted fake
secrets that scroll, move on a card, sit under a moving card for a while, and notification banners
that slide in; plus decoy text that must not be flagged (normal words, short numbers, hex colours,
versions, dates, prices, a non-Luhn 16-digit number, a short git sha, paths, camelCase).
The scanner's constants were tuned on the "dev" variant. The "heldout" variant (dark theme, other
secrets, decoys, sizes and motion) was written at the same time; its first measurement failed the
frame-recall bound (0.942) and showed two bugs, which were fixed, so its numbers are optimistic now.
The "fresh" variant (light theme, other secrets, sizes and motion; same wording as heldout) was
written after that and is the one measurement made on unseen data; the export leak check runs on it.

Bounds, fixed before the first held-out measurement (docs/Privacy.md, docs/Tracker.md):
- instance recall (planted secrets + banners found at all) >= 0.95
- frame recall ((secret, visible frame) pairs whose visible box is >= 95% under a mask) >= 0.95
- false positives (detections that overlap no planted secret) <= 1 per minute
- rendered export with every detection accepted: OCR of each secret's region finds no run of
  min(6, len) characters of the secret on any frame where it is visible -> 0 leaked frames; the
  same OCR reads the secret on >= 70% of sampled source frames (control: the check can see text)
- the scan file never contains a secret's text
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "redact"))
sys.path.insert(0, str(ROOT / "research" / "harness"))
sys.path.insert(0, str(ROOT / "compositor"))
sys.path.insert(0, str(ROOT / "tests"))

from lens_redact.classify import (  # noqa: E402
    card_like, classify_text, find_line, find_token, is_high_entropy_token, luhn_ok, mask_preview, shannon_entropy,
)
from lens_redact.evaluate import evaluate  # noqa: E402
from lens_redact.ocr import tesseract_available  # noqa: E402

BOUNDS = {"instance_recall": 0.95, "frame_recall": 0.95, "fp_per_min": 1.0, "leaked_frames": 0, "control_readable": 0.70}
OUT = ROOT / "out" / "privacy"

needs_ocr = pytest.mark.skipif(not tesseract_available(), reason="tesseract not installed")


# ------------------------------------------------------------------ classifiers


def types(text: str) -> list[str]:
    return sorted(f.type for f in classify_text(text))


def test_luhn_true_and_false():
    for good in ["4242424242424242", "5555555555554444", "378282246310005", "6011000990139424", "4000056655665556", "79927398713"]:
        assert luhn_ok(good), good
    for bad in ["4242424242424241", "1234567890123456", "4111222233334444", "79927398710", "", "12a4"]:
        assert not luhn_ok(bad), bad
    assert card_like("4242424242424242")
    assert not card_like("1234567890123452")  # Luhn-valid (check digit 2) but no issuer prefix
    assert luhn_ok("1234567890123452")
    assert not card_like("0000000000000000")  # Luhn-valid, one repeated digit


def test_entropy():
    assert shannon_entropy("") == 0
    assert shannon_entropy("aaaaaaaa") == 0
    assert abs(shannon_entropy("abcd") - 2.0) < 1e-9
    assert is_high_entropy_token("Q2x9vR7mT4kZ8pL1wN6sB3cY5")
    assert is_high_entropy_token("a3F9kL2mQ8xR7vT1nB6yW4zC5")
    assert not is_high_entropy_token("internationalization")       # letters only
    assert not is_high_entropy_token("useEffectCallbackHandler")    # no digits
    assert not is_high_entropy_token("abc123")                      # too short
    assert not is_high_entropy_token("2309c66a1b2c3d4e5f60718")       # hex shorter than 40 (a sha prefix)
    assert not is_high_entropy_token("aaaaaaaaaa1111111111bbbb")    # low entropy


@pytest.mark.parametrize("text,kind", [
    ("contact jane.doe@acme-corp.com today", "email"),
    ("billing@northwind.io", "email"),
    ("call +1 (415) 555-0132", "phone"),
    ("+44 20 7946 0958", "phone"),
    ("(212) 555-0199", "phone"),
    ("card 4242 4242 4242 4242", "card"),
    ("3782 822463 10005", "card"),
    ("5555-5555-5555-4444", "card"),
    ("key sk-proj-4fT9xQ2LmZ8vB1nR7kW3yH6cJ0pD", "api_key"),
    ("sk-ant-api03-Zq7Rr2Vb9Xk1Lm4Np8Tc3Wd6", "api_key"),
    ("sk_live_51HxQ2LmZ8vB1nR7kW3yH6c", "api_key"),
    ("ghp_8Kd2mQ7xL4vN9pR1sT6wY3zB5cF0hJ2aE7gU", "api_key"),
    ("AKIAIOSFODNN7EXAMPLE", "api_key"),
    ("xoxb-2048-1357-AbCdEfGhIjKl", "api_key"),
    ("glpat" + "-x7Kp2RqT9mWz4LsV8nYb", "api_key"),
    ("AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q", "api_key"),
    ("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1rwW1gFWFOEjXk", "jwt"),
    ("token=Q2x9vR7mT4kZ8pL1wN6sB3cY5", "token"),
    ("gateway 192.168.14.207 port 8443", "ip"),
    ("10.0.0.1", "ip"),
])
def test_classifier_true_cases(text, kind):
    assert kind in types(text), (text, classify_text(text))


@pytest.mark.parametrize("text", [
    "Billing overview", "Order #4521 shipped in 3 days", "Theme colour #1a2b3c, accent #FF8800",
    "Version 2.14.3", "v1.2.3.4", "Updated 2026-11-09 at 10:45", "Total $1,299.00", "Reference 1234 5678 9012 3456",
    "Commit 2309c66 on main", "src/components/AppHeader.tsx", "internationalization settings",
    "useEffectCallback(handler)", "ZIP 94107, Room 12B", "Invoice 0042-17", "Qty 3 x 250 ml",
    "Meeting at 14:30 on 2026-12-01", "Extension 214", "Port 8080 and 443", "999.999.999.999",
    "sk-short", "AKIA1234", "eyJ", "user@", "@handle", "1234567890",
])
def test_classifier_false_cases(text):
    assert types(text) == [], (text, classify_text(text))


def test_glued_token_and_line_views():
    assert [f.type for f in find_token("ghp_8Kd2mQ7xL4vN9pR1sT6wY3zB5cF0hJ2aE7gU")] == ["api_key"]
    assert find_token("internationalization") == []
    assert [f.type for f in find_line("+1 (415) 555-0132 and jane@x.io")] == ["email", "phone"]


def test_preview_never_contains_the_secret():
    for s, t in [("jane.doe@acme-corp.com", "email"), ("4242 4242 4242 4242", "card"), ("+1 (415) 555-0132", "phone"),
                 ("sk-proj-4fT9xQ2LmZ8vB1nR7kW3yH6cJ0pD", "api_key"), ("192.168.14.207", "ip"), ("Q2x9vR7mT4kZ8pL1wN6sB3cY5", "token")]:
        p = mask_preview(s, t)
        assert "•" in p
        assert s not in p and s.replace(" ", "") not in p.replace(" ", "")


# ------------------------------------------------------------------ the synthetic session


def _scan(variant: str, tmp_path_factory) -> tuple[Path, dict, dict]:
    from lensharness.privacy_synth import generate
    from lens_redact.scan import scan

    d = tmp_path_factory.mktemp(f"privacy-{variant}")
    gt = generate(d, variant=variant)
    res = scan(str(d / "screen.mp4"), str(d / "events.jsonl"), thumbs_dir=str(d / "thumbs"))
    (d / "privacy.json").write_text(json.dumps(res))
    return d, gt, res


@pytest.fixture(scope="module")
def heldout(tmp_path_factory):
    if not tesseract_available():
        pytest.skip("tesseract not installed")
    return _scan("heldout", tmp_path_factory)


@pytest.fixture(scope="module")
def fresh(tmp_path_factory):
    if not tesseract_available():
        pytest.skip("tesseract not installed")
    return _scan("fresh", tmp_path_factory)


@pytest.fixture(scope="module")
def dev(tmp_path_factory):
    if not tesseract_available():
        pytest.skip("tesseract not installed")
    return _scan("dev", tmp_path_factory)


def _report(name: str, ev: dict, res: dict) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{name}-metrics.json").write_text(json.dumps({"eval": ev, "stats": res["stats"]}, indent=1))
    print(f"\n[{name}] instance recall {ev['instanceRecall']:.3f}, frame recall {ev['frameRecall']:.4f}, "
          f"FP {ev['falsePositives']} ({ev['falsePositivesPerMinute']:.2f}/min), scan {res['stats']['secondsPerMinute']} s per minute")


def _check(ev: dict) -> None:
    assert ev["instanceRecall"] >= BOUNDS["instance_recall"], ev["perSecret"]
    assert ev["frameRecall"] >= BOUNDS["frame_recall"], {k: (v["coveredFrames"], v["visibleFrames"], v["missedFrames"][:6]) for k, v in ev["perSecret"].items()}
    assert ev["falsePositivesPerMinute"] <= BOUNDS["fp_per_min"], ev["fpDetections"]


@needs_ocr
def test_heldout_recall_and_false_positives(heldout):
    d, gt, res = heldout
    ev = evaluate(res, gt)
    _report("heldout", ev, res)
    _check(ev)


@needs_ocr
def test_fresh_recall_and_false_positives(fresh):
    d, gt, res = fresh
    ev = evaluate(res, gt)
    _report("fresh", ev, res)
    _check(ev)


@needs_ocr
def test_dev_recall_and_false_positives(dev):
    d, gt, res = dev
    ev = evaluate(res, gt)
    _report("dev", ev, res)
    _check(ev)


@needs_ocr
def test_scan_file_holds_no_secret_text(heldout, fresh, dev):
    from lensharness.leakcheck import norm
    for d, gt, res in (heldout, fresh, dev):
        blob = norm((d / "privacy.json").read_text())
        for k, s in gt["secrets"].items():
            if s["type"] == "notification" or not s["text"]:
                continue
            t = norm(s["text"])
            # no 8-character run of any secret (previews keep at most 4-5 characters at each end)
            assert not any(t[i:i + 8] in blob for i in range(0, max(1, len(t) - 7))), k
        for det in res["detections"]:
            if det["thumb"]:
                assert (d / "thumbs" / det["thumb"]).exists()


@needs_ocr
def test_rendered_export_leaks_no_secret(fresh, tmp_path):
    """Every detection accepted -> lens-plan -> compositor -> OCR each secret's region on every
    frame where it is visible. A manual 1.6x zoom over part of the session checks the masks follow
    the camera."""
    from lens_compositor.render import RenderOptions, probe, read_frames, render
    from lensharness.leakcheck import leaks, ocr_crops, prep_crop
    from media import screen_point

    d, gt, res = fresh
    project = {
        "output": {"aspect": "16:9", "resolution": 720, "fps": 30},
        "background": {"kind": "solid", "colors": ["#000000"]},
        "frame": {"padding": 0, "radius": 0, "shadow": {"opacity": 0}},
        "zoom": {"auto": False, "segments": [{"id": "z", "startMs": 24000, "endMs": 33000, "scale": 1.6, "focus": {"x": 760, "y": 420},
                                              "style": "classic", "auto": False}]},
        "cursor": {"visible": False}, "motionBlur": {"enabled": False}, "shortcuts": {"enabled": False},
    }
    (tmp_path / "p.json").write_text(json.dumps(project))
    cli = ROOT / "packages" / "engine" / "dist" / "cli.js"
    r = subprocess.run(["node", str(cli), "--meta", str(d / "meta.json"), "--events", str(d / "events.jsonl"), "--project", str(tmp_path / "p.json"),
                        "--privacy-scan", str(d / "privacy.json"), "--accept-privacy", "--project-out", str(tmp_path / "accepted.json"),
                        "--out", str(tmp_path / "plan.json")], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert "not reviewed" not in r.stderr
    accepted = json.loads((tmp_path / "accepted.json").read_text())
    assert all(x["state"] == "accepted" for x in accepted["privacy"]["detections"])
    assert sum(1 for m in accepted["masks"] if m.get("privacyId")) >= len(res["detections"])
    plan = json.loads((tmp_path / "plan.json").read_text())
    out = tmp_path / "redacted.mp4"
    render(str(tmp_path / "plan.json"), str(d / "screen.mp4"), str(out), opts=RenderOptions(preset="veryfast", crf=16))

    fps = gt["fps"]
    info = probe(str(out))
    secrets = {k: v for k, v in gt["secrets"].items() if v["text"]}
    leaked: dict[str, list[int]] = {k: [] for k in secrets}
    checked = 0
    pending: list[tuple[str, int, np.ndarray]] = []

    def flush():
        nonlocal pending
        if not pending:
            return
        texts = ocr_crops([c for _, _, c in pending])
        for (k, i, _), t in zip(pending, texts):
            if leaks(t, secrets[k]["text"]):
                leaked[k].append(i)
        pending = []

    for i, frame in enumerate(read_frames(str(out), info["width"], info["height"])):
        pf = plan["frames"][i]
        src = int(round(pf["src"] * fps / 1000))
        for k, s in secrets.items():
            box = s["frames"].get(str(src))
            if not box:
                continue
            x0, y0 = screen_point(pf, plan, box[0], box[1])
            x1, y1 = screen_point(pf, plan, box[0] + box[2], box[1] + box[3])
            c = prep_crop(frame, (x0, y0, x1 - x0, y1 - y0))
            if c is not None:
                pending.append((k, i, c))
                checked += 1
        if len(pending) >= 240:
            flush()
    flush()

    # control: the same OCR on the source frames reads the secrets
    readable = total = 0
    sample = []
    for k, s in secrets.items():
        fr = sorted(int(f) for f in s["frames"])
        for f in fr[::15]:
            sample.append((k, f, s["frames"][str(f)]))
    by_frame: dict[int, list] = {}
    for k, f, b in sample:
        by_frame.setdefault(f, []).append((k, b))
    crops, keys = [], []
    sinfo = probe(str(d / "screen.mp4"))
    for f, frame in enumerate(read_frames(str(d / "screen.mp4"), sinfo["width"], sinfo["height"])):
        for k, b in by_frame.get(f, []):
            c = prep_crop(frame, b)
            if c is not None:
                crops.append(c)
                keys.append(k)
    for k, t in zip(keys, ocr_crops(crops)):
        total += 1
        readable += leaks(t, secrets[k]["text"])
    control = readable / max(1, total)

    n_leaked = sum(len(v) for v in leaked.values())
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "leak-report.json").write_text(json.dumps({"checkedRegions": checked, "leakedFrames": n_leaked,
                                                      "leakedBySecret": {k: v for k, v in leaked.items() if v},
                                                      "controlReadable": control, "controlSamples": total}, indent=1))
    print(f"\n[leak] {checked} secret regions OCR'd in the export, {n_leaked} leaked; control: OCR read {readable}/{total} source regions ({control:.2f})")
    assert control >= BOUNDS["control_readable"]
    assert n_leaked <= BOUNDS["leaked_frames"], {k: v[:10] for k, v in leaked.items() if v}


def test_pipeline_warns_about_pending_detections():
    from lens_compositor.pipeline import privacy_warning

    det = {"id": "pd1", "type": "email", "state": "pending", "tracks": []}
    assert "1 privacy detection not reviewed (email)" in privacy_warning({"privacy": {"detections": [det]}})
    assert privacy_warning({"privacy": {"detections": [{**det, "state": "accepted"}, {**det, "id": "b", "state": "dismissed"}]}}) is None
    assert privacy_warning({}) is None
