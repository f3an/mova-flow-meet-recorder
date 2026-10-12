// Puts a record button into the call's own controls, so starting a recording
// doesn't require finding the extension's toolbar icon first: on Google Meet
// next to mic/camera, in Zoom's web client in its bottom bar, in Teams first
// in its meeting controls, in Jitsi in its toolbox. Until those controls
// exist (a lobby, the rest of the app) there's no button — nothing to record
// yet. The popup and the side panel work regardless and are the reliable
// fallback if a redesign ever breaks this.
//
// Meet's toolbar is built from obfuscated, frequently-reshuffled class names,
// so this targets the jsname Google's own code assigns the control-bar region
// instead, which has held up better across redesigns, but nothing here is
// guaranteed stable.
import type { RecordingStatus } from './state';
import { getSpeakerTimeline, setSpeakerTimeline } from './state';
import { CaptionLogger } from './captions';
import { grantWays } from './grantHelp';

const BUTTON_ID = 'mova-flow-record-btn';
const WRAP_CLASS = 'mova-flow-wrap';
const IS_MEET = location.hostname === 'meet.google.com';
const IS_ZOOM = /(^|\.)zoom\.us$/.test(location.hostname);
const IS_TEAMS = ['teams.microsoft.com', 'teams.live.com', 'teams.cloud.microsoft'].includes(location.hostname);
const IS_JITSI = location.hostname === 'meet.jit.si';

function findMeetToolbar(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>('div[jsname="vNB5le"]') ??
    document.querySelector<HTMLElement>('div[role="region"][aria-label*="call controls" i]')
  );
}

// Zoom's web client: the bottom bar (Participants, Chat, React, Share, Host
// tools, More). The button goes in just before "More", built from Zoom's own
// footer-button classes so it gets their size, hover and label styling —
// those class names are readable (not obfuscated like Meet's), so they're
// the best hook available. Observed Oct 2026:
//   div.footer__btns-container[footer-section="mid"]
//     div#sdk-footer-sortable-list > div.footer__button-wrap × n
//     div[feature-type="more"]
function findZoomFooter(): { container: HTMLElement; before: Element | null } | null {
  const container =
    document.querySelector<HTMLElement>('.footer__btns-container[footer-section="mid"]') ??
    document.querySelector<HTMLElement>('#sdk-footer-sortable-list')?.parentElement ??
    null;
  if (!container) return null;
  return { container, before: container.querySelector(':scope > [feature-type="more"]') };
}

function buildZoomButton(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = `footer__button-wrap ${WRAP_CLASS}`;
  wrap.setAttribute('role', 'presentation');
  const btn = document.createElement('button');
  btn.id = BUTTON_ID;
  btn.type = 'button';
  btn.className = 'footer-button-base__button ax-outline footer-button__button mova-flow-inline-btn is-zoom';
  btn.setAttribute('aria-label', 'Mova Flow — record this call');
  btn.innerHTML =
    '<div class="footer-button-base__img-layer"><span class="mova-flow-icon"></span></div>' +
    '<span class="footer-button-base__button-label mova-flow-label">Record</span>';
  btn.addEventListener('click', () => void onClick());
  wrap.appendChild(btn);
  return wrap;
}

// Teams: the meeting controls bar (Record, Chat, People, Raise, React, View,
// More | Camera, Mic, Share). The button goes first in it. Teams' buttons are
// Fluent UI, styled by hashed class names that change from build to build —
// so they're copied off a sibling button at the moment it's built, rather
// than written down here. Observed Oct 2026:
//   div[role=toolbar][data-tid="ubar-horizontal-middle-end"]#horizontalMiddleEnd
//     div[data-overflow-item] > button.fui-Button#chat-button
//       span.fui-Button__icon > … svg
//       span.fui-StyledText  ← the label
function findTeamsToolbar(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>('[data-tid="ubar-horizontal-middle-end"]') ??
    document.querySelector<HTMLElement>('#horizontalMiddleEnd')
  );
}

