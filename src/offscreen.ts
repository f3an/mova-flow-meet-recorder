// Runs in an offscreen document — the only place in Manifest V3 with a real
// DOM, so it's the only place that can hold a MediaRecorder or an
// AudioContext. background.ts just hands this a tabCapture stream id and a
// start/stop signal; everything from mixing to uploading happens here.
import { transcribe } from './api';
import { getSettings, setStatus } from './state';
import { recordingToWav } from './wav';

interface StartMessage {
  target: 'offscreen';
  type: 'start-recording';
  streamId: string;
  tabTitle: string;
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

async function startRecording(streamId: string): Promise<void> {
  // chromeMediaSource/chromeMediaSourceId aren't in the standard
  // MediaTrackConstraints type — this shape is Chrome-extension-specific.
  const tabStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
    },
  } as unknown as MediaStreamConstraints);

  // Getting the mic here (rather than in the popup) is deliberate: an
  // offscreen document is a normal page origin, so Chrome remembers the mic
  // grant for it the same way it would for a website, and every later
  // recording in this browser profile skips the permission prompt.
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
}

/** Downloads.download() needs the "downloads" permission (already in
 * manifest.json) but nothing extra beyond that — silent (no saveAs dialog)
 * since this fires as an automatic fallback, not a user-initiated action. */
async function saveLocally(blob: Blob, ext: string, reason: string): Promise<void> {
  const filename = `mova-flow-recording-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({ url, filename, saveAs: false });
  await setStatus({ stage: 'saved-locally', filename, reason });
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
    const result = await transcribe(settings, wav, 'auto', (message) => {
      void setStatus({ stage: 'processing', message });
    });
    await setStatus({ stage: 'done', result: result.text, detectedLanguage: result.detectedLanguage });
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
  if (message.type === 'start-recording') void startRecording(message.streamId);
  if (message.type === 'stop-recording') void stopRecordingAndTranscribe();
});
