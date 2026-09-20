import { checkConnection } from './api';
import { getSettings, getStatus, setSettings, RecordingStatus } from './state';

const statusArea = document.getElementById('statusArea') as HTMLDivElement;

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatElapsed(startedAt: number): string {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

let elapsedTimer: ReturnType<typeof setInterval> | null = null;

function render(status: RecordingStatus): void {
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }

  if (status.stage === 'idle') {
    statusArea.innerHTML = `
      <div class="banner">Open a Google Meet call, then press Record.</div>
      <div class="record-row" style="margin-top: 12px;">
        <button class="action" id="recordBtn">● Record meeting</button>
      </div>
    `;
    document.getElementById('recordBtn')?.addEventListener('click', startRecording);
    return;
  }

  if (status.stage === 'recording') {
    statusArea.innerHTML = `
      <div class="rec-status"><span class="rec-dot"></span><span id="elapsed">${formatElapsed(status.startedAt)}</span></div>
      <div class="tab-title">${escapeHtml(status.tabTitle)}</div>
      <div class="record-row"><button class="action danger" id="stopBtn">■ Stop &amp; transcribe</button></div>
    `;
    document.getElementById('stopBtn')?.addEventListener('click', stopRecording);
    elapsedTimer = setInterval(() => {
      const el = document.getElementById('elapsed');
      if (el) el.textContent = formatElapsed(status.startedAt);
    }, 1000);
    return;
  }

  if (status.stage === 'processing') {
    statusArea.innerHTML = `<div class="banner">${escapeHtml(status.message)}</div>`;
    return;
  }

  if (status.stage === 'done') {
    statusArea.innerHTML = `
      <div class="transcript-box">${escapeHtml(status.result)}</div>
      <div class="actions">
        <button class="action" id="copyBtn">Copy</button>
        <button class="action secondary" id="downloadBtn">Download .txt</button>
        <button class="action secondary" id="newRecordingBtn">New recording</button>
      </div>
    `;
    document.getElementById('copyBtn')?.addEventListener('click', (e) => {
      navigator.clipboard.writeText(status.result).then(() => {
        const btn = e.currentTarget as HTMLButtonElement;
        const original = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(() => (btn.textContent = original), 1200);
      });
    });
    document.getElementById('downloadBtn')?.addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([status.result], { type: 'text/plain' }));
      chrome.downloads.download({ url, filename: 'meet-transcript.txt', saveAs: true });
    });
    document.getElementById('newRecordingBtn')?.addEventListener('click', () =>
      render({ stage: 'idle' }),
    );
    return;
  }

  if (status.stage === 'saved-locally') {
    statusArea.innerHTML = `
      <div class="banner">
        ${escapeHtml(status.reason)}<br>
        Saved as <strong>${escapeHtml(status.filename)}</strong> in your Downloads folder.
        Once the host is reachable, upload it there directly from Mova Flow's own Upload tab.
      </div>
      <div class="actions">
        <button class="action secondary" id="openSettingsBtn">Check server settings</button>
        <button class="action" id="newRecordingBtn2">New recording</button>
      </div>
    `;
    document.getElementById('openSettingsBtn')?.addEventListener('click', () => {
      (document.getElementById('settingsDetails') as HTMLDetailsElement).open = true;
    });
    document.getElementById('newRecordingBtn2')?.addEventListener('click', () => render({ stage: 'idle' }));
    return;
  }

  if (status.stage === 'error') {
    statusArea.innerHTML = `
      <div class="error-text">${escapeHtml(status.message)}</div>
      <div class="record-row"><button class="action" id="retryBtn">Try again</button></div>
    `;
    document.getElementById('retryBtn')?.addEventListener('click', () => render({ stage: 'idle' }));
  }
}

async function startRecording(): Promise<void> {
  const res = await chrome.runtime.sendMessage({ type: 'start-recording' });
  const status = await getStatus();
  render(res?.ok === false ? { stage: 'error', message: res.error } : status);
}

async function stopRecording(): Promise<void> {
  render({ stage: 'processing', message: 'Stopping...' });
  await chrome.runtime.sendMessage({ type: 'stop-recording' });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.movaFlowStatus) {
    render(changes.movaFlowStatus.newValue ?? { stage: 'idle' });
  }
});

// ── Settings ─────────────────────────────────────────────────────────────
const hostInput = document.getElementById('hostInput') as HTMLInputElement;
const portInput = document.getElementById('portInput') as HTMLInputElement;
const secretInput = document.getElementById('secretInput') as HTMLInputElement;
const settingsResult = document.getElementById('settingsResult') as HTMLDivElement;

// mova-flow.local is a fixed alias every Mova Flow host also advertises
// alongside its own machine name (see discovery.ts in the main repo) — an
// extension has no mDNS API to actually browse the network with, so this is
// the closest thing to "auto-discovery" it can do: try the one well-known
// name directly and see if the OS resolves it. Only unambiguous with a
// single host on the LAN; a second one gets suffixed by mDNS and this won't
// find it.
document.getElementById('findHostBtn')?.addEventListener('click', async () => {
  const host = 'mova-flow.local';
  const port = Number(portInput.value) || 5000;

  settingsResult.textContent = 'Looking for mova-flow.local...';
  const granted = await chrome.permissions.request({ origins: [`http://${host}:${port}/*`] });
  if (!granted) {
    settingsResult.textContent = 'Permission to reach that host was denied.';
    return;
  }

  try {
    const res = await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) throw new Error();
    hostInput.value = host;
    portInput.value = String(port);
    settingsResult.textContent = 'Found it — enter the secret key and Save.';
  } catch {
    settingsResult.textContent =
      "Couldn't reach mova-flow.local. Make sure \"Expose to local network\" is on for the host, or enter its IP manually below.";
  }
});

document.getElementById('saveSettingsBtn')?.addEventListener('click', async () => {
  const host = hostInput.value.trim() || '127.0.0.1';
  const port = Number(portInput.value) || 5000;
  const secret = secretInput.value.trim();

  const granted = await chrome.permissions.request({ origins: [`http://${host}:${port}/*`] });
  if (!granted) {
    settingsResult.textContent = 'Permission to reach that host was denied.';
    return;
  }
  await setSettings({ host, port, secret });
  settingsResult.textContent = 'Saved.';
});

document.getElementById('testConnectionBtn')?.addEventListener('click', async () => {
  settingsResult.textContent = 'Checking...';
  const host = hostInput.value.trim() || '127.0.0.1';
  const port = Number(portInput.value) || 5000;
  const secret = secretInput.value.trim();
  const res = await checkConnection({ host, port, secret });
  settingsResult.textContent = !res.reachable
    ? 'Server not responding.'
    : !res.authOk
      ? 'Connection OK, but the secret key is wrong.'
      : 'Connection successful, authorization passed.';
});

async function init(): Promise<void> {
  const settings = await getSettings();
  hostInput.value = settings.host;
  portInput.value = String(settings.port);
  secretInput.value = settings.secret;

  render(await getStatus());
}

void init();
