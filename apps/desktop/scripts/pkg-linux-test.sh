#!/usr/bin/env bash
# Build the editor + desktop app, package it as an unpacked Linux app (scripts/dist-win.mjs --linux-dir)
# and run one desktop e2e spec against the packaged app. Usage: scripts/pkg-linux-test.sh <spec> [--no-build]
set -e
cd "$(dirname "$0")/.."
if [ "$2" != "--no-build" ]; then
  (cd ../editor && npx vite build --logLevel warn)
  node scripts/build.mjs >/dev/null
  node scripts/dist-win.mjs --linux-dir > /tmp/lens-dist-linux.log 2>&1 || { tail -20 /tmp/lens-dist-linux.log; exit 1; }
fi
EXE="$(cd ../.. && pwd)/out/desktop/linux-$(node -p process.arch)-unpacked/lens"
pkill -f "[l]inux-.*-unpacked/lens" || true
export LENS_E2E_DISPLAY="${LENS_E2E_DISPLAY:-71}"  # a display no other workspace job uses (93 / 97 are taken)
# This box OOM-kills under load from other workspaces: a failed run during which the kernel OOM killer
# fired is logged (runs/oom-log.txt) and retried, up to 4 attempts; any other failure stops at once.
LOG="$(cd ../.. && pwd)/../runs/oom-log.txt"
for attempt in ${LENS_ATTEMPTS:-1 2 3 4}; do
  # optional: wait for a quiet moment on a shared box (LENS_WAIT_CALM=<script that waits, then runs its args>)
  [ -n "$LENS_WAIT_CALM" ] && "$LENS_WAIT_CALM" true
  before=$(dmesg 2>/dev/null | grep -c "Killed process" || true)
  LENS_PACKAGED_APP="$EXE" npx playwright test "e2e/$1" --workers=1 && exit 0
  after=$(dmesg 2>/dev/null | grep -c "Killed process" || true)
  if [ "$after" -gt "$before" ]; then
    echo "$(date -Is) $1 attempt $attempt: failed with $((after - before)) OOM kill(s) during the run (not an assertion failure): $(dmesg | grep 'Killed process' | tail -n $((after - before)) | sed 's/.*Killed process //; s/ total-vm.*//' | tr '\n' ';')" | tee -a "$LOG"
    sleep 20
    continue
  fi
  exit 1
done
exit 1
