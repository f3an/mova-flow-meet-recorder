// Popups are destroyed the moment they lose focus, but a recording can run
// for an entire meeting — state has to live somewhere that survives the
// popup closing and reopening. chrome.storage.session is exactly that: kept
// in memory for the browser session, not persisted to disk, and readable
// from the popup, the background worker, and the offscreen document alike.

export type RecordingStatus =
  | { stage: 'idle' }
  | { stage: 'recording'; tabTitle: string; startedAt: number }
  | { stage: 'processing'; message: string }
  | { stage: 'done'; result: string; detectedLanguage: string }
  | { stage: 'error'; message: string };

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
  await chrome.storage.session.set({ [STATUS_KEY]: status });
}

export async function getSettings(): Promise<Settings> {
  const { [SETTINGS_KEY]: settings } = await chrome.storage.local.get(SETTINGS_KEY);
  return settings ?? { host: '127.0.0.1', port: 5000, secret: '' };
}

export async function setSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}
