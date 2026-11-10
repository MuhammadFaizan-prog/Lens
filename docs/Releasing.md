# Releasing the desktop app

Every feature ship goes out the same way: bump the version, build the Windows installer, publish it as
a GitHub Release. Installed copies pick the release up on their own (auto-update), so users install
once and never download again.

## How auto-update works

- `apps/desktop/src/main/updater.ts` runs electron-updater with the **GitHub Releases** provider on the
  public repo `MuhammadFaizan-prog/Lens`. A packaged build reads `resources/app-update.yml`, which
  electron-builder writes from the `publish` block in `apps/desktop/scripts/dist-win.mjs`.
- It checks 8 s after launch and every 4 hours, and on demand from **Check for updates** (the tray menu,
  the app menu **Lens → Check for updates**, and the link at the bottom of the recorder window).
- A newer release shows a banner in the recorder: **Update available vX** with an **Update** button.
  Update downloads the installer (differentially from the blockmap when the previous installer is in the
  updater cache, otherwise in full) and electron-updater checks its sha512 against `latest.yml`. Then the
  button becomes **Restart to update**, which calls `quitAndInstall` (silent per-user install, relaunch).
  If the user just quits instead, the downloaded update installs on quit.
- It only installs a **newer** version (`allowDowngrade` off, no prereleases).
- The installer is NSIS, one-click, per-user (`%LOCALAPPDATA%\Programs\Lens`). The portable target cannot
  auto-update, so it is not built.
- The build is **unsigned** and `publisherName` is deliberately not set, so electron-updater does not
  demand an Authenticode signature. Signing later: add the certificate to electron-builder *and* set
  `win.publisherName`; from then on every update must be signed by that publisher.
- Updates never touch user data: recordings live in `<Videos>\Lens`, settings in
  `%APPDATA%\Lens`; the installer replaces only the program folder (`deleteAppDataOnUninstall: false`).
  The updater downloads into its own cache (`%LOCALAPPDATA%\lens-updater`).

## Ship a release

From the repo root, on `main`, with the change committed and the suites green (README / Tracker).

1. **Bump the version** (semver; every release needs a new one, the updater compares versions):

   ```bash
   npm version 0.1.2 --no-git-tag-version -w @lens/desktop
   ```

2. **Build** the editor, the app and the Windows installer (Linux works, no wine needed):

   ```bash
   npm run build -w @lens/editor
   npm run dist:win -w @lens/desktop
   ```

   Output in `out/desktop/` (git-ignored): `Lens-Setup-<version>.exe`, `Lens-Setup-<version>.exe.blockmap`,
   `latest.yml`, `win-unpacked/`. Never commit these.

3. **Commit and push** the version bump (the release tag points at the pushed commit):

   ```bash
   git add apps/desktop/package.json package-lock.json
   git -c user.name=MuhammadFaizan-prog -c user.email=130775084+MuhammadFaizan-prog@users.noreply.github.com commit -m "desktop: v0.1.2"
   git -c http.sslCAInfo="$SSL_CERT_FILE" push origin main
   ```

4. **Publish** the GitHub Release. Two steps, because the Hark sandbox cannot upload release assets
   (every upload to `uploads.github.com` answers 400 through its gateway):

   ```bash
   node apps/desktop/scripts/release.mjs --no-upload --notes docs/releases/v<version>.md
   ```

   Release notes live in `docs/releases/v<version>.md` (from 0.1.3) and are the release body.

   creates release `v<version>` at `HEAD` (it still checks that `out/desktop/latest.yml` is for this
   version) and prints its URL. Auth: in Hark the shell runs with the GitHub credential (credentials
   provider `github`); elsewhere set `GITHUB_TOKEN`. It refuses to overwrite an existing tag, so a mistake
   means a new version, not a re-upload. Then run the **desktop-release** workflow
   (`.github/workflows/desktop-release.yml`) on `main` with input `tag=v<version>`: from the Actions tab,
   or in Hark `apicall github workflow_dispatch owner=MuhammadFaizan-prog repo=Lens
   workflow_id=desktop-release.yml ref=main inputs='{"tag":"v<version>"}'`. It checks out the tag,
   builds the installer on ubuntu-24.04 the same way as step 2, checks the package (installer payload,
   ffmpeg.exe, the uiohook win32-x64 prebuild, app.asar, app-update.yml, the editor; Lens.exe's icon
   and version info, below), and uploads `latest.yml`, the installer and its blockmap to the release.
   The installer CI builds is the one users get: its sha512 differs from your local build's, so take
   hashes from the release's `latest.yml`, not from `out/desktop/`. Outside Hark, plain
   `node apps/desktop/scripts/release.mjs --notes notes.md` uploads the local build itself.

5. **Check**: `https://github.com/MuhammadFaizan-prog/Lens/releases/latest` shows the new version with
   the three assets; download the installer and check its sha512 equals `latest.yml`'s
   (`openssl dgst -sha512 -binary Lens-Setup-<version>.exe | base64 -w0`). An installed older copy
   shows the update banner within 8 s of its next launch.

Do not delete a published release that users may already be updating from; publish a newer one.

## Bundled models and the MSVC runtime

