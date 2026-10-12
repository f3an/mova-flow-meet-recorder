// Runs in an offscreen document — the only place in Manifest V3 with a real
// DOM, so it's the only place that can hold a MediaRecorder or an
// AudioContext. background.ts just hands this a tabCapture stream id and a
// start/stop signal; everything from mixing to handing the recording to the
// Mova Flow app (which transcribes it) happens here.
import { checkApp, handOverToApp, waitForApp } from './bridge';
import type { RecordingStatus, SpeakerTurn } from './state';
import { mergeToStereoWav, recordingToWav } from './wav';

// chrome.storage is unavailable in the offscreen document on at least some
// browsers (observed on Brave — chrome.storage itself is undefined here,
// even though it works fine from background.ts). Route reads/writes through
// the service worker instead of using ./state's chrome.storage-backed
// functions directly.
async function setStatus(status: RecordingStatus): Promise<void> {
  await chrome.runtime.sendMessage({ target: 'background', type: 'set-status', status });
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
}
interface StopMessage {
  target: 'offscreen';
  type: 'stop-recording';
}
type OffscreenMessage = StartMessage | StopMessage;

let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let audioContext: AudioContext | null = null;
let tracks: MediaStreamTrack[] = [];
let recordingName = 'call-record';
let callStartedAt = 0;
/** Between the start message and the recorder actually running. */
let starting: Promise<void> | null = null;

// The user's side of the call never comes from the microphone — the
// extension doesn't ask for it. It's the audio the call page itself sends to
// the other participants, recorded inside that page (callAudioHook.ts), relayed by
// content.ts over this port as it's recorded, and merged in as the left channel.
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
    } else if (msg.type === 'track') {
      recording.hasTrack = true;
    } else if (msg.type === 'chunk' && msg.data) {
      recording.parts.push(Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0)));
    } else if (msg.type === 'stopped') {
      markStopped();
    }
  });
  // Tab closed or reloaded mid-call: keep whatever arrived.
  port.onDisconnect.addListener(() => markStopped());
});

