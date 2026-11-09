#!/usr/bin/env bash
# Builds whisper.cpp's CLI (v1.8.2, MIT) for this Linux machine into
# assets/models/whisper/linux-<arch>/whisper-cli (git-ignored), statically linked against whisper/ggml
# so it needs only libc/libstdc++. Windows uses the official release zip instead (fetch-models.mjs).
# Used by `dist-win.mjs --linux-dir` (the packaged-app tests on the Linux box) and for dev runs.
# Needs git, cmake and a C++ compiler. Usage: apps/editor/scripts/build-whisper.sh
# WHISPER_SRC=<existing v1.8.2 checkout> skips the clone.
set -euo pipefail
TAG=v1.8.2
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
case "$(uname -m)" in x86_64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) ARCH="$(uname -m)" ;; esac
OUT="${LENS_MODELS_DIR:-$REPO/assets/models}/whisper/linux-$ARCH"
[ -x "$OUT/whisper-cli" ] && "$OUT/whisper-cli" --help >/dev/null 2>&1 && { echo "whisper-cli already built: $OUT"; exit 0; }
SRC="${WHISPER_SRC:-$REPO/out/whisper.cpp-$TAG}"
if [ ! -f "$SRC/CMakeLists.txt" ]; then
  git clone -q --depth 1 --branch "$TAG" https://github.com/ggml-org/whisper.cpp "$SRC"
fi
cmake -S "$SRC" -B "$SRC/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_SERVER=OFF -DWHISPER_SDL2=OFF -DGGML_NATIVE=OFF >/dev/null
cmake --build "$SRC/build" --target whisper-cli -j "$(nproc)" >/dev/null
mkdir -p "$OUT"
install -m 755 "$SRC/build/bin/whisper-cli" "$OUT/whisper-cli"
cp "$SRC/LICENSE" "$OUT/LICENSE-whisper.cpp.txt"
echo "built $OUT/whisper-cli"