`apps/editor/scripts/fetch-models.mjs` downloads the on-device models into `assets/models` (git-ignored, every
file SHA-256 pinned): RNNoise `sh.rnnn` (export noise reduction), tessdata_fast `eng.traineddata` (in-app OCR),
Whisper base.en q5_1 and the official whisper.cpp v1.8.2 Windows CLI (`whisper-cli.exe`, `whisper.dll`,
`ggml*.dll`). `dist-win.mjs` runs it and copies the folder to `resources/lens/assets/models`; the
desktop-release workflow also runs it as its own step and fails if any of these files is missing from the
installer payload.

The official whisper.cpp Windows build is MSVC-linked (linker 14.44): it imports `MSVCP140.dll`,
`VCRUNTIME140.dll`, `VCRUNTIME140_1.dll` and (ggml-cpu) `VCOMP140.dll`. Since 0.1.2 those four Microsoft
Visual C++ 2015-2022 runtime DLLs (14.44.35208 x64, Authenticode-signed by Microsoft) ship next to
`whisper-cli.exe`, where Windows looks first, so speech-to-text works on machines without the VC++
Redistributable. They are redistributable under the Visual Studio redistributable licence; they come from
conda-forge's `vc14_runtime` / `vcomp14` 14.44.35208 packages (the Microsoft files unchanged, the `.conda`
archives pinned by SHA-256) and `VCRUNTIME-NOTICE.txt` sits beside them. The UCRT (`api-ms-win-crt-*`) is part
of Windows 10 / 11. If the runtime still fails to load (STATUS_DLL_NOT_FOUND), `server/stt.ts` reports that
the Visual C++ runtime is missing with the redist download link. Bumping whisper.cpp: check the new build's
linker version and imports and move the runtime pin to a toolset at least as new.

## App icon

One drawing, `apps/desktop/scripts/make-icon.mjs` (a red record dot with a white ring on a dark rounded
square, first used for the 0.1.0 installer; do not redesign it), generated at build time so no binary is
committed:

- `lens.ico` with 16 / 24 / 32 / 48 / 64 / 256 px (BMP entries, PNG for 256): the installer and
  uninstaller (NSIS), the **Lens.exe** icon resource, and on Windows the window and tray icons
  (`dist/icons/lens.ico`, written by `scripts/build.mjs`).
- `lens-<n>.png`: window and tray icon on Linux / macOS.
- The editor's favicon (`apps/editor/index.html`) and header mark (`LensMark` in
  `apps/editor/src/components/Icon.tsx`) are the same geometry and colours as SVG; `test/icon.test.ts`
  fails if they drift.

Lens.exe: electron-builder normally edits the exe with rcedit, which on Linux needs wine, so
`signAndEditExecutable` is off and the `afterPack` hook `scripts/edit-exe.cjs` writes the icon group and
version info (ProductName / FileDescription Lens, FileVersion = the app version) with `resedit` (pure
JS, the library `@electron/packager` uses for the same job). 0.1.0 shipped without it: its Lens.exe kept
Electron's atom icon. The workflow checks every build: it extracts Lens.exe from the installer payload,
pulls its icon group with `wrestool -x -t14`, decodes both that and a freshly generated `lens.ico` with
`icotool -x`, and requires the six images to be byte-identical, then reads the version strings
(`wrestool --raw -x -t16`). The same check fails on the 0.1.0 installer.

Taskbar: the main process calls `app.setAppUserModelId("io.github.muhammadfaizanprog.lens")` on Windows,
the same id electron-builder's NSIS installer writes on the Start-menu and desktop shortcuts
(`WinShell::SetLnkAUMI`), so the windows group under Lens with its icon instead of under electron.exe.

## Test the update flow without Windows

`apps/desktop/e2e/update.spec.ts` runs the old version's staged app (the same JS that ships in the
installer) under Xvfb with the NSIS updater forced on (`LENS_UPDATE_NSIS=1`) against a feed holding the
new build, and checks: update detected and shown, Update downloads it, the downloaded file's sha512
equals `latest.yml`'s, **Restart to update** shows; a feed with a wrong sha512 is refused. Running the
installer (`quitAndInstall`) is Windows-only and is not exercised.

```bash
# keep the old build's staged app before building the new one
cp -r out/desktop-cache/stage out/desktop/releases/0.1.0/app
LENS_UPDATE_OLD_APP=$PWD/out/desktop/releases/0.1.0/app LENS_UPDATE_FEED=$PWD/out/desktop/releases/0.1.1 \
  npx playwright test -c apps/desktop/playwright.config.ts e2e/update.spec.ts
# against the published release: download its three assets into a folder and use that as the feed
# (LENS_UPDATE_GITHUB=1 only works on Windows: on Linux electron-updater asks GitHub for
# latest-linux-<arch>.yml, which a Windows release does not have)
LENS_UPDATE_OLD_APP=... LENS_UPDATE_FEED=$PWD/downloaded-v0.1.1 npx playwright test -c apps/desktop/playwright.config.ts e2e/update.spec.ts
```

Switches (development and tests only): `LENS_UPDATE_URL` (generic feed URL), `LENS_UPDATE_NSIS=1`,
`LENS_UPDATE_NO_INSTALL=1`, `LENS_UPDATE_FIRST_CHECK_MS`, `LENS_NO_UPDATE=1`.
