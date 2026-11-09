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

4. **Publish** the GitHub Release with the three files the updater reads:

   ```bash
   node apps/desktop/scripts/release.mjs --notes notes.md
   ```

   It creates release `v<version>` at `HEAD` and uploads `latest.yml`, the installer and its blockmap,
   then prints the release URL. Auth: in Hark the shell runs with the GitHub credential (credentials
   provider `github`; release creation is the `release_create` call of `apicall github --list releases`,
   asset upload goes to `uploads.github.com`); elsewhere set `GITHUB_TOKEN`. It refuses to overwrite an
   existing tag, so a mistake means a new version, not a re-upload.

5. **Check**: `https://github.com/MuhammadFaizan-prog/Lens/releases/latest` shows the new version with
   the three assets. An installed older copy shows the update banner within 8 s of its next launch.

Do not delete a published release that users may already be updating from; publish a newer one.

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
# against the real release instead of a local feed:
LENS_UPDATE_OLD_APP=... LENS_UPDATE_GITHUB=1 npx playwright test -c apps/desktop/playwright.config.ts e2e/update.spec.ts
```

Switches (development and tests only): `LENS_UPDATE_URL` (generic feed URL), `LENS_UPDATE_NSIS=1`,
`LENS_UPDATE_NO_INSTALL=1`, `LENS_UPDATE_FIRST_CHECK_MS`, `LENS_NO_UPDATE=1`.