async function startRecording(streamId: string, name: string): Promise<void> {
  recordingName = name;
  // chromeMediaSource/chromeMediaSourceId aren't in the standard
  // MediaTrackConstraints type — this shape is Chrome-extension-specific.
  let tabStream: MediaStream;
  try {
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
      },
    } as unknown as MediaStreamConstraints);
  } catch (err) {
    // Chrome refused the tab's audio: say so, rather than leave the status at
    // "recording" with nothing behind it (Stop then had nothing to stop).
    await setStatus({ stage: 'error', message: `Chrome didn't allow recording this tab: ${(err as Error).message || err}` });
    window.close();
    return;
  }

  try {
    audioContext = new AudioContext();
    const destination = audioContext.createMediaStreamDestination();
    // The call goes on the right channel only; the left is filled in later
    // with the user's own side (see buildWav) — never mixed, so the host can
    // label each line as said by the user or by someone else (whisper-cli
    // --diarize picks whichever channel is louder per segment). Merger inputs
    // are mono, so a stereo tab stream gets downmixed into the right channel
    // rather than spilling into the left.
    const merger = audioContext.createChannelMerger(2);
    merger.connect(destination);

    const tabSource = audioContext.createMediaStreamSource(tabStream);
    tabSource.connect(merger, 0, 1);
    // getUserMedia({chromeMediaSource: 'tab'}) silently mutes the tab's normal
    // playback — reconnect it to the speakers or the user hears nothing for
    // the whole meeting.
    tabSource.connect(audioContext.destination);

    tracks = tabStream.getTracks();
    chunks = [];
    recorder = new MediaRecorder(destination.stream, { mimeType: 'audio/webm;codecs=opus' });
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.start(1000);
    callStartedAt = Date.now();
  } catch (err) {
    // Anything past this point failing (AudioContext, MediaRecorder) must not leave tabStream's tracks running — that's what
    // keeps Chrome's tab-recording indicator lit forever with no way to stop
    // it, since `recorder` never gets set and stop-recording has nothing to
    // act on.
    for (const track of tabStream.getTracks()) track.stop();
    const message = `Couldn't start recording: ${(err as Error).message || err}`;
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

/** The call recording with the user's side merged in on the left channel —
 * which stays silent if the user was muted the whole call. When the hook
 * never saw an outgoing track at all (a service that doesn't send audio over
 * WebRTC, or one it can't follow), there's no "me" side to speak of: the
 * recording goes out mono, as plain "everyone on the call". */
async function buildWav(callWebm: Blob): Promise<Blob> {
  const recording = me;
  me = null;
  if (!recording) return recordingToWav(callWebm);
  // The call tab stops its own recorder when it sees the status change;
  // give its last chunks a moment to arrive.
  await Promise.race([recording.stopped, new Promise((r) => setTimeout(r, 10000))]);
  if (!recording.parts.length || !recording.hasTrack) return recordingToWav(callWebm);
  const meWebm = new Blob(recording.parts, { type: 'audio/webm' });
  return mergeToStereoWav(callWebm, meWebm, (recording.startedAt - callStartedAt) / 1000);
}

/** The start of the "saved here instead" message: why the app didn't take it. */
async function whyNoApp(): Promise<string> {
  switch (await checkApp()) {
    case 'blocked':
      return "Your browser didn't let the extension reach the Mova Flow app (allow it in the extension's settings),";
    case 'outdated':
      return 'Mova Flow needs an update to 0.4.12 or newer to take recordings from this extension,';
    case 'refused':
      return "Mova Flow doesn't recognize this copy of the extension,";
    default:
      return "Mova Flow isn't running on this computer,";
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
    wav = await buildWav(webm);
  } catch {
    // Conversion itself failed (rare) — still don't lose an entire meeting
    // over it. The raw recording won't upload straight to Mova Flow (webm
    // isn't a format whisper-cli reads) but it's still audio the user has.
    await saveLocally(webm, 'webm', "Couldn't process the recording, so the raw audio was saved instead.");
    window.close();
    return;
  }

  // Read only now, after the conversion above: that gives the call tab's
  // own final caption flush (see content.ts) time to land.
  const timeline = await getSpeakerTimeline().catch(() => [] as SpeakerTurn[]);
  // The app keeps it in its History before anything else happens, then
  // transcribes it through its own host — a failure anywhere after this
  // point loses nothing.
  const recordingId = await handOverToApp(wav, `${recordingName}.wav`, { timeline, transcribe: true });
  if (!recordingId) {
    await saveLocally(wav, 'wav', `${await whyNoApp()} so the recording was saved here instead. Drop this file into Mova Flow's Upload tab once that's sorted.`);
    window.close();
    return;
  }

  try {
    const result = await waitForApp(recordingId, (message) => void setStatus({ stage: 'processing', message }));
    await setStatus({ stage: 'done', result: result.text, detectedLanguage: result.language });
  } catch (err) {
    const message = (err as Error).message || 'Transcription failed.';
    await setStatus({
      stage: 'error',
      message: /History/.test(message)
        ? message
        : `${message} The recording is safe in Mova Flow's History — press Transcribe there once this is fixed.`,
    });
  } finally {
    // Nothing keeps this document alive once the job is done — the next
    // recording creates a fresh one, per Chrome's own guidance on offscreen
    // document lifetime.
    window.close();
  }
}

chrome.runtime.onMessage.addListener((message: OffscreenMessage, _sender, sendResponse) => {
  if (message.target !== 'offscreen') return;
  if (message.type === 'start-recording') {
    starting = startRecording(message.streamId, message.recordingName)
      .catch(() => {})
      .finally(() => (starting = null));
  }
  if (message.type === 'stop-recording') {
    // Answered right away: background.ts needs to know whether there was a
    // recording here at all, not wait for the upload.
    sendResponse({ recording: !!recorder || !!starting });
    void (starting ?? Promise.resolve()).then(() => stopRecordingAndTranscribe());
  }
});
