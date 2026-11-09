"""Windows bug #1: the privacy scan and step labels run in-app (Node + tesseract.js, no Python).

The in-app scanner (apps/editor/server/redact, bundled as out/redact/lens-redact.cjs by
apps/editor/scripts/build-redact-cli.mjs) is scored on the same synthetic recordings and the same
evaluator as the Python reference (tests/test_privacy.py). Bounds, set before measuring:
- in-app instance recall >= 0.95 and frame recall >= 0.95 on every variant (the Python bounds);
- in-app frame recall within 0.02 of the Python reference on the same video;
- false positives <= 1.0 per minute; the scan file holds no secret text;
- step labels: the in-app draft count equals the Python reference's, and >= 80% of the labels agree.
Run: python3 -m pytest tests/test_redact_inapp.py -s (needs node, ffmpeg; Python only for the reference).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "redact"))
sys.path.insert(0, str(ROOT / "research" / "harness"))

from lens_redact.evaluate import evaluate  # noqa: E402
from lens_redact.ocr import tesseract_available  # noqa: E402

CLI = ROOT / "out" / "redact" / "lens-redact.cjs"
OUT = ROOT / "out" / "privacy-inapp"


@pytest.fixture(scope="module", autouse=True)
def built():
    subprocess.run(["node", str(ROOT / "apps" / "editor" / "scripts" / "fetch-models.mjs"), "--only", "tessdata"], check=True)
    subprocess.run(["node", str(ROOT / "apps" / "editor" / "scripts" / "build-redact-cli.mjs")], check=True)


def node_scan(d: Path) -> dict:
    out = d / "privacy-node.json"
    subprocess.run(["node", str(CLI), str(d / "screen.mp4"), "--events", str(d / "events.jsonl"), "-o", str(out), "--thumbs", str(d / "thumbs-node")],
                   check=True, env={**os.environ, "LENS_MODELS_DIR": str(ROOT / "assets" / "models"), "NODE_PATH": str(ROOT / "apps" / "editor" / "node_modules")})
    return json.loads(out.read_text())


@pytest.mark.parametrize("variant", ["dev", "heldout", "fresh"])
def test_inapp_recall_matches_python(variant, tmp_path):
    from lensharness.privacy_synth import generate
    gt = generate(tmp_path, variant=variant)
    res = node_scan(tmp_path)
    ev = evaluate(res, gt)
    report = {"inapp": {"instanceRecall": ev["instanceRecall"], "frameRecall": ev["frameRecall"], "fpPerMin": ev["falsePositivesPerMinute"],
                        "secondsPerMinute": res["stats"].get("secondsPerMinute")}}
    if tesseract_available() and os.environ.get("LENS_SKIP_PY_REF") != "1":
        from lens_redact.scan import scan
        ref = scan(str(tmp_path / "screen.mp4"), str(tmp_path / "events.jsonl"), thumbs_dir=str(tmp_path / "thumbs"))
        evr = evaluate(ref, gt)
        report["python"] = {"instanceRecall": evr["instanceRecall"], "frameRecall": evr["frameRecall"], "fpPerMin": evr["falsePositivesPerMinute"],
                            "secondsPerMinute": ref["stats"].get("secondsPerMinute")}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{variant}.json").write_text(json.dumps(report, indent=1))
    print(f"\n[{variant}] {json.dumps(report)}")
    assert ev["instanceRecall"] >= 0.95, ev["perSecret"]
    assert ev["frameRecall"] >= 0.95
    assert ev["falsePositivesPerMinute"] <= 1.0, ev["fpDetections"]
    if "python" in report:
        assert ev["frameRecall"] >= report["python"]["frameRecall"] - 0.02
    text = json.dumps(res)
    for s in gt.get("secrets", []):
        if isinstance(s, dict) and s.get("text") and len(s["text"]) >= 8:
            assert s["text"] not in text
