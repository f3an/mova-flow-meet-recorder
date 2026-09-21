# Chrome Web Store submission

Prepared assets for the first Web Store listing (Developer Dashboard: https://chrome.google.com/webstore/devconsole).

## In this folder

- `mova-flow-meet-recorder-0.1.0.zip` — the package to upload. Rebuild it after any change with:
  ```bash
  npm run build
  zip -r store-assets/mova-flow-meet-recorder-0.1.0.zip manifest.json popup.html popup.css onboarding.html onboarding.css offscreen.html content.css icons dist -x "*.DS_Store"
  ```
- `screenshots/` — three 1280x800 screenshots (setup page, idle popup, recording popup), ready to upload as-is.

## Still needed from you in the dashboard

1. **One-time $5 developer registration** (if you haven't already) — Chrome Web Store Developer Dashboard asks for this on first item creation.
2. **Privacy policy URL**: `https://f3an.github.io/Mova-Flow/privacy.html` — live once `site/privacy.html` is pushed to `master` (GitHub Pages redeploys automatically on push).
3. **Listing copy** — short description (132 chars max) and detailed description, in the dashboard's "Store listing" tab.
4. **Single purpose description + permission justifications** — the dashboard asks you to justify each permission in `manifest.json` (`tabCapture`, `offscreen`, `storage`, `activeTab`, `downloads`, `host_permissions`) in a sentence or two each. E.g. for `tabCapture`/`offscreen`: "records the Meet tab's audio so it can be transcribed."
5. **Data usage disclosure** — the dashboard's Privacy tab will ask whether the extension collects audio/personal communications. Answer yes for audio, and note (per the privacy policy) that it's sent only to the host the user configures, never to you or any third party.
6. Category: likely **Productivity**.

## After first approval

Chrome Web Store review for a new item is typically a few days to ~2 weeks. Once approved, add the Web Store link to `README.md` and `site/index.html` (replace the "Not yet on the Chrome Web Store" note).
