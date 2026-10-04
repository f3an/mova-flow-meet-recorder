// Runs in an offscreen document — the only place in Manifest V3 with a real
// DOM, so it's the only place that can hold a MediaRecorder or an
// AudioContext. background.ts just hands this a tabCapture stream id and a
// start/stop signal; everything from mixing to uploading happens here.
import { transcribe } from './api';
import type { RecordingStatus, Settings, SpeakerTurn } from './state';
import { mergeToStereoWav, recordingToWav } from './wav';

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
async function getSpeakerTimeline(): Promise<SpeakerTurn[]> {
  return chrome.runtime.sendMessage({ target: 'background', type: 'get-speaker-timeline' });
}

interface StartMessage {
  target: 'offscreen';
  type: 'start-recording';
  streamId: string;
  tabTitle: string;
  recordingName: string;
  /** EXPERIMENTAL: no microphone — the "me" channel arrives from the Meet
   * page over a port instead (see content.ts / meetAudioHook.ts). */
  meetVoice?: boolean;
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
let callStartedAt = 0;
let meetVoice = false;

// The user's side, as recorded inside the Meet page — collected as it streams in.
interface MeRecording {
  startedAt: number;
  hasTrack: boolean;
  parts: Uint8Array<ArrayBuffer>[];
  stopped: Promise<void>;
}
let me: MeRecording | null = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'mova-flow-me') return;
  let markStopped: () => void = () => {};
  const recording: MeRecording = {
    startedAt: 0,
    hasTrack: false,
    parts: [],
    stopped: new Promise<void>((resolve) => (markStopped = resolve)),
  };
  me = recording;
  port.onMessage.addListener((msg: { type: string; startedAt?: number; hasTrack?: boolean; data?: string }) => {
    if (msg.type === 'started') {
      recording.startedAt = msg.startedAt ?? 0;
      recording.hasTrack = !!msg.hasTrack;
    } else if (msg.type === 'chunk' && msg.data) {
      recording.parts.push(Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0)));
    } else if (msg.type === 'stopped') {
      markStopped();
    }
  });
  // Tab closed or reloaded mid-call: keep whatever arrived.
  port.onDisconnect.addListener(() => markStopped());
});

async function startRecording(streamId: string, name: string, useMeetVoice: boolean): Promise<void> {
  recordingName = name;
  meetVoice = useMeetVoice;
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
    // In "voice from Meet" mode the microphone is never opened at all.
    const micStream = meetVoice ? null : await navigator.mediaDevices.getUserMedia({ audio: true });

    audioContext = new AudioContext();
    const destination = audioContext.createMediaStreamDestination();
    // Mic on the left channel, the call on the right — never mixed — so the
    // host can label each line as said by the user or by someone else
    // (whisper-cli --diarize picks whichever channel is louder per segment).
    // Merger inputs are mono, so a stereo tab stream gets downmixed into the
    // right channel rather than spilling into the left.
    const merger = audioContext.createChannelMerger(2);
    merger.connect(destination);

    const tabSource = audioContext.createMediaStreamSource(tabStream);
    tabSource.connect(merger, 0, 1);
    // getUserMedia({chromeMediaSource: 'tab'}) silently mutes the tab's normal
    // playback — reconnect it to the speakers or the user hears nothing for
    // the whole meeting.
    tabSource.connect(audioContext.destination);

    if (micStream) {
      const micSource = audioContext.createMediaStreamSource(micStream);
      // Deliberately NOT connected to audioContext.destination — that would
      // echo the user's own mic back out of their speakers.
      micSource.connect(merger, 0, 0);
    }

    tracks = [...tabStream.getTracks(), ...(micStream?.getTracks() ?? [])];
    chunks = [];
    recorder = new MediaRecorder(destination.stream, { mimeType: 'audio/webm;codecs=opus' });
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.start(1000);
    callStartedAt = Date.now();
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

/** The normal path is the call recording on its own (mic already on the left
 * channel). In "voice from Meet" mode the left channel is still empty here
 * and gets the page's recording merged in — or stays silent if the hook
 * never saw an outgoing track. */
async function buildWav(callWebm: Blob): Promise<Blob> {
  const recording = me;
  me = null;
  if (!meetVoice || !recording) return recordingToWav(callWebm);
  // The Meet tab stops its own recorder when it sees the status change;
  // give its last chunks a moment to arrive.
  await Promise.race([recording.stopped, new Promise((r) => setTimeout(r, 10000))]);
  if (!recording.parts.length) return recordingToWav(callWebm);
  const meWebm = new Blob(recording.parts, { type: 'audio/webm' });
  return mergeToStereoWav(callWebm, meWebm, (recording.startedAt - callStartedAt) / 1000);
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
    wav = await buildWav(webm);
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
    // Read only now, after the conversion above: that gives the Meet tab's
    // own final caption flush (see content.ts) time to land.
    const timeline = await getSpeakerTimeline().catch(() => []);
    const speakers = { mode: 'me-others', timeline } as const;
    const result = await transcribe(settings, wav, 'auto', `${recordingName}.wav`, speakers, (message) => {
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
  if (message.type === 'start-recording') void startRecording(message.streamId, message.recordingName, !!message.meetVoice);
  if (message.type === 'stop-recording') void stopRecordingAndTranscribe();
});
