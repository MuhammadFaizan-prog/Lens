"""compositor/render.py --progress: the editor's export bar reads these lines."""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "research" / "harness"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from lensharness.synth import synthesize  # noqa: E402
from media import CLI, make_plan  # noqa: E402

pytestmark = pytest.mark.skipif(shutil.which("node") is None or not CLI.exists(), reason="engine not built (npm run build)")


def test_progress_lines_count_up_to_total(tmp_path: Path) -> None:
    s = synthesize(tmp_path, 640, 360, 30, 1000)
    make_plan(tmp_path, s["meta"], s["events"], {"output": {"fps": 30, "resolution": 360}, "motionBlur": {"enabled": False}})
    out = tmp_path / "o.mp4"
    r = subprocess.run([sys.executable, str(ROOT / "compositor" / "render.py"), "--plan", str(tmp_path / "plan.json"), "--screen", s["screen"],
                        "--out", str(out), "--preset", "ultrafast", "--progress"], capture_output=True, text=True, check=True)
    lines = [ln.split() for ln in r.stderr.splitlines() if ln.startswith("progress ")]
    done = [int(a[1]) for a in lines]
    totals = {int(a[2]) for a in lines}
    assert totals == {30}
    assert done == sorted(done) and done[-1] == 30 and done[0] == 5
    assert out.stat().st_size > 0


def test_no_progress_lines_without_flag(tmp_path: Path) -> None:
    s = synthesize(tmp_path, 640, 360, 30, 400)
    make_plan(tmp_path, s["meta"], s["events"], {"output": {"fps": 30, "resolution": 360}})
    r = subprocess.run([sys.executable, str(ROOT / "compositor" / "render.py"), "--plan", str(tmp_path / "plan.json"), "--screen", s["screen"],
                        "--out", str(tmp_path / "o.mp4"), "--preset", "ultrafast"], capture_output=True, text=True, check=True)
    assert "progress" not in r.stderr
