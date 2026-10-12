import { mountRecordView } from './recordView';

// Expanded mode: the full extension — Record, History, Upload, Settings —
// in Chrome's side panel, which stays open next to the call instead of
// closing on the first click outside like this popup. sidePanel.open() must
// run inside the click's user gesture, so the window id is looked up ahead of
// time rather than awaited in the handler.
let currentWindowId: number | undefined;

function initExpandButton(): void {
  const btn = document.getElementById('expandBtn');
  if (!btn) return;
  void chrome.windows.getCurrent().then((w) => (currentWindowId = w.id));
  btn.addEventListener('click', () => {
    const opened =
      'sidePanel' in chrome && currentWindowId !== undefined
        ? chrome.sidePanel.open({ windowId: currentWindowId })
        : Promise.reject(new Error('no side panel'));
    opened
      .catch(() =>
        // Browsers without the side panel API: a tall window of its own.
        chrome.windows.create({ url: chrome.runtime.getURL('sidepanel.html'), type: 'popup', width: 440, height: 780 }),
      )
      .finally(() => window.close());
  });
}

async function init(): Promise<void> {
  initExpandButton();
  // Opening the popup is the click Chrome wanted before it lets the tab be
  // recorded — finish a start the in-page button had to park (background.ts).
  await chrome.runtime.sendMessage({ type: 'start-pending' }).catch(() => {});
  await mountRecordView(document.getElementById('statusArea') as HTMLDivElement);
}

void init();