function buildTeamsButton(toolbar: HTMLElement): { wrap: HTMLElement; before: Element | null } | null {
  const template =
    toolbar.querySelector<HTMLElement>('#chat-button, #roster-button') ??
    toolbar.querySelector<HTMLElement>('button.fui-Button');
  if (!template) return null;
  const item = template.closest('[data-overflow-item]');
  const wrap = document.createElement('div');
  // Its look, not its data-overflow-* attributes: Teams' overflow manager
  // tracks the items it rendered itself, and has no business moving this one.
  wrap.className = `${item?.className ?? ''} ${WRAP_CLASS}`;
  const btn = document.createElement('button');
  btn.id = BUTTON_ID;
  btn.type = 'button';
  btn.className = `${template.className} mova-flow-inline-btn is-teams`;
  const icon = template.querySelector('.fui-Button__icon')?.className ?? 'fui-Button__icon';
  const label = template.querySelector('.fui-StyledText')?.className ?? '';
  btn.innerHTML =
    `<span class="${icon}"><span class="mova-flow-icon"></span></span>` +
    `<span dir="auto" class="${label} mova-flow-label">Record</span>`;
  btn.addEventListener('click', () => void onClick());
  wrap.appendChild(btn);
  // First of the buttons — after Teams' own leading focus-trap element.
  return { wrap, before: toolbar.querySelector(':scope > [data-overflow-item], :scope > [data-overflow-group]') };
}

// Jitsi Meet: the bottom toolbox (mic, camera, share, chat, raise hand,
// participants, tile view, invite, more, leave) — icon-only buttons, so ours
// is one too, just before "More actions". Observed Oct 2026 on meet.jit.si:
//   div.toolbox-content-items
//     div.toolbox-button[role=button][aria-label] > div > div.toolbox-icon > div.jitsi-icon > svg
//     div.toolbox-button-wth-dialog.context-menu  ← "More actions"
function findJitsiToolbox(): { container: HTMLElement; before: Element | null } | null {
  const container = document.querySelector<HTMLElement>('.toolbox-content-items');
  if (!container) return null;
  return { container, before: container.querySelector(':scope > .toolbox-button-wth-dialog') };
}

function buildJitsiButton(): HTMLElement {
  // A div with role=button, the same as Jitsi's own — its styles are written
  // for that, not for a <button>.
  const btn = document.createElement('div');
  btn.id = BUTTON_ID;
  btn.className = `toolbox-button mova-flow-inline-btn is-jitsi ${WRAP_CLASS}`;
  btn.setAttribute('role', 'button');
  btn.tabIndex = 0;
  btn.setAttribute('aria-label', 'Mova Flow — record this call');
  btn.innerHTML =
    '<div><div class="toolbox-icon"><div class="jitsi-icon jitsi-icon-default"><span class="mova-flow-icon"></span></div></div></div>';
  btn.addEventListener('click', () => void onClick());
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void onClick();
    }
  });
  return btn;
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
  btn.setAttribute('aria-label', btn.title);
  const label = btn.querySelector('.mova-flow-label');
  if (label) label.textContent = stage === 'recording' ? 'Stop' : stage === 'processing' ? 'Saving…' : 'Record';
}

/** This copy of the script belongs to a version of the extension that has
 * since been updated or reloaded: Chrome cuts it off from the extension, but
 * leaves it — and its button — on pages that were open at the time. */
function orphaned(): boolean {
  try {
    return !chrome.runtime?.id;
  } catch {
    return true;
  }
}

function showReloadHint(): void {
  showHint(
    'Reload this page to record',
    'Mova Flow was updated while this page was open, and this tab still runs the old copy. Reload the page (the call reconnects), then press Record again.',
  );
}

async function onClick(): Promise<void> {
  if (orphaned()) {
    showReloadHint();
    return;
  }
  try {
    await toggleRecording();
  } catch (err) {
    // Cut off between the check above and a call — the same thing.
    if (orphaned() || /context invalidated/i.test((err as Error).message)) showReloadHint();
    else throw err;
  }
}

