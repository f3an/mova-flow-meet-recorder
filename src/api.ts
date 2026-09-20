// Talks to a Mova Flow host exactly like the Electron app's own client role
// does (see server.ts / renderer.ts in the main Mova-Flow repo) — this
// extension is just another client on the network, authenticating with the
// same shared secret and short-lived bearer token.
import type { Settings } from './state';

export interface TranscribeResult {
  text: string;
  detectedLanguage: string;
}

export type ProgressCb = (message: string) => void;

function baseUrl(settings: Settings): string {
  return `http://${settings.host}:${settings.port}`;
}

async function fetchToken(settings: Settings): Promise<string> {
  const res = await fetch(`${baseUrl(settings)}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: settings.secret || '' }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Auth failed (${res.status})`);
  }
  const data = await res.json();
  return data.token as string;
}

/** Checks the host is reachable and the secret is correct — mirrors the
 * Electron client's "Test connection" button. */
export async function checkConnection(settings: Settings): Promise<{ reachable: boolean; authOk: boolean }> {
  try {
    const res = await fetch(`${baseUrl(settings)}/`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { reachable: false, authOk: false };
    await fetchToken(settings);
    return { reachable: true, authOk: true };
  } catch {
    return { reachable: false, authOk: false };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function transcribe(
  settings: Settings,
  wav: Blob,
  language: string,
  onProgress: ProgressCb,
): Promise<TranscribeResult> {
  const base = baseUrl(settings);
  const token = await fetchToken(settings);

  onProgress('Uploading recording...');
  const form = new FormData();
  form.append('file', wav, 'meet-recording.wav');
  form.append('language', language);

  const uploadRes = await fetch(`${base}/api/transcribe`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const uploadData = await uploadRes.json();
  if (uploadData.error) throw new Error(uploadData.error);
  const jobId = uploadData.job_id as string;

  // Same 1.5s poll interval as the Electron app's own Upload tab.
  for (;;) {
    await sleep(1500);
    const statusRes = await fetch(`${base}/api/status/${jobId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await statusRes.json();

    if (data.status === 'error') throw new Error(data.error || 'Transcription failed');
    if (data.status === 'processing') {
      onProgress(data.progress || 'Transcribing...');
      continue;
    }
    if (data.status === 'done') {
      return { text: data.result as string, detectedLanguage: data.detectedLanguage || 'auto' };
    }
  }
}
