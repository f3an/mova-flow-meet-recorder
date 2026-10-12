// "Is the Mova Flow app running here?" — shown in the popup, the side panel's
// Record and Settings tabs, and onboarding. The extension only records; the
// app on this computer transcribes, so without it there's nothing to send to.
import { checkApp, describeApp, type AppStatus } from './bridge';

const APP_DOWNLOAD_URL = 'https://github.com/f3an/Mova-Flow/releases/latest';

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

interface Card {
  title: string;
  /** Trusted markup — callers escape anything that isn't a literal. */
  body: string;
  /** Trusted markup for the buttons/links; a "Check again" is always added. */
  actions: string;
}

function card({ title, body, actions }: Card): string {
  return `
    <div class="app-status missing">
      <strong>${title}</strong>
      <span>${body}</span>
      <div class="actions">
        ${actions}
        <button class="action secondary" data-act="recheck">Check again</button>
      </div>
    </div>`;
}

/** The browser's own settings page for this extension's site permissions —
 * where Local Network Access is switched back on once it's been turned down.
 * Brave and the other Chromium browsers redirect chrome:// to their own. */
function permissionsPage(): string {
  return `chrome://settings/content/siteDetails?site=${encodeURIComponent(`chrome-extension://${chrome.runtime.id}`)}`;
}

/** Renders the app's status into `el`. `quiet`: render nothing while the app
 * is fine (the record view only needs to speak up when it isn't). */
export async function renderAppStatus(el: HTMLElement, quiet = false): Promise<AppStatus | null> {
  const status = await checkApp();
  const recheck = () => void renderAppStatus(el, quiet);

  if (status && typeof status === 'object') {
    el.innerHTML = quiet
      ? ''
      : `<div class="app-status ok"><strong>Connected to Mova Flow</strong><span>${escapeHtml(describeApp(status))}</span></div>`;
    return status;
  }

  if (status === 'blocked') {
    el.innerHTML = card({
      title: 'Your browser blocks access to the Mova Flow app',
      body: `Access to apps on this computer was turned down for this extension, so it can't reach Mova Flow.
        In the extension's settings, set <b>Local network access</b> (in Brave also <b>Localhost access</b>)
        to <b>Allow</b>, then check again.`,
      actions: '<button class="action" data-act="settings">Open settings</button>',
    });
    el.querySelector('[data-act="settings"]')?.addEventListener('click', () => {
      void chrome.tabs.create({ url: permissionsPage() });
    });
  } else if (status === 'refused') {
    // Running, but this isn't the Web Store build — an unpacked/dev copy has
    // an ID of its own, which the app has to be told to trust.
    const id = chrome.runtime.id;
    el.innerHTML = card({
      title: "Mova Flow doesn't recognize this copy of the extension",
      body: `The app is running, but only lets in the Chrome Web Store version. To use this copy, add its ID to
        <code>trusted_extension_ids</code> in the app's <code>config.json</code>:</span>
        <code class="ext-id">${escapeHtml(id)}</code><span>`,
      actions: '<button class="action" data-act="copy">Copy ID</button>',
    });
    el.querySelector('[data-act="copy"]')?.addEventListener('click', (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      void navigator.clipboard.writeText(id).then(() => (btn.textContent = 'Copied'));
    });
  } else if (status === 'outdated') {
    el.innerHTML = card({
      title: 'Mova Flow needs an update',
      body: `This version of the extension works with Mova Flow 0.4.12 or newer. Update the app — it checks for
        updates itself, or download the latest one — then check again.`,
      actions: `<a class="action" href="${APP_DOWNLOAD_URL}" target="_blank" rel="noopener">Get the update</a>`,
    });
  } else {
    el.innerHTML = card({
      title: "Mova Flow isn't running on this computer",
      body: `The extension records your calls; the Mova Flow app transcribes them — through your own host — and
        keeps them in its History. Install it, or just open it if it's already installed.`,
      actions: `<a class="action" href="${APP_DOWNLOAD_URL}" target="_blank" rel="noopener">Get Mova Flow</a>`,
    });
  }
  el.querySelector('[data-act="recheck"]')?.addEventListener('click', recheck);
  return null;
}
