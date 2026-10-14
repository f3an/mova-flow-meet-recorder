# Chrome Web Store

Live listing: https://chromewebstore.google.com/detail/mova-flow-meet-recorder/kdeeohghjiengnkgfpjkakeajhnddfnh
(Developer Dashboard: https://chrome.google.com/webstore/devconsole)

## Releasing a new version

Releases are automatic — `.github/workflows/release.yml` builds, packages, uploads and submits for review on every `v*.*.*` tag.

1. Bump `version` in **both** `manifest.json` and `package.json` (the workflow fails if the tag doesn't match them — the Web Store rejects a version it has already seen).
2. Commit, then tag and push: `git tag vX.Y.Z && git push origin master vX.Y.Z`.
3. The new version goes live once Web Store review passes (usually hours to a few days). Only one submission can be in review at a time — a tag pushed while the previous one is still pending fails at the upload step.

To check the pipeline without publishing: Actions → Release → Run workflow (leave "dry run" ticked). It builds and attaches `extension.zip` as an artifact.

### Credentials

Repository secrets `CHROME_EXTENSION_ID`, `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, `CHROME_REFRESH_TOKEN`. The OAuth client ("github-actions", Desktop app) lives in the `mova-flow` Google Cloud project, whose consent screen must stay **In production** — in Testing, the refresh token expires after 7 days. To re-issue the refresh token: `npx chrome-webstore-upload-keys`, signed in as the account that owns the listing.

## In this folder

- `screenshots/` — the 1280x800 listing screenshots (transcript, side panel, the Record button in Meet/Zoom/Teams/Jitsi, the setup page) and the promo tiles, all 24-bit PNG (the store rejects an alpha channel). Made from the extension's own pages rendered with sample data — no real call or person in them.
- `mova-flow-meet-recorder-0.1.0.zip` — the package of the first, manually submitted version; kept for reference only.
- `promo-video.mp4` — a 36-second animated promo (1920x1080) for the listing's "Global promo video": the store only takes a YouTube link, so upload it there (unlisted is fine) and paste the URL.
- `promo-video-thumbnail.png` — the video's YouTube thumbnail (1280x720).
