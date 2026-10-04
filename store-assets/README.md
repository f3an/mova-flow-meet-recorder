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

- `screenshots/` — the 1280x800 listing screenshots (setup page, idle popup, recording popup, finished transcript with speaker names).
- `mova-flow-meet-recorder-0.1.0.zip` — the package of the first, manually submitted version; kept for reference only.
