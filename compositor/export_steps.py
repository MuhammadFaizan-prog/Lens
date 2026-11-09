#!/usr/bin/env python3
"""CLI: interactive demo and step guide from a recording (demand #7, docs/InteractiveDemo.md).

  python compositor/export_steps.py --manifest steps.json --plan plan.json --screen screen.mp4 \
      --out out/demo [--kind demo,guide] [--assets bundle/]

The manifest and the still-frame plan come from the engine (stepsExportInput in
packages/engine/src/demoExport.ts); `lens export demo|guide` and the editor write them. Prints one
JSON line with what was written.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lens_compositor.stepsexport import export_steps  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--plan", required=True)
    ap.add_argument("--screen", required=True)
    ap.add_argument("--out", required=True, help="output folder")
    ap.add_argument("--kind", default="demo,guide", help="demo, guide or demo,guide")
    ap.add_argument("--assets", help="folder logo / font paths resolve against (the bundle)")
    a = ap.parse_args()
    kinds = [k.strip() for k in a.kind.split(",") if k.strip()]
    if not kinds or any(k not in ("demo", "guide") for k in kinds):
        ap.error("--kind must be demo, guide or demo,guide")
    try:
        res = export_steps(a.manifest, a.plan, a.screen, a.out, kinds, a.assets)
    except (ValueError, FileNotFoundError) as e:
        print(f"export_steps: {e}", file=sys.stderr)
        return 1
    print(json.dumps(res))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
