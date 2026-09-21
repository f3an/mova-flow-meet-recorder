import { checkConnection } from './api';
import { getSettings, getStatus, setMicGranted, RecordingStatus } from './state';
import { initSettingsPanel } from './settingsPanel';

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

// The offscreen document that does the actual recording has no visible
// surface, so it can never show the microphone permission prompt itself —
// this banner is the fallback for anyone who skipped/dismissed the
// onboarding tab that normally handles it right after install.
async function renderMicBannerIfNeeded(): Promise<void> {
  const micBanner = document.getElementById('micBanner');
  if (!micBanner) return;
  try {
    const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    if (status.state === 'granted') return;
  } catch {
    // permissions.query for 'microphone' isn't supported everywhere — fall
    // through and show the banner, the button below still works either way.
  }
  micBanner.innerHTML = `
    <div class="banner" style="margin-top: 8px;">
      Microphone access isn't enabled yet — recordings will miss your own voice.
      <div class="record-row" style="margin-top: 8px;">
        <button class="action secondary" id="grantMicBtn">Allow microphone access</button>
      </div>
    </div>
  `;
  document.getElementById('grantMicBtn')?.addEventListener('click', async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      void setMicGranted(true);
      micBanner.innerHTML = '';
    } catch {
      /* still denied — leave the banner up so they can retry */
    }
  });
}

// Checked on every popup open so a recording never gets to the "can't reach
// the host" surprise only after the call is already over — this is the same
// check the settings panel's own "Test connection" button runs.
async function renderHostBannerIfNeeded(): Promise<void> {
  const hostBanner = document.getElementById('hostBanner');
  if (!hostBanner) return;
  const settings = await getSettings();
  const { reachable, authOk } = await checkConnection(settings);
  if (reachable && authOk) {
    hostBanner.innerHTML = '';
    return;
  }
  const message = !reachable
    ? `Can't reach the Mova Flow host at ${settings.host}:${settings.port}.`
    : 'Host found, but the secret key is wrong.';
  hostBanner.innerHTML = `
    <div class="banner" style="margin-top: 8px;">
      ${escapeHtml(message)} Recordings will be saved to Downloads until this is fixed.
      <div class="record-row" style="margin-top: 8px;">
        <button class="action secondary" id="addHostBtn">Add host</button>
      </div>
    </div>
  `;
  document.getElementById('addHostBtn')?.addEventListener('click', () => {
    (document.getElementById('settingsDetails') as HTMLDetailsElement).open = true;
  });
}

function render(status: RecordingStatus): void {
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }

  if (status.stage === 'idle') {
    statusArea.innerHTML = `
      <div class="banner">Open a Google Meet call, then press Record.</div>
      <div id="micBanner"></div>
      <div id="hostBanner"></div>
      <div class="record-row" style="margin-top: 12px;">
        <button class="action" id="recordBtn">● Record meeting</button>
      </div>
    `;
    document.getElementById('recordBtn')?.addEventListener('click', startRecording);
    void renderMicBannerIfNeeded();
    void renderHostBannerIfNeeded();
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

async function init(): Promise<void> {
  await initSettingsPanel();
  render(await getStatus());
}

void init();
