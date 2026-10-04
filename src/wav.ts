// Mirrors Mova Flow's own renderer.ts encodeWav()/prepareFileForUpload() — the
// server's whisper-cli.exe only decodes audio via miniaudio, which doesn't
// support webm/opus (what MediaRecorder produces), so recordings are always
// resampled to 16kHz and re-encoded as plain WAV before upload. Unlike the
// app's Upload tab this keeps both channels: the recording is user-left,
// call-right (see offscreen.ts), and the host tells the speakers apart by
// which channel is louder. whisper itself still hears the mix.

/** Decodes a recorded Blob and resamples it to 16kHz stereo. */
export async function toStereoPCM16k(blob: Blob): Promise<AudioBuffer> {
  const arrayBuffer = await blob.arrayBuffer();
  const decodeCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer);
  } finally {
    await decodeCtx.close();
  }

  const targetRate = 16000;
  const offline = new OfflineAudioContext(2, Math.ceil(decoded.duration * targetRate), targetRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  return offline.startRendering();
}

/** Writes a minimal 16-bit PCM WAV (44-byte RIFF header), channels interleaved. */
export function encodeWav(buffer: AudioBuffer): Blob {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const numChannels = channels.length;
  const sampleRate = buffer.sampleRate;
  const blockAlign = numChannels * 2;
  const dataSize = buffer.length * blockAlign;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (const samples of channels) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([out], { type: 'audio/wav' });
}

export async function recordingToWav(blob: Blob): Promise<Blob> {
  const pcm = await toStereoPCM16k(blob);
  return encodeWav(pcm);
}

/** Decodes a recorded Blob and resamples it to 16kHz mono. */
async function toMonoPCM16k(blob: Blob): Promise<AudioBuffer> {
  const decodeCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(await blob.arrayBuffer());
  } finally {
    await decodeCtx.close();
  }
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  return offline.startRendering();
}

/** The call recording (right channel) plus
 * the user's side recorded separately inside the Meet page (see
 * meetAudioHook.ts), placed on the left channel at `meOffsetSec` — when the
 * page's recorder started relative to the call recorder. */
export async function mergeToStereoWav(callBlob: Blob, meBlob: Blob, meOffsetSec: number): Promise<Blob> {
  const call = await toStereoPCM16k(callBlob);
  const me = await toMonoPCM16k(meBlob);
  const out = new AudioBuffer({ numberOfChannels: 2, length: call.length, sampleRate: call.sampleRate });
  out.copyToChannel(call.getChannelData(1), 1);
  const left = new Float32Array(call.length);
  const shift = Math.round(meOffsetSec * call.sampleRate);
  const meData = me.getChannelData(0);
  for (let i = Math.max(0, shift); i < left.length && i - shift < meData.length; i++) left[i] = meData[i - shift];
  out.copyToChannel(left, 0);
  return encodeWav(out);
}
