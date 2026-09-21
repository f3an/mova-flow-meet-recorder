// Wires up the host/port/secret form — shared between popup.html and
// onboarding.html, which both render the exact same field IDs. Keeping one
// copy of this means "find host" / "save" / "test connection" behave
// identically wherever the form shows up, rather than drifting apart.
import { checkConnection } from './api';
import { getSettings, setSettings } from './state';

export async function initSettingsPanel(): Promise<void> {
  const hostInput = document.getElementById('hostInput') as HTMLInputElement | null;
  const portInput = document.getElementById('portInput') as HTMLInputElement | null;
  const secretInput = document.getElementById('secretInput') as HTMLInputElement | null;
  const settingsResult = document.getElementById('settingsResult') as HTMLDivElement | null;
  if (!hostInput || !portInput || !secretInput || !settingsResult) return;

  // mova-flow.local is a fixed alias every Mova Flow host also advertises
  // alongside its own machine name (see discovery.ts in the main repo) — an
  // extension has no mDNS API to actually browse the network with, so this
  // is the closest thing to "auto-discovery" it can do: try the one
  // well-known name directly and see if the OS resolves it. Only
  // unambiguous with a single host on the LAN; a second one gets suffixed
  // by mDNS and this won't find it.
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

  const settings = await getSettings();
  hostInput.value = settings.host;
  portInput.value = String(settings.port);
  secretInput.value = settings.secret;
}
