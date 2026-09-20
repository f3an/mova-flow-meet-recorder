// The service worker never touches audio itself — MV3 service workers have
// no DOM, so all of that lives in the offscreen document (offscreen.ts).
// This file's only job is: find the right tab, get Chrome's permission to
// capture it, and hand that off.
import { setStatus } from './state';

// chrome.storage.session defaults to extension-pages-only access — the
// content script injected into Meet needs to read/write it too, to know
// whether to render its button as idle/recording/processing.
void chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });

const OFFSCREEN_URL = 'offscreen.html';

interface PopupMessage {
  type: 'start-recording' | 'stop-recording';
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

  await setStatus({ stage: 'recording', tabTitle: tab.title || 'Google Meet', startedAt: Date.now() });
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start-recording', streamId, tabTitle: tab.title });
}

async function stopRecording(): Promise<void> {
  // offscreen.ts moves status to 'processing' -> 'done'/'error' itself once
  // it's actually finished converting and uploading.
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop-recording' });
}

chrome.runtime.onMessage.addListener((message: PopupMessage, _sender, sendResponse) => {
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
});
