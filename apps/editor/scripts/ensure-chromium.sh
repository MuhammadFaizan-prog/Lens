#!/usr/bin/env bash
# Playwright needs a Chromium. Prefer Playwright's own build; on hosts where its CDN is blocked
# (this CI sandbox) fall back to the distro package, which playwright.config.ts picks up.
set -e
if npx playwright install chromium >/dev/null 2>&1; then echo "playwright chromium ok"; exit 0; fi
if command -v chromium >/dev/null; then echo "using $(command -v chromium)"; exit 0; fi
sudo apt-get update -qq && sudo apt-get install -y -qq chromium && echo "installed $(command -v chromium)"
