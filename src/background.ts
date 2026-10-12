// The service worker never touches audio itself — MV3 service workers have
// no DOM, so all of that lives in the offscreen document (offscreen.ts).
// This file's only job is: find the right tab, get Chrome's permission to
// capture it, and hand that off.
import { setStatus, getStatus, getSpeakerTimeline, setSpeakerTimeline, RecordingStatus } from './state';
import { platformForUrl, PLATFORM_NAMES, type CallPlatform } from './platforms';

// chrome.storage.session defaults to extension-pages-only access — the
// content script injected into the call page needs to read/write it too, to know
// whether to render its button as idle/recording/processing.
void chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });

const OFFSCREEN_URL = 'offscreen.html';

interface PopupMessage {
  type: 'start-recording' | 'stop-recording' | 'is-recording-tab' | 'start-pending' | 'cancel-pending';
}
interface SetStatusMessage {
  target: 'background';
  type: 'set-status';
  status: RecordingStatus;
}
interface GetSettingsMessage {
  target: 'background';
  type: 'get-speaker-timeline';
}

// First run: walk through where the record button is and connecting to a
// host — there's no permission to grant, but no host means no transcripts.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    void chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  }
});

// e.g. meet-record-abc-defg-hij-2026-10-12T…, teams-record-call-… — the
// room code where the URL has one (it's the one stable, human-meaningful id;
// the tab title is often just "Meet" until participants join), "call"
// otherwise.
function buildRecordingName(platform: CallPlatform, url: string): string {
  const room = (platform.room(new URL(url)) ?? 'call').replace(/[^a-z0-9-]/gi, '').slice(0, 40) || 'call';
  const date = new Date().toISOString().replace(/[:.]/g, '-');
  return `${platform.id}-record-${room}-${date}`;
}

async function ensureOffscreenDocument(): Promise<void> {
  const has = await chrome.offscreen.hasDocument();
  if (has) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: "Records the call tab's audio and converts it for transcription.",
  });
}

// The call tab's own button names its tab (the sender); the popup and the
// side panel mean the tab in front. Its URL is visible thanks to the host
// permissions for the call services — without them Chrome hands back a tab
// with no URL at all, which used to read as "not a call tab" even in a call.
async function findCallTab(senderTab?: chrome.tabs.Tab): Promise<{ tab: chrome.tabs.Tab; platform: CallPlatform }> {
  let tab = senderTab;
  if (!tab?.id) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error('No active tab.');
  const platform = platformForUrl(tab.url);
  if (!platform) {
    throw new Error(`Switch to the call's tab first (${PLATFORM_NAMES}), then press Record.`);
  }
  return { tab, platform };
}

async function startRecording(senderTab?: chrome.tabs.Tab): Promise<void> {
  const { tab, platform } = await findCallTab(senderTab);

  await ensureOffscreenDocument();
  // @types/chrome only declares the callback form here, though Chrome itself
  // also accepts the Promise form at runtime — wrapped for consistency with
  // the rest of this file.
  const streamId = await new Promise<string>((resolve, reject) =>
    chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (id) => {
      const err = chrome.runtime.lastError;
      if (err || !id) reject(new Error(`Chrome didn't allow recording this tab: ${err?.message || 'no stream'}`));
      else resolve(id);
    }),
  );

  const recordingName = buildRecordingName(platform, tab.url!);
  // Cleared here rather than by the call tab, which also resumes logging
  // into the existing timeline after a reload mid-recording.
  await setSpeakerTimeline([]);
  await setStatus({
    stage: 'recording',
    tabTitle: tab.title || platform.name,
    startedAt: Date.now(),
    recordingName,
    tabId: tab.id,
  });
  await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'start-recording',
    streamId,
    tabTitle: tab.title,
    recordingName,
  });
}

// Chrome lets an extension capture a tab only once the user has invoked it
// on that tab — clicked its toolbar icon (when that opens the popup, not the
// side panel), used its keyboard shortcut or its item in the page's context
// menu — and a Record button inside the page or the side panel doesn't count. When a start runs into that, it's
// parked: the status says to click the icon, the icon lights up, and the
// start is retried every second until the click lands and it goes through
// (or five minutes pass, or it's cancelled) — whichever of those it is.
// The grant then lasts until the tab navigates away.
const GRANT_ERROR = /not been invoked/i;
const PENDING_KEY = 'movaFlowPendingStart';
const PENDING_TTL_MS = 5 * 60_000;
const RETRY_MS = 1000;

interface ParkedStart {
  tabId: number;
  at: number;
}

async function getParked(): Promise<ParkedStart | undefined> {
  const { [PENDING_KEY]: pending } = await chrome.storage.session.get(PENDING_KEY);
  return pending as ParkedStart | undefined;
}

async function parkStart(tabId: number): Promise<void> {
  const at = Date.now();
  await chrome.storage.session.set({ [PENDING_KEY]: { tabId, at } satisfies ParkedStart });
  await setStatus({ stage: 'awaiting-grant', tabId, since: at, shortcut: await shortcut(), iconGrants: await iconGrants() });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#a8532e' });
  await chrome.action.setBadgeText({ tabId, text: 'REC' });
  watchForGrant();
}

async function clearParked(): Promise<void> {
  const pending = await getParked();
  if (!pending) return;
  await chrome.storage.session.remove(PENDING_KEY);
  void chrome.action.setBadgeText({ tabId: pending.tabId, text: '' }).catch(() => {});
}

let attempting = false;

