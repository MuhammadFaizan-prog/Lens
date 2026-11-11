# Share link with your own storage (demand #13)

Lens can upload an export to **your** S3-compatible bucket and give you a link to a small player
page. Nothing goes through Lens servers; the only cost is your bucket's.

## Using it

Inspector → **Share** tab.

1. **Storage** (once): pick a provider, fill in the endpoint, bucket, region and an access key pair,
   optionally a public URL, and **Save**. **Test connection** writes and deletes a tiny
   `.lens-check-…` object to prove the endpoint, bucket, keys and write permission.
2. **Share link**: type a title and press **Upload & copy link**. If the project has no export for
   its current state, Lens exports first (the desktop app's in-browser export, no Python). Then it
   uploads three objects and copies the link:

   ```
   <folder>/<title-slug>-<random>/video.mp4    the export, byte for byte
   <folder>/<title-slug>-<random>/poster.jpg   a frame at 10 % (max 1 s) of the video
   <folder>/<title-slug>-<random>/index.html   the player page
   ```

The player page is one self-contained HTML file: the title, the video (with the poster), the
duration and size, and the chapter list when the project has chapters (`project.chapters.items`,
mapped from the recording clock onto the export's clock through cuts and speed changes; click a
chapter to seek, `#t=42` deep links). It makes no request outside the bucket and has a strict CSP.

### Links: public bucket or presigned

- **Public URL set** (R2 `r2.dev` or custom domain, a public S3 bucket or CloudFront, Supabase's
  public URL): the link is `<public URL>/<key of index.html>`, the page loads its neighbours by
  relative URL, and the link does not expire.
- **No public URL** (private bucket): the page, video and poster URLs are SigV4 **presigned** for the
  chosen lifetime (1-7 days; 7 is the S3 maximum). A presigned URL contains the access key **ID**
  (never the secret); use a key that can only write this bucket, or a public URL, if that matters.

## Providers

| Provider | Endpoint | Region | Addressing | Notes |
|---|---|---|---|---|
| Cloudflare R2 | `https://<account-id>.r2.cloudflarestorage.com` | `auto` | path-style | R2 API token with Object Read & Write on the bucket |
| Amazon S3 | `https://s3.<region>.amazonaws.com` | the bucket's | virtual-host | IAM key limited to `s3:PutObject` / `s3:DeleteObject` on the bucket |
| Supabase Storage | `https://<project-ref>.supabase.co/storage/v1/s3` | the project's | path-style | S3 access keys from Project Settings → Storage. Supabase may serve `.html` as plain text from its public URL: use a custom domain / CDN or presigned links |
| Other (MinIO, Wasabi, B2, …) | the service's S3 endpoint | as documented | usually path-style | any S3 API with Signature V4 |

Uploads are single signed PUTs with the payload's SHA-256 in the signature, so an object larger
than 5 GB (S3's single-PUT limit) is refused by the storage; multipart upload is not implemented.

## Where the keys are kept

- **Desktop app**: encrypted with Electron `safeStorage` (macOS Keychain, Windows DPAPI, Linux
  libsecret / KWallet) in `share-storage.json` under the app's user-data folder. On a Linux desktop
  without a keyring, safeStorage reports no encryption and the keys are stored like the web build's.
- **Web / dev editor**: `~/.lens/share.json` (or `LENS_SHARE_CONFIG`), created with mode 0600.
- **Never** in `project.json`, the bundle, exports, presets, or the page: the editor posts the keys
  to its own local server once on Save and only ever gets back the last 4 characters of the key ID.
  Every error from the storage is passed through a redaction step (key ID, secret, signatures and
  credential scopes removed) before it is shown or logged.

## How it works

| Part | Code |
|---|---|
| SigV4 signer (header auth + presigned GET), written from the published algorithm, no SDK | `apps/editor/server/share/sigv4.ts` |
| Config store, bucket addressing, uploads, jobs, redaction | `apps/editor/server/share/share.ts` |
| Player page | `apps/editor/server/share/viewer.ts` |
| HTTP API: `GET/PUT/DELETE /api/share/config`, `POST /api/share/test`, `POST /api/share/upload`, `GET /api/share/upload/:id` | `apps/editor/server/api.ts` |
| Keychain hook | `apps/desktop/src/main/editorServer.ts` |
| Share tab, store actions | `apps/editor/src/components/SharePanel.tsx`, `apps/editor/src/state/share.ts`, `store.ts` |

## Tests

- `apps/editor/test/shareLink.test.ts` (vitest): signatures equal botocore 1.44.0's
  `S3SigV4Auth` / `S3SigV4QueryAuth` for the same requests and clock (path-style PUT with a space in
  the key, virtual-host R2 PUT with region `auto`, presigned GET); bucket addressing incl. Supabase's
  endpoint path; settings validation; config file mode 0600, key hint only, blank keys keep the saved
  ones, a codec keeps keys out of the file in clear, unreadable keys reported; redaction; page
  escaping and chapters; chapters mapped through a cut.
- `apps/editor/e2e/shareLink.spec.ts` (Playwright, web build, browser export path) against
  `e2e/mockS3.ts`, a local S3 server that checks every SigV4 signature and body hash itself. Bounds
  and results are in `docs/Tracker.md`.

## Not done

- Progressive upload during recording and replacing the file after a re-render (the demand
  report's "link on stop" target) — the link is made from a finished export.
- Multipart upload (files over 5 GB), Google Drive / Dropbox, a "viewed" webhook, a Lens-hosted
  option.
- Not run against real AWS / R2 / Supabase accounts (no credentials in this environment); only the
  mock server and the botocore signature vectors. Unverified on Windows / macOS keychains.