async function toggleRecording(): Promise<void> {
  const btn = document.getElementById(BUTTON_ID) as HTMLButtonElement;
  const { movaFlowStatus } = await chrome.storage.session.get('movaFlowStatus');
  const stage = (movaFlowStatus as RecordingStatus | undefined)?.stage ?? 'idle';

  // An earlier error or a recording saved to Downloads is history by now:
  // a press here means "record", and whatever goes wrong this time shows up
  // in the popup and the side panel the same as always.

  btn.disabled = true;
  try {
    if (stage === 'recording') {
      // Flush first so this tab's final captions are in before the upload.
      if (IS_MEET) await setSpeakerTimeline(captions.snapshot);
      stopMyVoice();
      await chrome.runtime.sendMessage({ type: 'stop-recording' });
    } else if (stage !== 'processing') {
      const res = await chrome.runtime.sendMessage({ type: 'start-recording' });
      if (res?.needsGrant) showGrantHint(res.shortcut, res.iconGrants);
    }
  } finally {
    btn.disabled = false;
  }
}

// Chrome wants the extension called on — its icon, its shortcut, its item in
// the context menu — before it lets the tab be recorded (see background.ts):
// say so next to the button, rather than as an error. Whichever it is starts
// the recording by itself.
const HINT_ID = 'mova-flow-grant-hint';
let hintTimer: number | null = null;

function hideGrantHint(): void {
  document.getElementById(HINT_ID)?.remove();
  if (hintTimer !== null) window.clearTimeout(hintTimer);
  hintTimer = null;
}

function showGrantHint(shortcut: string, iconGrants: boolean): void {
  showHint('One more step to start recording', grantWays(shortcut, iconGrants));
}

/** `body` is trusted markup. */
function showHint(title: string, body: string): void {
  hideGrantHint();
  const btn = document.getElementById(BUTTON_ID);
  const hint = document.createElement('div');
  hint.id = HINT_ID;
  hint.className = 'mova-flow-hint';
  hint.setAttribute('role', 'status');
  hint.innerHTML = `
    <button type="button" class="mova-flow-hint-close" aria-label="Close">×</button>
    <strong>${title}</strong>
    <span>${body}</span>`;
  hint.querySelector('.mova-flow-hint-close')?.addEventListener('click', hideGrantHint);
  document.body.appendChild(hint);
  // Next to the button when it's on screen — above it (Meet, Zoom: a bottom
  // bar), or below it when there's no room above (Teams: a top bar, where
  // "above" would cover the bar itself); top right (towards the icon) when not.
  const rect = btn?.getBoundingClientRect();
  if (rect && rect.width) {
    const left = Math.min(Math.max(8, rect.left + rect.width / 2 - hint.offsetWidth / 2), window.innerWidth - hint.offsetWidth - 8);
    const above = rect.top - hint.offsetHeight - 12;
    hint.style.left = `${left}px`;
    hint.style.top = `${above >= 8 ? above : rect.bottom + 12}px`;
  } else {
    hint.style.right = '16px';
    hint.style.top = '16px';
  }
  hintTimer = window.setTimeout(hideGrantHint, 30_000);
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
  const existing = document.getElementById(BUTTON_ID);
  if (existing) return;
  if (IS_MEET) {
    const toolbar = findMeetToolbar();
    if (!toolbar) return;
    toolbar.appendChild(buildButton());
  } else if (IS_ZOOM) {
    // Until the footer exists the page is still the lobby / "join audio"
    // screen, with nothing to record yet. This script
    // runs in every Zoom frame (manifest.json) — Zoom Workplace hosts the
    // call in a frame of its own, under a URL that needn't be /wc/ — and the
    // footer is what picks the one frame that gets the button.
    const footer = findZoomFooter();
    if (!footer) return;
    footer.container.insertBefore(buildZoomButton(), footer.before);
  } else if (IS_TEAMS) {
    // Only in a call: the controls bar is what tells one from the rest of
    // Teams (chats, calendar), all under the same URL.
    const toolbar = findTeamsToolbar();
    const built = toolbar && buildTeamsButton(toolbar);
    if (!toolbar || !built) return;
    toolbar.insertBefore(built.wrap, built.before);
  } else if (IS_JITSI) {
    const toolbox = findJitsiToolbox();
    if (!toolbox) return;
    toolbox.container.insertBefore(buildJitsiButton(), toolbox.before);
  } else {
    return;
  }
  chrome.storage.session.get('movaFlowStatus').then(({ movaFlowStatus }) => render(movaFlowStatus));
}

