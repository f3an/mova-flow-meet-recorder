// The service worker never touches audio itself — MV3 service workers have
// no DOM, so all of that lives in the offscreen document (offscreen.ts).
// This file's only job is: find the right tab, get Chrome's permission to
// capture it, and hand that off.
import { setStatus, getSettings, RecordingStatus } from './state';

// chrome.storage.session defaults to extension-pages-only access — the
// content script injected into Meet needs to read/write it too, to know
// whether to render its button as idle/recording/processing.
void chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });

const OFFSCREEN_URL = 'offscreen.html';

interface PopupMessage {
  type: 'start-recording' | 'stop-recording' | 'open-popup';
}
interface SetStatusMessage {
  target: 'background';
  type: 'set-status';
  status: RecordingStatus;
}
interface GetSettingsMessage {
  target: 'background';
  type: 'get-settings';
}

// The offscreen document has no visible surface, so it can never show the
// microphone permission prompt itself (see offscreen.ts) — send the user to
// a real tab that can, once, right after install.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    void chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  }
});

// meet.google.com/xxx-yyyy-zzz — the room code is the one stable, human
// -meaningful identifier for a call (unlike the tab title, which is often
// just "Meet" until participants join). Falls back to "meeting" for any URL
// shape this doesn't recognize rather than producing an empty segment.
function meetRoomFromUrl(url: string): string {
  const match = url.match(/meet\.google\.com\/([a-z0-9-]+)/i);
  return match?.[1] || 'meeting';
}

function buildRecordingName(url: string): string {
  const room = meetRoomFromUrl(url);
  const date = new Date().toISOString().replace(/[:.]/g, '-');
  return `meet-record-${room}-${date}`;
}

async function ensureOffscreenDocument(): Promise<void> {
  const has = await chrome.offscreen.hasDocument();
  if (has) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Records tab + microphone audio and converts it for transcription.',
  });
}

async function startRecording(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab.');
  if (!tab.url?.includes('meet.google.com')) {
    throw new Error('Open a Google Meet call in this tab first.');
  }

  await ensureOffscreenDocument();
  // @types/chrome only declares the callback form here, though Chrome itself
  // also accepts the Promise form at runtime — wrapped for consistency with
  // the rest of this file.
  const streamId = await new Promise<string>((resolve) =>
    chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, resolve),
  );

  const recordingName = buildRecordingName(tab.url);
  await setStatus({
    stage: 'recording',
    tabTitle: tab.title || 'Google Meet',
    startedAt: Date.now(),
    recordingName,
  });
  await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'start-recording',
    streamId,
    tabTitle: tab.title,
    recordingName,
  });
}

async function stopRecording(): Promise<void> {
  // offscreen.ts moves status to 'processing' -> 'done'/'error' itself once
  // it's actually finished converting and uploading.
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop-recording' });
}

// The Meet toolbar button (content.ts) has no room for a banner/explanation
// — when it can't just proceed (mic never granted, or the last attempt
// ended in an error), it asks for the real popup instead, which does.
// chrome.action.openPopup() needs Chrome 127+; fall back to a plain tab for
// anything older or that otherwise refuses (observed to matter on Brave).
async function openPopup(): Promise<void> {
  try {
    await chrome.action.openPopup();
  } catch {
    await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
  }
}

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
      if (message.type === 'get-settings') {
        getSettings().then(sendResponse);
        return true;
      }
    }
    if (message.type === 'open-popup') {
      openPopup().then(() => sendResponse({ ok: true }));
      return true;
    }
    if (message.type === 'start-recording') {
      startRecording()
        .then(() => sendResponse({ ok: true }))
        .catch((err: Error) => {
          void setStatus({ stage: 'error', message: err.message });
          sendResponse({ ok: false, error: err.message });
        });
      return true; // keep the message channel open for the async response
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
