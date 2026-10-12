// The record/stop/result view — shared by the popup and the side panel's
// Record tab, which render it into their own #statusArea.
import { renderAppStatus } from './appStatus';
import { grantWays } from './grantHelp';
import { getStatus, RecordingStatus } from './state';

let statusArea: HTMLElement;

export function escapeHtml(str: string): string {
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

// Checked on every open, so "the app isn't running" shows up before the
// call rather than after it — without the app the recording only goes to
// Downloads.
async function renderHostBannerIfNeeded(): Promise<void> {
  const hostBanner = document.getElementById('hostBanner');
  if (hostBanner) await renderAppStatus(hostBanner, true);
}

function render(status: RecordingStatus): void {
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }

  if (status.stage === 'idle') {
    statusArea.innerHTML = `
      <div class="banner">Open a call in Google Meet, Teams, Zoom (in the browser) or Jitsi, then press Record.</div>
      <div id="hostBanner"></div>
      <div class="record-row" style="margin-top: 12px;">
        <button class="action" id="recordBtn">● Record meeting</button>
      </div>
    `;
    document.getElementById('recordBtn')?.addEventListener('click', startRecording);
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

  if (status.stage === 'awaiting-grant') {
    statusArea.innerHTML = `
      <div class="banner">
        <strong>One more step to start recording</strong><br>
        ${grantWays(status.shortcut, status.iconGrants)}
      </div>
      <div class="record-row"><button class="action secondary" id="cancelBtn">Cancel</button></div>
    `;
    document.getElementById('cancelBtn')?.addEventListener('click', () => {
      void chrome.runtime.sendMessage({ type: 'cancel-pending' });
    });
    return;
  }

  if (status.stage === 'processing') {
    statusArea.innerHTML = `<div class="banner">${escapeHtml(status.message)}</div>`;
    return;
  }

  if (status.stage === 'done' && !status.result.trim()) {
    statusArea.innerHTML = `
      <div class="banner">
        <strong>No speech in this recording</strong><br>
        Whisper didn't find anything said in it. If you did speak, check that you weren't muted in the call
        and that the call page can use your microphone — and that there was someone else on the call for the
        other side.
      </div>
      <div class="record-row"><button class="action" id="newRecordingBtn">New recording</button></div>
    `;
    document.getElementById('newRecordingBtn')?.addEventListener('click', () => render({ stage: 'idle' }));
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
      chrome.downloads.download({ url, filename: 'call-transcript.txt', saveAs: true });
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
      </div>
      <div id="hostBanner"></div>
      <div class="actions">
        <button class="action" id="newRecordingBtn2">New recording</button>
      </div>
    `;
    void renderHostBannerIfNeeded();
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


export async function mountRecordView(area: HTMLElement): Promise<void> {
  statusArea = area;
  chrome.storage.onChanged.addListener((changes, storageArea) => {
    if (storageArea === 'session' && changes.movaFlowStatus) {
      render(changes.movaFlowStatus.newValue ?? { stage: 'idle' });
    }
  });
  render(await getStatus());
}
