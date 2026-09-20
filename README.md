# Mova Flow Meet Recorder

A Chrome extension that records a Google Meet call — both sides of the conversation, not just what you hear — and sends it to a [Mova Flow](https://github.com/f3an/Mova-Flow) server on your network for transcription. No cloud, nothing leaves your LAN.

## How it works

1. Click the extension icon on a Google Meet tab, press **Record**.
2. It captures the tab's audio (everyone else on the call) *and* your microphone, mixed into one track — so the transcript covers the whole conversation, not just one side.
3. Press **Stop & transcribe**. The recording is converted to 16kHz mono WAV (the format Mova Flow's `whisper-cli.exe` actually reads) and uploaded to your configured Mova Flow host, exactly like the desktop app's own client role does — shared secret, short-lived bearer token, the same `/api/auth` → `/api/transcribe` → `/api/status` flow.
4. The transcript comes back in the popup — copy it or download it as `.txt`.

This is a companion to the [Mova Flow](https://github.com/f3an/Mova-Flow) desktop app — you need a Mova Flow host already running somewhere on your network (see that repo for setup). This extension doesn't do any recognition itself; it's just a recorder + client.

## Install (unpacked, for now)

Not on the Chrome Web Store yet — load it manually:

```bash
npm install
npm run build
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.

## Setup

1. Click the extension icon → **Server settings**.
2. Enter your Mova Flow host's IP and port (find these on the host's own Server tab), and the access secret key.
3. **Test connection**, then **Save**. The first save will ask Chrome for permission to reach that address.
4. On the first recording, Chrome will also ask for microphone permission — that's for your side of the conversation, not the meeting itself (the meeting's own audio comes from the tab, not the mic).

## Why tab + mic, not just the tab

Capturing only the tab gives you what Meet *plays back to you* — the other participants. It does **not** include your own voice, since Meet strips your own mic input out of your own audio output (that's just how echo cancellation works). Recording only the tab would produce a transcript with everyone's words except yours. So this extension mixes both streams into one recording before sending it off.

## Development

```bash
npm run typecheck
npm run build     # one-off bundle via esbuild
npm run watch      # rebuild on change
```

- `src/background.ts` — the service worker; finds the active tab, requests `tabCapture` permission, creates the offscreen document.
- `src/offscreen.ts` — the only place with a real DOM in Manifest V3, so the only place that can run a `MediaRecorder`/`AudioContext`. Does the actual capture, mixing, WAV conversion, and upload.
- `src/popup.ts` — the UI: record/stop, live status (via `chrome.storage.session`, so it survives the popup closing mid-meeting), settings, and the finished transcript.
- `src/api.ts` / `src/wav.ts` — ported from the Mova Flow desktop app's own `renderer.ts`, so the upload protocol and the WAV encoder stay identical to what the host already expects.

## Status

Early (v0.1) — built and typechecked, but **not yet tested end-to-end against a live Google Meet call**. The riskiest part is Chrome's `tabCapture` + offscreen-document + microphone-permission interaction, which has had rough edges across Chrome versions historically. If recording doesn't start, check the service worker's console at `chrome://extensions` → the extension's **service worker** link, and the offscreen document's own console (same page, under "Inspect views").

## License

[Apache License 2.0](LICENSE).
