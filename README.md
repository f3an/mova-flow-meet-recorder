# Mova Flow Meet Recorder

A Chrome extension that records a Google Meet call — both sides of the conversation, not just what you hear — and sends it to a [Mova Flow](https://github.com/f3an/Mova-Flow) server on your network for transcription. No cloud, nothing leaves your LAN.

## How it works

1. On a Google Meet call, press **Record** — either the button this extension adds right into Meet's own call-controls toolbar (next to mic/camera), or the same button in the extension's popup.
2. It captures the tab's audio (everyone else on the call) *and* your microphone, mixed into one track — so the transcript covers the whole conversation, not just one side.
3. Press **Stop & transcribe**. The recording is converted to 16kHz mono WAV (the format Mova Flow's `whisper-cli.exe` actually reads) and uploaded to your configured Mova Flow host, exactly like the desktop app's own client role does — shared secret, short-lived bearer token, the same `/api/auth` → `/api/transcribe` → `/api/status` flow.
4. The transcript comes back in the popup — copy it or download it as `.txt`.

**If the host can't be reached** — not configured, `mova-flow.local` didn't resolve, the browser or OS is blocking local-network access (see [Troubleshooting](#troubleshooting)), or it's just offline — the recording is never discarded. It's saved to your Downloads folder as a `.wav` instead, and the popup tells you so; upload it manually from Mova Flow's own Upload tab once the host is reachable again.

The in-toolbar button (`src/content.ts`) targets an attribute Google's own code assigns Meet's control-bar region, since the toolbar's CSS classes are obfuscated and get reshuffled across Meet redesigns. If a redesign ever breaks it, the button just won't appear — the popup keeps working regardless, since it doesn't depend on Meet's DOM at all.

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
2. Try **⟲ Find host on network** first — every Mova Flow host also advertises itself as `mova-flow.local` (see the desktop app's mDNS discovery), so this often finds it with no typing at all. If it doesn't (unsigned local hostname resolution isn't 100% reliable on every OS, and this only works with exactly one host on the network), enter the host's IP and port manually — find these on the host's own Server tab.
3. Enter the access secret key, **Test connection**, then **Save**. Saving will ask Chrome for permission to reach that address.
4. On the first recording, Chrome will also ask for microphone permission — that's for your side of the conversation, not the meeting itself (the meeting's own audio comes from the tab, not the mic).

## Troubleshooting

**"Server not responding" / connection fails, even though the host is running:**

- **macOS: grant the browser Local Network access.** System Settings → Privacy & Security → **Local Network** → enable it for your browser (Chrome, Brave, etc.). This is a macOS-level permission, separate from anything in the extension or Chrome's own settings — Safari is exempt from it as an Apple app, which is why the same address can work in Safari and fail in every Chromium browser until this is granted.
- **Brave specifically may also gate this itself.** If macOS permission is already granted and it still fails, check `brave://flags` for a "Local Network Access" flag, or try a plain (non-Tor) Private Window to rule out a VPN/Tor routing all traffic away from the LAN.
- **Confirm you're on the same network as the host** — different Wi-Fi, a VPN, or a guest network with client isolation all make a LAN address unreachable regardless of any of the above.
- Whatever the cause, your recording is never lost while troubleshooting this — see the fallback below.

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
- `src/content.ts` — injects the record button into Meet's own toolbar; reads/writes the same `chrome.storage.session` status the popup uses, so both stay in sync.
- `src/api.ts` / `src/wav.ts` — ported from the Mova Flow desktop app's own `renderer.ts`, so the upload protocol and the WAV encoder stay identical to what the host already expects.

## Status

Early (v0.1) — built and typechecked, but **not yet tested end-to-end against a live Google Meet call**. The riskiest part is Chrome's `tabCapture` + offscreen-document + microphone-permission interaction, which has had rough edges across Chrome versions historically. If recording doesn't start, check the service worker's console at `chrome://extensions` → the extension's **service worker** link, and the offscreen document's own console (same page, under "Inspect views").

## License

[Apache License 2.0](LICENSE).
