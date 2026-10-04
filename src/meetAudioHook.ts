// Runs in Meet's own page context ("world": "MAIN" in
// manifest.json), before any of Meet's scripts, so it can see the audio
// track Meet actually sends to the other participants: after Meet's own
// processing, and silent whenever the user is muted in Meet. That track
// becomes the "me" channel — the extension never opens the microphone itself.
//
// Everything here leans on standard WebRTC entry points (addTrack,
// addTransceiver, replaceTrack), not on Meet internals — but which sender
// is "the mic" is still an assumption: the last audio track Meet attached.
//
// Talks to the isolated content script (content.ts) over window.postMessage:
//   ← { source: 'mova-flow', type: 'me-start' | 'me-stop' }
//   → { source: 'mova-flow-page', type: 'me-started', startedAt, hasTrack }
//   → { source: 'mova-flow-page', type: 'me-chunk', data: ArrayBuffer }
//   → { source: 'mova-flow-page', type: 'me-stopped' }

const FROM_EXTENSION = 'mova-flow';
const TO_EXTENSION = 'mova-flow-page';

let sentTrack: MediaStreamTrack | null = null;

let ctx: AudioContext | null = null;
let dest: MediaStreamAudioDestinationNode | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let recorder: MediaRecorder | null = null;

function post(message: Record<string, unknown>, transfer: Transferable[] = []): void {
  window.postMessage({ source: TO_EXTENSION, ...message }, window.location.origin, transfer);
}

/** Points the recording at whatever track Meet is sending right now. The
 * recorder itself keeps running across swaps (device change, mute done via
 * replaceTrack(null)) — only its input changes. */
function attach(track: MediaStreamTrack | null): void {
  source?.disconnect();
  source = null;
  if (!ctx || !dest || !track || track.readyState === 'ended') return;
  source = ctx.createMediaStreamSource(new MediaStream([track]));
  source.connect(dest);
}

function noteSentTrack(track: MediaStreamTrack | null | undefined): void {
  if (track && track.kind !== 'audio') return;
  sentTrack = track ?? null;
  attach(sentTrack);
}

const pc = RTCPeerConnection.prototype;

const originalAddTrack = pc.addTrack;
pc.addTrack = function (this: RTCPeerConnection, track: MediaStreamTrack, ...streams: MediaStream[]) {
  const sender = originalAddTrack.call(this, track, ...streams);
  if (track.kind === 'audio') noteSentTrack(track);
  return sender;
};

const originalAddTransceiver = pc.addTransceiver;
pc.addTransceiver = function (
  this: RTCPeerConnection,
  trackOrKind: MediaStreamTrack | string,
  init?: RTCRtpTransceiverInit,
) {
  const transceiver = originalAddTransceiver.call(this, trackOrKind, init);
  if (typeof trackOrKind !== 'string' && trackOrKind.kind === 'audio') noteSentTrack(trackOrKind);
  return transceiver;
};

const originalReplaceTrack = RTCRtpSender.prototype.replaceTrack;
RTCRtpSender.prototype.replaceTrack = function (this: RTCRtpSender, track: MediaStreamTrack | null) {
  // replaceTrack(null) on the audio sender is one way Meet mutes — record
  // that as silence rather than keeping the old track attached.
  if (track?.kind === 'audio' || (track === null && this.track?.kind === 'audio')) noteSentTrack(track);
  return originalReplaceTrack.call(this, track);
};

async function startMe(): Promise<void> {
  if (recorder) return;
  ctx = new AudioContext();
  // Meet's page already has user activation from joining the call, so this
  // normally starts running straight away.
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  dest = ctx.createMediaStreamDestination();
  attach(sentTrack);

  recorder = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus' });
  recorder.ondataavailable = async (e) => {
    if (e.data.size === 0) return;
    const data = await e.data.arrayBuffer();
    post({ type: 'me-chunk', data }, [data]);
  };
  recorder.onstop = () => {
    // ondataavailable for the last chunk fires before onstop, but its
    // arrayBuffer() is async — let it post first.
    setTimeout(() => post({ type: 'me-stopped' }), 0);
  };
  recorder.start(1000);
  post({ type: 'me-started', startedAt: Date.now(), hasTrack: sentTrack !== null });
}

function stopMe(): void {
  if (!recorder) {
    post({ type: 'me-stopped' });
    return;
  }
  recorder.stop();
  recorder = null;
  source?.disconnect();
  source = null;
  void ctx?.close();
  ctx = null;
  dest = null;
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.source !== FROM_EXTENSION) return;
  if (event.data.type === 'me-start') void startMe();
  if (event.data.type === 'me-stop') stopMe();
});
