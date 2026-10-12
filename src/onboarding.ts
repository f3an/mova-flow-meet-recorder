// Opened once on install (see chrome.runtime.onInstalled in background.ts):
// where the record button lives, and making sure the Mova Flow app is
// running here — it does the transcribing. There's no permission to grant:
// the call is captured from the tab, and the user's own voice from what the
// call page itself sends (callAudioHook.ts).
import { renderAppStatus } from './appStatus';

// Re-checked every few seconds, so installing or opening the app turns the
// card green without reloading this page.
const el = document.getElementById('appStatus') as HTMLDivElement;
async function check(): Promise<void> {
  const status = await renderAppStatus(el);
  if (!status) setTimeout(check, 3000);
}
void check();

// The shortcut as it's actually set (it can be changed, or taken by another
// extension) — the page shows the default until this answers.
void chrome.commands.getAll().then((commands) => {
  const key = commands.find((c) => c.name === 'toggle-recording')?.shortcut;
  for (const id of ['shortcut', 'shortcutBig']) {
    const el = document.getElementById(id);
    if (el && key) el.textContent = key;
  }
});