/** One go at the parked start: 'waiting' while Chrome still wants the click. */
async function tryParkedStart(): Promise<'started' | 'waiting' | 'none'> {
  if (attempting) return 'waiting';
  const pending = await getParked();
  if (!pending) return 'none';
  attempting = true;
  try {
    const tab = await chrome.tabs.get(pending.tabId).catch(() => undefined);
    if (!tab || Date.now() - pending.at > PENDING_TTL_MS) {
      await clearParked();
      await setStatus({ stage: 'idle' });
      return 'none';
    }
    await startRecording(tab);
    await clearParked();
    return 'started';
  } catch (err) {
    const message = (err as Error).message;
    if (GRANT_ERROR.test(message)) return 'waiting';
    await clearParked();
    await setStatus({ stage: 'error', message });
    return 'none';
  } finally {
    attempting = false;
  }
}

let grantTimer: ReturnType<typeof setInterval> | null = null;

function watchForGrant(): void {
  if (grantTimer) return;
  // Each attempt is an extension API call, which also keeps this worker
  // alive while it waits.
  grantTimer = setInterval(() => {
    void tryParkedStart().then((result) => {
      if (result !== 'waiting' && grantTimer) {
        clearInterval(grantTimer);
        grantTimer = null;
      }
    });
  }, RETRY_MS);
}

// The worker was restarted while a start was parked: keep waiting for it.
void getParked().then((pending) => pending && watchForGrant());

async function shortcut(): Promise<string> {
  const commands = await chrome.commands.getAll();
  return commands.find((c) => c.name === 'toggle-recording')?.shortcut ?? '';
}

/** Whether a click on the toolbar icon can grant the permission: it doesn't
 * when the icon opens the side panel (observed in Brave, Oct 2026) — only
 * when it opens the popup. */
async function iconGrants(): Promise<boolean> {
  if (!('sidePanel' in chrome)) return true;
  const behavior = await chrome.sidePanel.getPanelBehavior().catch(() => undefined);
  return !behavior?.openPanelOnActionClick;
}

/** Start, or stop if one is running — for the ways of invoking the extension
 * that grant the permission there and then (the shortcut, the page's context
 * menu). */
async function toggleFromInvocation(tab: chrome.tabs.Tab | undefined): Promise<void> {
  await clearParked();
  const status = await getStatus();
  if (status.stage === 'recording') await stopRecording();
  else if (status.stage !== 'processing') {
    await startRecording(tab).catch((err: Error) => setStatus({ stage: 'error', message: err.message }));
  }
}

// A right-click on the call page → "Record this call with Mova Flow": a
// context-menu click invokes the extension on the tab just as the shortcut
// does, whatever the icon is set to open.
const MENU_ID = 'mova-flow-record';
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Record this call with Mova Flow',
    contexts: ['page', 'frame', 'video', 'audio'],
    documentUrlPatterns: chrome.runtime.getManifest().host_permissions,
  });
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID) void toggleFromInvocation(tab);
});

async function stopRecording(): Promise<void> {
  // offscreen.ts moves status to 'processing' -> 'done'/'error' itself once
  // it's actually finished converting and uploading. No offscreen document,
  // or one with nothing recording (it crashed, or never got the tab's audio):
  // the status was stale, so reset it instead of "Stopping..." forever.
  const reply = (await chrome.offscreen.hasDocument())
    ? await chrome.runtime
        .sendMessage({ target: 'offscreen', type: 'stop-recording' })
        .catch(() => undefined)
    : undefined;
  if (!reply?.recording) {
    await setStatus({ stage: 'error', message: 'The recording had already stopped — nothing was captured. Press Record to start again.' });
  }
}


// The keyboard shortcut counts as invoking the extension on the tab, so it
// can always start (or stop) a recording, wherever the button is.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'toggle-recording') return;
  void toggleFromInvocation(tab);
});

chrome.runtime.onMessage.addListener(
  (message: PopupMessage | SetStatusMessage | GetSettingsMessage, _sender, sendResponse) => {
    // The offscreen document has no working chrome.storage in some browsers
    // (observed on Brave) — it relays reads/writes here instead of using
    // chrome.storage directly, since that works fine from the service worker.
    if ('target' in message && message.target === 'background') {
      if (message.type === 'set-status') {
        void setStatus(message.status);
        return undefined;
      }
      if (message.type === 'get-speaker-timeline') {
        getSpeakerTimeline().then(sendResponse);
        return true;
      }
    }
    // Content scripts can't see their own tab id — only the sender here can.
    if (message.type === 'is-recording-tab') {
      getStatus().then((status) =>
        sendResponse(status.stage === 'recording' && status.tabId === _sender.tab?.id),
      );
      return true;
    }
    if (message.type === 'start-recording') {
      startRecording(_sender.tab)
        .then(() => sendResponse({ ok: true }))
        .catch(async (err: Error) => {
          if (GRANT_ERROR.test(err.message)) {
            // Not an error: one click on the icon away from working.
            const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
            const tabId = _sender.tab?.id ?? active?.id;
            if (tabId !== undefined) {
              await parkStart(tabId);
              sendResponse({ ok: false, needsGrant: true, shortcut: await shortcut(), iconGrants: await iconGrants() });
              return;
            }
          }
          void setStatus({ stage: 'error', message: err.message });
          sendResponse({ ok: false, error: err.message });
        });
      return true; // keep the message channel open for the async response
    }
    // The popup just opened — normally from a click on the icon, which is
    // what grants the permission: no need to wait for the next retry.
    if (message.type === 'start-pending') {
      tryParkedStart().then((result) => sendResponse({ started: result === 'started' }));
      return true;
    }
    if (message.type === 'cancel-pending') {
      void clearParked().then(() => setStatus({ stage: 'idle' })).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (message.type === 'stop-recording') {
      stopRecording()
        .then(() => sendResponse({ ok: true }))
        .catch((err: Error) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    return undefined;
  },
);
