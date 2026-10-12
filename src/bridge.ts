// Everything goes through the Mova Flow app on this same computer — see
// localBridge.ts in the main Mova-Flow repo. The app transcribes what this
// extension records, through its own host connection and vocabulary, into its
// own History; the extension has no host settings of its own. 127.0.0.1-only
// by design, so it only ever reaches an app on this machine.
import type { SpeakerTurn } from './state';

const BRIDGE = 'http://127.0.0.1:5057/extension';

// Plain CORS on purpose: the extension has no host permission for
// 127.0.0.1, because with one Chrome leaves the Origin header off its GETs,
// and Origin is how the app tells its own extension apart (app 0.4.12+
// answers with the CORS headers). The price is Chrome's Local Network Access
// permission, which applies to extensions without a host permission — see
// localNetworkAccess() below.
function read(path: string, timeoutMs: number): Promise<Response> {
  return fetch(`${BRIDGE}/${path}`, { signal: AbortSignal.timeout(timeoutMs) });
}

export type LocalNetworkAccess = 'granted' | 'prompt' | 'denied' | 'unknown';

/** Whether the browser lets this extension reach apps on this computer.
 * Chrome has renamed the permission as it went (local-network-access, then
 * split into local-network and loopback-network — 127.0.0.1 is the latter);
 * a browser without it at all doesn't restrict anything. */
export async function localNetworkAccess(): Promise<LocalNetworkAccess> {
  for (const name of ['loopback-network', 'local-network-access', 'local-network']) {
    try {
      return (await navigator.permissions.query({ name } as unknown as PermissionDescriptor)).state;
    } catch {
      // Not a permission this browser knows — try the next name.
    }
  }
  return 'unknown';
}

export interface AppStatus {
  version: string;
  role: 'host' | 'client';
  /** The host a client sends to; null on a host (it transcribes itself). */
  host: string | null;
  serverStage: string;
}

export type AppCheck = AppStatus | 'refused' | 'outdated' | 'blocked' | null;

/** The Mova Flow app on this computer; 'blocked' when the browser won't let
 * the extension reach it (Local Network Access, turned down); 'outdated' when it's older than 0.4.12 (no CORS
 * headers, so the browser hides its answers); 'refused' when it's running but
 * doesn't trust this copy of the extension (only the Web Store build, and IDs
 * listed in the app's config.json as trusted_extension_ids, are let in); null
 * when it isn't running at all (or is older than 0.4.11, which had no
 * /extension/status). */
export async function checkApp(): Promise<AppCheck> {
  try {
    const res = await read('status', 1500);
    if (res.status === 403) return 'refused';
    if (!res.ok) return null;
    return (await res.json()) as AppStatus;
  } catch {
    // The same failed fetch, whatever the reason. A no-cors probe tells them
    // apart: it doesn't need CORS headers, but is held to Local Network Access
    // all the same — so if it gets through, the browser lets us reach the app
    // and the app is just too old to send those headers.
    const reached = await fetch(`${BRIDGE}/status`, { mode: 'no-cors', signal: AbortSignal.timeout(1500) })
      .then(() => true)
      .catch(() => false);
    if (reached) return 'outdated';
    // Nothing got through: either nothing is listening, or the browser
    // stopped it. Only a permission that's been turned down is blamed —
    // 'prompt' also just means "never came up", which is every browser that
    // doesn't hold extensions to it.
    return (await localNetworkAccess()) === 'denied' ? 'blocked' : null;
  }
}

export async function getAppStatus(): Promise<AppStatus | null> {
  const status = await checkApp();
  return typeof status === 'string' ? null : status;
}

export function describeApp(status: AppStatus): string {
  return status.role === 'host'
    ? `Mova Flow ${status.version} transcribes on this computer.`
    : `Mova Flow ${status.version} sends recordings to the host at ${status.host}.`;
}

/** Hands a finished WAV to the app, which keeps it in its History until it is
 * transcribed (so nothing is lost if the host is down) and, with
 * `transcribe`, starts on it right away. Returns the app's id for it, or null
 * when the app isn't there to take it. */
export async function handOverToApp(
  wav: Blob,
  filename: string,
  options: { timeline?: SpeakerTurn[]; transcribe?: boolean; language?: string } = {},
): Promise<string | null> {
  try {
    const form = new FormData();
    form.append('file', wav, filename);
    form.append('filename', filename);
    if (options.timeline?.length) form.append('speaker_timeline', JSON.stringify(options.timeline));
    if (options.transcribe) form.append('transcribe', '1');
    if (options.language) form.append('language', options.language);
    // Local disk, but an hour of audio is a couple of hundred MB.
    const res = await fetch(`${BRIDGE}/recording`, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) return null;
    return ((await res.json()) as { id?: string }).id ?? null;
  } catch {
    return null;
  }
}

/** Asks the app to transcribe a recording already waiting in its History. */
export async function transcribeInApp(id: string, language?: string): Promise<void> {
  const res = await fetch(`${BRIDGE}/transcribe/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ language }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error('Mova Flow could not start transcribing it.');
}

export interface TranscribeResult {
  text: string;
  language: string;
}

const POLL_MS = 2000;
// The app itself waits out a busy or briefly unreachable host; this only
// covers the app being unreachable (quit mid-job).
const APP_GONE_MS = 60_000;

/** Follows a transcription the app is running until it's done. */
export async function waitForApp(id: string, onProgress: (message: string) => void): Promise<TranscribeResult> {
  let failingSince = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let job: { stage: string; message?: string; text?: string; language?: string };
    try {
      const res = await read(`jobs/${encodeURIComponent(id)}`, 5000);
      if (!res.ok) throw new Error(String(res.status));
      job = await res.json();
    } catch {
      if (!failingSince) failingSince = Date.now();
      if (Date.now() - failingSince > APP_GONE_MS) {
        throw new Error("Lost touch with the Mova Flow app. The recording waits in its History — press Transcribe there.");
      }
      continue;
    }
    failingSince = 0;
    if (job.stage === 'done') return { text: job.text ?? '', language: job.language ?? 'auto' };
    if (job.stage === 'error') throw new Error(job.message || 'Transcription failed.');
    onProgress(job.message || 'Transcribing...');
  }
}

// ── the app's History (GET/DELETE /extension/history) ──────────────────────
export interface AppHistoryItem {
  id: string;
  filename: string;
  language: string;
  createdAt: number;
  preview: string;
}
export interface AppPendingRecording {
  id: string;
  name: string;
  createdAt: number;
  seconds: number;
  recording: boolean;
}
export interface AppHistory {
  source: 'host' | 'client';
  items: AppHistoryItem[];
  pending: AppPendingRecording[];
}

export async function fetchAppHistory(): Promise<AppHistory | null> {
  try {
    const res = await read('history', 1500);
    if (!res.ok) return null;
    return (await res.json()) as AppHistory;
  } catch {
    return null;
  }
}

export async function fetchAppHistoryText(id: string): Promise<string> {
  const res = await read(`history/${encodeURIComponent(id)}/text`, 5000);
  if (!res.ok) throw new Error('Transcript not found in the app.');
  return ((await res.json()) as { text: string }).text;
}

export async function deleteAppHistoryEntry(id: string): Promise<void> {
  await fetch(`${BRIDGE}/history/${encodeURIComponent(id)}`, { method: 'DELETE', signal: AbortSignal.timeout(5000) });
}
