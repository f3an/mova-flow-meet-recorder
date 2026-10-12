// Runs in the call page's own context ("world": "MAIN" in manifest.json),
// before any of its scripts, so it can see the audio track the call service
// actually sends to the other participants: after its own processing, and
// silent whenever the user is muted. That track becomes the "me" channel —
// the extension never opens the microphone itself.
//
// Everything here leans on standard WebRTC entry points (addTrack,
// addTransceiver, replaceTrack), not on any one service's internals, which is
// what lets the same hook serve Meet, Teams, Jitsi and the rest — but which
// sender is "the mic" is still an assumption: the last audio track the page
// attached.
//
// Zoom's web client sends no audio track at all: it encodes the microphone
// itself (an AudioWorklet + WebAssembly) and ships the result over a WebRTC
// data channel ("ZoomWebclientAudioDataChannel"). There — and only there —
// the user's side is the microphone track the page itself got from
// getUserMedia: still the page's own, never opened by the extension, but raw.
// Zoom mutes by no longer encoding, leaving that track live and enabled, so
// muting is read off Zoom's mic button (micLive) and the recording is
// silenced for as long as it lasts.
//
// Talks to the isolated content script (content.ts) over window.postMessage:
//   ← { source: 'mova-flow', type: 'me-start' | 'me-stop' }
//   → { source: 'mova-flow-page', type: 'me-started', startedAt, hasTrack }
//   → { source: 'mova-flow-page', type: 'me-track' }  (a track got attached)
//   → { source: 'mova-flow-page', type: 'me-chunk', data: ArrayBuffer }
//   → { source: 'mova-flow-page', type: 'me-stopped' }

const FROM_EXTENSION = 'mova-flow';
const TO_EXTENSION = 'mova-flow-page';

let sentTrack: MediaStreamTrack | null = null;
/** The page has sent audio over WebRTC at some point — then its microphone is
 * never the fallback, even while nothing is being sent: that's how Meet and
 * others mute (replaceTrack(null)), and it must stay silent. */
let sendsOverWebRTC = false;
/** The last live audio track the page got from getUserMedia (the fallback). */
let micTrack: MediaStreamTrack | null = null;

let ctx: AudioContext | null = null;
let dest: MediaStreamAudioDestinationNode | null = null;
let source: MediaStreamAudioSourceNode | null = null;
/** Between the source and the recording: 0 while the user is muted (only
 * ever for the getUserMedia fallback — a sent track is silent by itself). */
let gate: GainNode | null = null;
let muteTimer: number | null = null;
let attached: 'sent' | 'mic' | null = null;
let recorder: MediaRecorder | null = null;

function log(...args: unknown[]): void {
  console.debug('[mova-flow]', ...args);
}

const IS_ZOOM = /(^|\.)zoom\.us$/.test(location.hostname);

/** Whether the page shows the user's microphone as live — the only sign of
 * muting there is for the getUserMedia fallback, since Zoom mutes by no
 * longer encoding, leaving the track itself untouched (live, enabled). Zoom's
 * audio button, observed Oct 2026 — the icon is named for what a click does:
 *   live:   button.join-audio-container__btn > div.audio-voip-active-icon > svg.SvgAudioMute
 *   muted:  button.join-audio-container__btn > svg.SvgAudioUnmute(Hovered)
 * Class names, not the button's text, so any UI language reads the same. Only
 * a positive "live" counts: muted, not joined to audio yet, or a redesign this
 * doesn't recognize all leave the user's side silent — at worst it's missing,
 * never recorded while the others couldn't hear it. */
function micLive(): boolean {
  if (!IS_ZOOM) return false;
  const button = document.querySelector('.join-audio-container__btn');
  if (!button) return false;
  if (button.querySelector('svg[class^="SvgAudioUnmute"]')) return false;
  return !!button.querySelector('.audio-voip-active-icon, svg.SvgAudioMute');
}

function updateGate(): void {
  if (!gate) return;
  const muted = attached === 'mic' && (micTrack?.enabled === false || !micLive());
  gate.gain.value = muted ? 0 : 1;
}

function post(message: Record<string, unknown>, transfer: Transferable[] = []): void {
  window.postMessage({ source: TO_EXTENSION, ...message }, window.location.origin, transfer);
}

/** Points the recording at whatever track the page is sending right now. The
 * recorder itself keeps running across swaps (device change, mute done via
 * replaceTrack(null)) — only its input changes. */
function attach(track: MediaStreamTrack | null): void {
  source?.disconnect();
  source = null;
  attached = null;
  if (!ctx || !gate) return;
  // What the page sends wins; its own microphone only on Zoom, which never
  // sends audio over WebRTC — anywhere else the microphone may well be open
  // before anything is sent (Meet's lobby preview, joining muted), and it
  // isn't what the others hear.
  const sent = track && track.readyState !== 'ended' ? track : null;
  const pick = sent ?? (IS_ZOOM && !sendsOverWebRTC && micTrack?.readyState === 'live' ? micTrack : null);
  if (!pick) return;
  attached = pick === sent ? 'sent' : 'mic';
  source = ctx.createMediaStreamSource(new MediaStream([pick]));
  source.connect(gate);
  updateGate();
  log('recording your side from', attached === 'sent' ? 'the track the page sends' : "the page's microphone");
  post({ type: 'me-track' });
}

function noteSentTrack(track: MediaStreamTrack | null | undefined): void {
  if (track && track.kind !== 'audio') return;
  if (track) sendsOverWebRTC = true;
  sentTrack = track ?? null;
  attach(sentTrack);
}

// The fallback: remember the microphone the page opens for itself.
const media = navigator.mediaDevices;
if (media?.getUserMedia) {
  const originalGetUserMedia = media.getUserMedia.bind(media);
  media.getUserMedia = async function (constraints?: MediaStreamConstraints) {
    const stream = await originalGetUserMedia(constraints);
    const track = stream.getAudioTracks()[0];
    if (track) {
      micTrack = track;
      log('page opened its microphone');
      // Only matters while nothing better is attached.
      if (recorder && attached !== 'sent') attach(sentTrack);
    }
    return stream;
  };
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
  // replaceTrack(null) on the audio sender is one way calls mute — record
  // that as silence rather than keeping the old track attached.
  if (track?.kind === 'audio' || (track === null && this.track?.kind === 'audio')) noteSentTrack(track);
  return originalReplaceTrack.call(this, track);
};

async function startMe(): Promise<void> {
  if (recorder) return;
  ctx = new AudioContext();
  // The page already has user activation from joining the call, so this
  // normally starts running straight away.
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  dest = ctx.createMediaStreamDestination();
  gate = ctx.createGain();
  gate.connect(dest);
  attach(sentTrack);
  muteTimer = window.setInterval(updateGate, 300);

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
  post({ type: 'me-started', startedAt: Date.now(), hasTrack: attached !== null });
  if (!attached) log('no outgoing audio or microphone seen in this frame yet');
}

function stopMe(): void {
  if (!recorder) {
    post({ type: 'me-stopped' });
    return;
  }
  recorder.stop();
  recorder = null;
  if (muteTimer !== null) window.clearInterval(muteTimer);
  muteTimer = null;
  source?.disconnect();
  source = null;
  attached = null;
  gate = null;
  void ctx?.close();
  ctx = null;
  dest = null;
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.source !== FROM_EXTENSION) return;
  if (event.data.type === 'me-start') void startMe();
  if (event.data.type === 'me-stop') stopMe();
});
