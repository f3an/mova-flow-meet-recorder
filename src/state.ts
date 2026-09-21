// Popups are destroyed the moment they lose focus, but a recording can run
// for an entire meeting — state has to live somewhere that survives the
// popup closing and reopening. chrome.storage.session is exactly that: kept
// in memory for the browser session, not persisted to disk, and readable
// from the popup, the background worker, and the offscreen document alike.

export type RecordingStatus =
  | { stage: 'idle' }
  | { stage: 'recording'; tabTitle: string; startedAt: number; recordingName: string }
  | { stage: 'processing'; message: string }
  | { stage: 'done'; result: string; detectedLanguage: string }
  | { stage: 'error'; message: string }
  // The host was unreachable (not configured, discovery didn't find it,
  // blocked by the browser/OS, actually offline...) but the recording itself
  // is too valuable to just discard, so it went to Downloads instead.
  | { stage: 'saved-locally'; filename: string; reason: string };

export interface Settings {
  host: string;
  port: number;
  secret: string;
}

const STATUS_KEY = 'movaFlowStatus';
const SETTINGS_KEY = 'movaFlowSettings';

export async function getStatus(): Promise<RecordingStatus> {
  const { [STATUS_KEY]: status } = await chrome.storage.session.get(STATUS_KEY);
  return status ?? { stage: 'idle' };
}

export async function setStatus(status: RecordingStatus): Promise<void> {
  try {
    await chrome.storage.session.set({ [STATUS_KEY]: status });
  } catch (err) {
    // Never let a UI status write take down the recording/transcription
    // flow itself — worst case the popup/button falls out of sync, which is
    // recoverable, versus losing the rest of the meeting's audio.
    console.error('[mova-flow] setStatus failed:', err);
  }
}

export async function getSettings(): Promise<Settings> {
  const { [SETTINGS_KEY]: settings } = await chrome.storage.local.get(SETTINGS_KEY);
  return settings ?? { host: '127.0.0.1', port: 5000, secret: '' };
}

export async function setSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

// Whether the offscreen document's origin has ever been granted microphone
// access — a real permissions.query() check would ask about the CURRENT
// page's origin, not the extension's, so it can't tell us this. Set once,
// from a context that can actually request the grant (onboarding.ts, or the
// popup banner) — see MIC_GRANTED_KEY's readers for why this matters.
const MIC_GRANTED_KEY = 'movaFlowMicGranted';

export async function getMicGranted(): Promise<boolean> {
  const { [MIC_GRANTED_KEY]: granted } = await chrome.storage.local.get(MIC_GRANTED_KEY);
  return granted === true;
}

export async function setMicGranted(granted: boolean): Promise<void> {
  await chrome.storage.local.set({ [MIC_GRANTED_KEY]: granted });
}
