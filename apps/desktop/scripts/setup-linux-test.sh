#!/usr/bin/env bash
# System packages for the desktop e2e tests on Debian / Ubuntu (lost when the sandbox restarts):
# Xvfb + xdotool (synthetic scene input), Tk (the scene window), Electron's shared libraries.
# On linux-arm64 the uiohook-napi "linux-arm64" prebuild is an x86-64 binary (upstream packaging),
# so it is built from source once (needs a compiler and X11 headers; the result stays in node_modules).
set -e
sudo apt-get install -y -qq xvfb xdotool x11-utils libtk8.6 libnss3 libgbm1 libxtst6 libxss1 \
  "$(apt-cache show libasound2t64 >/dev/null 2>&1 && echo libasound2t64 || echo libasound2)" \
  "$(apt-cache show libgtk-3-0t64 >/dev/null 2>&1 && echo libgtk-3-0t64 || echo libgtk-3-0)" >/dev/null
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
if [ "$(uname -m)" = "aarch64" ] && [ ! -f "$ROOT/node_modules/uiohook-napi/build/Release/uiohook_napi.node" ]; then
  sudo apt-get install -y -qq build-essential libx11-dev libxtst-dev libxt-dev libxrandr-dev libxinerama-dev libxkbfile-dev >/dev/null
  (cd "$ROOT/node_modules/uiohook-napi" && npx --yes node-gyp rebuild)
fi
echo "desktop test deps ready"
