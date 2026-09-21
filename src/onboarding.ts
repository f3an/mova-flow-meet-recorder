// Opened once on install (see chrome.runtime.onInstalled in background.ts),
// and reachable any time after from the popup's mic banner or the Meet
// button's "open-popup" fallback — this is the one full walkthrough, not
// just a permission prompt: connecting to a host and understanding where
// the record button lives both matter just as much as the mic grant.
import { setMicGranted } from './state';
import { initSettingsPanel } from './settingsPanel';

const statusArea = document.getElementById('statusArea') as HTMLDivElement;
const doneSection = document.getElementById('doneSection') as HTMLDivElement;

function renderGranted(): void {
  void setMicGranted(true);
  statusArea.innerHTML = `
    <div class="banner">Microphone access granted.</div>
  `;
  doneSection.hidden = false;
}

function renderDenied(): void {
  statusArea.innerHTML = `
    <div class="error-text">
      Microphone access was denied. You can still record the call without your
      own mic, but to enable it later: open <code>chrome://extensions</code> →
      Mova Flow Meet Recorder → Details, and allow microphone access there.
    </div>
    <div class="record-row" style="margin-top: 10px;">
      <button class="action secondary" id="retryBtn">Try again</button>
    </div>
  `;
  document.getElementById('retryBtn')?.addEventListener('click', () => void requestMic());
}

async function requestMic(): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    renderGranted();
  } catch {
    renderDenied();
  }
}

document.getElementById('grantBtn')?.addEventListener('click', () => void requestMic());

// If the grant already happened in a previous visit to this page, don't make
// the user click again to find that out.
navigator.permissions
  ?.query({ name: 'microphone' as PermissionName })
  .then((status) => {
    if (status.state === 'granted') renderGranted();
  })
  .catch(() => {
    /* permissions.query for 'microphone' isn't supported everywhere — the
     * button click path above still works regardless. */
  });

void initSettingsPanel();
