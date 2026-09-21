// Injects a record button straight into Meet's own call-controls toolbar
// (next to mic/camera), so starting a recording doesn't require finding the
// extension's own toolbar icon first. The popup (click the extension icon)
// still works exactly as before and is the reliable fallback if this ever
// breaks — Meet's toolbar is built from obfuscated, frequently-reshuffled
// class names, so this targets the jsname Google's own code assigns the
// control-bar region instead, which has held up better across redesigns,
// but nothing here is guaranteed stable.
import type { RecordingStatus } from './state';
import { getMicGranted } from './state';

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

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.movaFlowStatus) render(changes.movaFlowStatus.newValue);
});

// Meet re-renders the toolbar on call-state changes (screen share starts,
// participants panel opens, etc.), which can wipe out a plain DOM insertion
// — a MutationObserver keeps putting the button back rather than trying to
// catch every specific event that might remove it.
new MutationObserver(() => ensureButton()).observe(document.body, { childList: true, subtree: true });
ensureButton();
