// Runs in an offscreen document — the only place in Manifest V3 with a real
// DOM, so it's the only place that can hold a MediaRecorder or an
// AudioContext. background.ts just hands this a tabCapture stream id and a
// start/stop signal; everything from mixing to uploading happens here.
import { transcribe } from './api';
import type { RecordingStatus, Settings } from './state';
import { recordingToWav } from './wav';

// chrome.storage is unavailable in the offscreen document on at least some
// browsers (observed on Brave — chrome.storage itself is undefined here,
// even though it works fine from background.ts). Route reads/writes through
// the service worker instead of using ./state's chrome.storage-backed
// functions directly.
async function setStatus(status: RecordingStatus): Promise<void> {
  await chrome.runtime.sendMessage({ target: 'background', type: 'set-status', status });
}
async function getSettings(): Promise<Settings> {
  return chrome.runtime.sendMessage({ target: 'background', type: 'get-settings' });
}

interface StartMessage {
  target: 'offscreen';
  type: 'start-recording';
  streamId: string;
  tabTitle: string;
  recordingName: string;
}
interface StopMessage {
  target: 'offscreen';
  type: 'stop-recording';
}
type OffscreenMessage = StartMessage | StopMessage;

// The Mova Flow client app, if it's running on this same Mac, listens here
// for finished recordings — see localBridge.ts in the main Mova-Flow repo.
// 127.0.0.1-only by design, same as the app's own history endpoints, so this
// only ever works for an app on this machine, never a remote host.
const HISTORY_BRIDGE_URL = 'http://127.0.0.1:5057/extension/history';

let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let audioContext: AudioContext | null = null;
let tracks: MediaStreamTrack[] = [];
let recordingName = 'meet-record';

async function startRecording(streamId: string, name: string): Promise<void> {
  recordingName = name;
  // chromeMediaSource/chromeMediaSourceId aren't in the standard
  // MediaTrackConstraints type — this shape is Chrome-extension-specific.
  const tabStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
    },
  } as unknown as MediaStreamConstraints);

  try {
    // Getting the mic here (rather than in the popup) is deliberate: an
    // offscreen document is a normal page origin, so Chrome remembers the mic
    // grant for it the same way it would for a website, and every later
    // recording in this browser profile skips the permission prompt. But an
    // offscreen document has no visible surface to show that prompt on — if
    // the grant isn't already there (see onboarding.ts / the popup banner),
    // this throws NotAllowedError instead of prompting.
    const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    audioContext = new AudioContext();
    const destination = audioContext.createMediaStreamDestination();

    const tabSource = audioContext.createMediaStreamSource(tabStream);
    tabSource.connect(destination);
    // getUserMedia({chromeMediaSource: 'tab'}) silently mutes the tab's normal
    // playback — reconnect it to the speakers or the user hears nothing for
    // the whole meeting.
    tabSource.connect(audioContext.destination);

    const micSource = audioContext.createMediaStreamSource(micStream);
    // Deliberately NOT connected to audioContext.destination — that would
    // echo the user's own mic back out of their speakers.
    micSource.connect(destination);

    tracks = [...tabStream.getTracks(), ...micStream.getTracks()];
    chunks = [];
    recorder = new MediaRecorder(destination.stream, { mimeType: 'audio/webm;codecs=opus' });
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.start(1000);
  } catch (err) {
    // Anything past this point failing (mic permission, AudioContext,
    // MediaRecorder) must not leave tabStream's tracks running — that's what
    // keeps Chrome's tab-recording indicator lit forever with no way to stop
    // it, since `recorder` never gets set and stop-recording has nothing to
    // act on.
    for (const track of tabStream.getTracks()) track.stop();
    const message =
      err instanceof Error && err.name === 'NotAllowedError'
        ? "Microphone access isn't granted yet. Click the Mova Flow extension icon and allow microphone access, then try recording again."
        : `Couldn't start recording: ${(err as Error).message || err}`;
    await setStatus({ stage: 'error', message });
    window.close();
    throw err;
  }
}

/** Downloads.download() needs the "downloads" permission (already in
 * manifest.json) but nothing extra beyond that — silent (no saveAs dialog)
 * since this fires as an automatic fallback, not a user-initiated action. */
async function saveLocally(blob: Blob, ext: string, reason: string): Promise<void> {
  const filename = `${recordingName}.${ext}`;
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({ url, filename, saveAs: false });
  await setStatus({ stage: 'saved-locally', filename, reason });
}

/** Best-effort — the Mova Flow client app may not be running, or may be on a
 * different machine (the extension itself doesn't know or care where its
 * configured host actually lives). Never let this failing affect the
 * recording's own done/error status. */
async function reportToClientHistory(wav: Blob, language: string, text: string): Promise<void> {
  try {
    const form = new FormData();
    form.append('file', wav, `${recordingName}.wav`);
    form.append('filename', `${recordingName}.wav`);
    form.append('language', language);
    form.append('text', text);
    await fetch(HISTORY_BRIDGE_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(3000) });
  } catch {
    /* no local Mova Flow app to report to — that's fine */
  }
}

async function stopRecordingAndTranscribe(): Promise<void> {
  if (!recorder) return;
  const finished = new Promise<void>((resolve) => {
    recorder!.onstop = () => resolve();
  });
  recorder.stop();
  await finished;

  for (const track of tracks) track.stop();
  await audioContext?.close();
  audioContext = null;
  tracks = [];

  const webm = new Blob(chunks, { type: 'audio/webm' });
  chunks = [];
  recorder = null;

  await setStatus({ stage: 'processing', message: 'Converting recording...' });

  let wav: Blob;
  try {
    wav = await recordingToWav(webm);
  } catch {
    // Conversion itself failed (rare) — still don't lose an entire meeting
    // over it. The raw recording won't upload straight to Mova Flow (webm
    // isn't a format whisper-cli reads) but it's still audio the user has.
    await saveLocally(webm, 'webm', "Couldn't process the recording, so the raw audio was saved instead.");
    window.close();
    return;
  }

  try {
    const settings = await getSettings();
    const result = await transcribe(settings, wav, 'auto', `${recordingName}.wav`, (message) => {
      void setStatus({ stage: 'processing', message });
    });
    await setStatus({ stage: 'done', result: result.text, detectedLanguage: result.detectedLanguage });
    await reportToClientHistory(wav, result.detectedLanguage, result.text);
  } catch (err) {
    // Host not configured, discovery didn't find it, blocked by the
    // browser/OS (see README's troubleshooting notes), or genuinely
    // offline — whatever the reason, an hour of meeting audio is too
    // valuable to just discard on a network error.
    await saveLocally(wav, 'wav', `Couldn't reach the Mova Flow host (${(err as Error).message || 'connection failed'}).`);
  } finally {
    // Nothing keeps this document alive once the job is done — the next
    // recording creates a fresh one, per Chrome's own guidance on offscreen
    // document lifetime.
    window.close();
  }
}

chrome.runtime.onMessage.addListener((message: OffscreenMessage) => {
  if (message.target !== 'offscreen') return;
  if (message.type === 'start-recording') void startRecording(message.streamId, message.recordingName);
  if (message.type === 'stop-recording') void stopRecordingAndTranscribe();
});
