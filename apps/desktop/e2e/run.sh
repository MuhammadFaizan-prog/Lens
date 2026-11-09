#!/usr/bin/env bash
# Run one desktop e2e spec (default record.spec.ts) with stragglers from an earlier, killed run cleaned
# up first and afterwards: an OOM-killed Playwright worker leaves Electron, Xvfb and the scene running.
# Usage: e2e/run.sh [spec] ; env LENS_E2E_SCALE=2 for the DPI variant.
cd "$(dirname "$0")/.."
clean() { pkill -f "[e]lectron/dist/electron" ; pkill -f "[e]2e/scene.py" ; pkill -f "[X]vfb :${LENS_E2E_DISPLAY:-97}" ; sleep 1; }
clean
node scripts/build.mjs >/dev/null
npx playwright test "e2e/${1:-record.spec.ts}" --workers=1
code=$?
clean
exit $code