// Caption logging follows the recording status, whoever started or stopped
// it (this button or the popup). The timeline is flushed to session storage
// as it grows, not only at the end: a stop from the popup reaches the
// offscreen document and this tab independently, so the final flush below
// can land after the upload has already read whatever was there.
const captions = new CaptionLogger();
let flushTimer: number | null = null;

// The user's own voice: callAudioHook.ts (page context) records the
// audio the page sends and posts it here in chunks; this relays them over a port
// to the offscreen document, which merges them in as the "me" channel. Sent
// as it's recorded, not in one piece at the end, so an hour-long call never
// has to fit in a single extension message.
let mePort: chrome.runtime.Port | null = null;

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.source !== 'mova-flow-page' || !mePort) return;
  const { type } = event.data;
  if (type === 'me-started') {
    mePort.postMessage({ type: 'started', startedAt: event.data.startedAt, hasTrack: event.data.hasTrack });
  } else if (type === 'me-track') {
    mePort.postMessage({ type: 'track' });
  } else if (type === 'me-chunk') {
    mePort.postMessage({ type: 'chunk', data: toBase64(event.data.data) });
  } else if (type === 'me-stopped') {
    mePort.postMessage({ type: 'stopped' });
    mePort.disconnect();
    mePort = null;
  }
});

// Which frame records the user's side: on Zoom, the call's own frame (the
// one with the footer — see ensureButton), not the Workplace shell around it
// or any other frame of the tab; elsewhere the scripts only run in the top
// frame anyway. Only one frame may: the offscreen document keeps one "me".
function isCallFrame(): boolean {
  return !IS_ZOOM || findZoomFooter() !== null;
}

function startMyVoice(): void {
  mePort = chrome.runtime.connect({ name: 'mova-flow-me' });
  window.postMessage({ source: 'mova-flow', type: 'me-start' }, window.location.origin);
}

function stopMyVoice(): void {
  if (mePort) window.postMessage({ source: 'mova-flow', type: 'me-stop' }, window.location.origin);
}

async function syncCaptions(status: RecordingStatus | undefined): Promise<void> {
  if (status?.stage === 'recording') {
    if (flushTimer !== null) return;
    // Only the tab actually being recorded — another call tab (a lobby, a
    // second call) must neither log nor get its captions switched on.
    if (!(await chrome.runtime.sendMessage({ type: 'is-recording-tab' }))) return;
    if (!isCallFrame()) return;
    const earlier = await getSpeakerTimeline();
    if (flushTimer !== null) return;
    if (IS_MEET) captions.start(status.startedAt, earlier);
    startMyVoice();
    // Only Meet's captions are read (captions.ts) — elsewhere the timeline
    // stays empty and the other side of the call goes unnamed.
    flushTimer = window.setInterval(() => {
      if (IS_MEET) void setSpeakerTimeline(captions.snapshot);
    }, 5000);
  } else if (flushTimer !== null) {
    window.clearInterval(flushTimer);
    flushTimer = null;
    stopMyVoice();
    if (IS_MEET) void setSpeakerTimeline(captions.stop());
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.movaFlowStatus) {
    render(changes.movaFlowStatus.newValue);
    if (changes.movaFlowStatus.newValue?.stage !== 'awaiting-grant') hideGrantHint();
    void syncCaptions(changes.movaFlowStatus.newValue);
  }
});
// The tab may have been reloaded mid-recording — pick logging back up.
chrome.storage.session.get('movaFlowStatus').then(({ movaFlowStatus }) => void syncCaptions(movaFlowStatus));

// The pages re-render on call-state changes (screen share starts,
// participants panel opens, etc.), which can wipe out a plain DOM insertion
// (Meet's toolbar especially)
// — a MutationObserver keeps putting the button back rather than trying to
// catch every specific event that might remove it.
new MutationObserver(() => ensureButton()).observe(document.body, { childList: true, subtree: true });
ensureButton();
