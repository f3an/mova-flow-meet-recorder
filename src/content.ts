// Injects a record button straight into Meet's own call-controls toolbar
// (next to mic/camera), so starting a recording doesn't require finding the
// extension's own toolbar icon first. The popup (click the extension icon)
// still works exactly as before and is the reliable fallback if this ever
// breaks — Meet's toolbar is built from obfuscated, frequently-reshuffled
// class names, so this targets the jsname Google's own code assigns the
// control-bar region instead, which has held up better across redesigns,
// but nothing here is guaranteed stable.
import type { RecordingStatus } from './state';
import { getMicGranted, getSpeakerTimeline, setSpeakerTimeline } from './state';
import { CaptionLogger } from './captions';

const BUTTON_ID = 'mova-flow-record-btn';

function findToolbar(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>('div[jsname="vNB5le"]') ??
    document.querySelector<HTMLElement>('div[role="region"][aria-label*="call controls" i]')
  );
}

function render(status: RecordingStatus | undefined): void {
  const btn = document.getElementById(BUTTON_ID) as HTMLButtonElement | null;
  if (!btn) return;

  const stage = status?.stage ?? 'idle';
  btn.classList.toggle('is-recording', stage === 'recording');
  btn.classList.toggle('is-processing', stage === 'processing');
  btn.disabled = stage === 'processing';
  btn.title =
    stage === 'recording'
      ? 'Mova Flow — stop & transcribe'
      : stage === 'processing'
        ? 'Mova Flow — transcribing…'
        : stage === 'saved-locally'
          ? "Mova Flow — host unreachable, last recording saved to Downloads. Click to record again."
          : 'Mova Flow — record this call';
}

async function onClick(): Promise<void> {
  const btn = document.getElementById(BUTTON_ID) as HTMLButtonElement;
  const { movaFlowStatus } = await chrome.storage.session.get('movaFlowStatus');
  const stage = (movaFlowStatus as RecordingStatus | undefined)?.stage ?? 'idle';

  // Something already went wrong (mic denied, host unreachable, conversion
  // failed...) — open the popup to show why and let its own controls (Try
  // again / Add host / New recording) handle it, rather than silently
  // retrying the same thing that just failed.
  if (stage === 'error' || stage === 'saved-locally') {
    await chrome.runtime.sendMessage({ type: 'open-popup' });
    return;
  }

  // Starting fresh but the mic grant this needs was never obtained — same
  // deal: the popup has the "Allow microphone access" banner this button
  // itself has no visible surface to show.
  if (stage === 'idle' && !(await getMicGranted())) {
    await chrome.runtime.sendMessage({ type: 'open-popup' });
    return;
  }

  btn.disabled = true;
  try {
    if (stage === 'recording') {
      // Flush first so this tab's final captions are in before the upload.
      await setSpeakerTimeline(captions.snapshot);
      await chrome.runtime.sendMessage({ type: 'stop-recording' });
    } else if (stage !== 'processing') {
      await chrome.runtime.sendMessage({ type: 'start-recording' });
    }
  } finally {
    btn.disabled = false;
  }
}

function buildButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = BUTTON_ID;
  btn.className = 'mova-flow-btn';
  btn.type = 'button';
  btn.title = 'Mova Flow — record this call';
  btn.innerHTML = '<span class="mova-flow-icon"></span>';
  btn.addEventListener('click', () => void onClick());
  return btn;
}

function ensureButton(): void {
  if (document.getElementById(BUTTON_ID)) return;
  const toolbar = findToolbar();
  if (!toolbar) return;

  toolbar.appendChild(buildButton());
  chrome.storage.session.get('movaFlowStatus').then(({ movaFlowStatus }) => render(movaFlowStatus));
}

// Caption logging follows the recording status, whoever started or stopped
// it (this button or the popup). The timeline is flushed to session storage
// as it grows, not only at the end: a stop from the popup reaches the
// offscreen document and this tab independently, so the final flush below
// can land after the upload has already read whatever was there.
const captions = new CaptionLogger();
let flushTimer: number | null = null;

async function syncCaptions(status: RecordingStatus | undefined): Promise<void> {
  if (status?.stage === 'recording') {
    if (flushTimer !== null) return;
    // Only the tab actually being recorded — another Meet tab (a lobby, a
    // second call) must neither log nor get its captions switched on.
    if (!(await chrome.runtime.sendMessage({ type: 'is-recording-tab' }))) return;
    const earlier = await getSpeakerTimeline();
    if (flushTimer !== null) return;
    captions.start(status.startedAt, earlier);
    flushTimer = window.setInterval(() => void setSpeakerTimeline(captions.snapshot), 5000);
  } else if (flushTimer !== null) {
    window.clearInterval(flushTimer);
    flushTimer = null;
    void setSpeakerTimeline(captions.stop());
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.movaFlowStatus) {
    render(changes.movaFlowStatus.newValue);
    void syncCaptions(changes.movaFlowStatus.newValue);
  }
});
// The tab may have been reloaded mid-recording — pick logging back up.
chrome.storage.session.get('movaFlowStatus').then(({ movaFlowStatus }) => void syncCaptions(movaFlowStatus));

// Meet re-renders the toolbar on call-state changes (screen share starts,
// participants panel opens, etc.), which can wipe out a plain DOM insertion
// — a MutationObserver keeps putting the button back rather than trying to
// catch every specific event that might remove it.
new MutationObserver(() => ensureButton()).observe(document.body, { childList: true, subtree: true });
ensureButton();
