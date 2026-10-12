// The side panel ("expanded mode"): the popup's Record view plus History,
// Upload, Settings and More, in a panel that stays open next to the call.
// History and Upload are the Mova Flow app's own (see bridge.ts) — the
// extension records, the app on this computer transcribes and keeps.
import { renderAppStatus } from './appStatus';
import {
  deleteAppHistoryEntry,
  fetchAppHistory,
  fetchAppHistoryText,
  handOverToApp,
  transcribeInApp,
  waitForApp,
} from './bridge';
import { escapeHtml, mountRecordView } from './recordView';
import { platformForRecording, recordingTitle } from './platforms';
import { getStatus } from './state';
import { fileToMonoWav } from './wav';

type Tab = 'record' | 'history' | 'upload' | 'settings' | 'more';
const TAB_KEY = 'movaFlowPanelTab';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ── navigation ──────────────────────────────────────────────────────────────
function showTab(tab: Tab): void {
  document.querySelectorAll<HTMLButtonElement>('.panel-nav [data-tab]').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  });
  document.querySelectorAll<HTMLElement>('.tab-panel').forEach((p) => {
    p.hidden = p.dataset.panel !== tab;
  });
  if (tab === 'history') void renderHistory();
  if (tab === 'settings') void renderAppStatus($('appStatus'));
  try {
    sessionStorage.setItem(TAB_KEY, tab);
  } catch {
    /* remembered tab is only a convenience */
  }
}

function initNav(): void {
  document.querySelectorAll<HTMLButtonElement>('.panel-nav [data-tab]').forEach((b) => {
    b.addEventListener('click', () => showTab(b.dataset.tab as Tab));
  });
  let saved: string | null = null;
  try {
    saved = sessionStorage.getItem(TAB_KEY);
  } catch {
    /* ignore */
  }
  showTab((saved as Tab) || 'record');
}

// A pulsing dot on the Record tab while a recording runs, so it's visible
// from History or Upload too.
async function updateRecordDot(): Promise<void> {
  const status = await getStatus();
  (document.querySelector('.nav-dot') as HTMLElement).hidden = status.stage !== 'recording';
}

// ── history ─────────────────────────────────────────────────────────────────
interface Row {
  key: string;
  id: string;
  title: string;
  /** The recording's own name, for a downloaded transcript's filename. */
  file: string;
  platform: string | null;
  createdAt: number;
  durationSec?: number;
  language?: string;
  status: 'done' | 'pending' | 'recording' | 'transcribing';
  preview: string;
}

let openKey: string | null = null;
let rows: Row[] = [];
let appRunning = false;
const texts = new Map<string, string>();
/** Waiting recordings this panel asked the app to transcribe. */
const transcribing = new Set<string>();

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function formatDuration(sec?: number): string {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function downloadText(text: string, name: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  void chrome.downloads.download({ url, filename: `${name}.txt`, saveAs: true });
}

const stripExt = (f: string) => f.replace(/\.[^.]+$/, '');

async function loadRows(): Promise<void> {
  const app = await fetchAppHistory();
  appRunning = app !== null;
  if (!app) {
    rows = [];
    return;
  }
  const pending: Row[] = app.pending.map((p) => ({
    key: `pending:${p.id}`,
    id: p.id,
    title: recordingTitle(p.name),
    file: stripExt(p.name),
    platform: platformForRecording(p.name)?.name ?? null,
    createdAt: p.createdAt,
    durationSec: Math.round(p.seconds),
    status: p.recording ? 'recording' : transcribing.has(p.id) ? 'transcribing' : 'pending',
    preview: p.recording ? 'Recording in the Mova Flow app right now.' : 'Not transcribed yet.',
  }));
  const done: Row[] = app.items.map((i) => ({
    key: `item:${i.id}`,
    id: i.id,
    title: recordingTitle(i.filename),
    file: stripExt(i.filename),
    platform: platformForRecording(i.filename)?.name ?? null,
    createdAt: i.createdAt,
    language: i.language,
    status: 'done',
    preview: i.preview,
  }));
  rows = [...pending, ...done];
}

function rowHtml(r: Row): string {
  const meta = [
    r.platform ? `<span class="badge">${escapeHtml(r.platform)}</span>` : '',
    r.status === 'pending' ? '<span class="badge warn">Not transcribed</span>' : '',
    r.status === 'transcribing' ? '<span class="badge">Transcribing…</span>' : '',
    r.status === 'recording' ? '<span class="badge warn">Recording</span>' : '',
    `<span>${escapeHtml(formatDate(r.createdAt))}</span>`,
    r.durationSec ? `<span>${formatDuration(r.durationSec)}</span>` : '',
    r.language && r.language !== 'auto' ? `<span>${escapeHtml(r.language.toUpperCase())}</span>` : '',
  ].join('');
  const open = openKey === r.key;
  let body = '';
  if (open && r.status === 'done') {
    const text = texts.get(r.id);
    body = `<div class="history-body">
      <div class="transcript-box">${text === undefined ? 'Loading…' : escapeHtml(text)}</div>
      <div class="actions">
        <button class="action" data-act="copy">Copy</button>
        <button class="action secondary" data-act="download">Download .txt</button>
        <button class="action secondary" data-act="delete">Delete</button>
      </div>
    </div>`;
  } else if (open && r.status === 'pending') {
    body = `<div class="history-body">
      <div class="actions">
        <button class="action" data-act="transcribe">Transcribe</button>
      </div>
    </div>`;
  }
  const expandable = r.status === 'done' || r.status === 'pending';
  return `<article class="history-item" data-key="${escapeHtml(r.key)}">
    <button aria-expanded="${open}" ${expandable ? '' : 'disabled'}><h4>${escapeHtml(r.title)}</h4><div class="history-meta">${meta}</div>${
      open ? '' : `<div class="history-snippet">${escapeHtml(r.preview)}</div>`
    }</button>${body}</article>`;
}

function paintHistory(): void {
  const list = $('historyList');
  const search = $('historySearch') as HTMLInputElement;
  search.hidden = !appRunning;
  $('historySource').textContent = appRunning ? 'The same History as in the Mova Flow app.' : '';
  if (!appRunning) {
    list.innerHTML = '<div id="historyAppStatus"></div>';
    void renderAppStatus($('historyAppStatus'));
    return;
  }
  const query = search.value.trim().toLowerCase();
  const shown = query
    ? rows.filter((r) => `${r.title} ${r.preview} ${texts.get(r.id) ?? ''}`.toLowerCase().includes(query))
    : rows;
  if (!rows.length) {
    list.innerHTML = '<div class="empty">No transcripts yet.<br>Record a call or upload a file — it will show up here.</div>';
  } else if (!shown.length) {
    list.innerHTML = '<div class="empty">Nothing matches your search.</div>';
  } else {
    list.innerHTML = shown.map(rowHtml).join('');
  }
}

async function renderHistory(): Promise<void> {
  await loadRows();
  paintHistory();
}

async function textOf(r: Row): Promise<string> {
  let text = texts.get(r.id);
  if (text === undefined) {
    text = await fetchAppHistoryText(r.id);
    texts.set(r.id, text);
  }
  return text;
}

function initHistory(): void {
  $('historySearch').addEventListener('input', () => paintHistory());
  $('historyList').addEventListener('click', async (ev) => {
    const target = ev.target as HTMLElement;
    const item = target.closest<HTMLElement>('.history-item');
    const row = rows.find((r) => r.key === item?.dataset.key);
    if (!row) return;
    const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (!act) {
      if (!target.closest('.history-item > button')) return;
      openKey = openKey === row.key ? null : row.key;
      paintHistory();
      if (openKey && row.status === 'done' && !texts.has(row.id)) {
        try {
          await textOf(row);
        } catch (err) {
          texts.set(row.id, (err as Error).message);
        }
        paintHistory();
      }
      return;
    }
    const btn = target.closest('button')!;
    if (act === 'copy') {
      await navigator.clipboard.writeText(await textOf(row));
      btn.textContent = 'Copied';
      setTimeout(() => (btn.textContent = 'Copy'), 1200);
    } else if (act === 'download') {
      downloadText(await textOf(row), row.file);
    } else if (act === 'delete') {
      // Two-step instead of confirm(): dialogs are unreliable in side panels.
      if (btn.dataset.armed !== '1') {
        btn.dataset.armed = '1';
        btn.textContent = 'Click again to delete';
        return;
      }
      await deleteAppHistoryEntry(row.id);
      openKey = null;
      await renderHistory();
    } else if (act === 'transcribe') {
      btn.disabled = true;
      try {
        await transcribeInApp(row.id);
        transcribing.add(row.id);
        openKey = null;
        paintHistory();
        await waitForApp(row.id, () => {});
      } catch {
        // the app's own History card says what went wrong
      } finally {
        transcribing.delete(row.id);
        await renderHistory();
      }
    }
  });
}

// ── upload ──────────────────────────────────────────────────────────────────
let chosenFile: File | null = null;
let uploading = false;

function chooseFile(file: File | undefined): void {
  if (!file || uploading) return;
  chosenFile = file;
  $('dropTitle').textContent = file.name;
  $('dropHint').textContent = `${(file.size / 1024 / 1024).toFixed(1)} MB · click to choose another`;
  ($('uploadBtn') as HTMLButtonElement).disabled = false;
  $('uploadStatus').innerHTML = '';
}

function uploadStatus(html: string): void {
  $('uploadStatus').innerHTML = html;
}

async function runUpload(): Promise<void> {
  if (!chosenFile || uploading) return;
  const file = chosenFile;
  const language = ($('uploadLanguage') as HTMLSelectElement).value;
  const baseName = file.name.replace(/\.[^.]+$/, '') || 'upload';
  const btn = $('uploadBtn') as HTMLButtonElement;
  uploading = true;
  btn.disabled = true;
  const progress = (m: string) => uploadStatus(`<div class="banner">${escapeHtml(m)}</div>`);
  try {
    // The app keeps waiting recordings as WAV — anything else is decoded
    // and resampled here first, like the app's own Upload tab does.
    let wav: Blob = file;
    if (!/\.wav$/i.test(file.name)) {
      progress('Converting the file...');
      wav = await fileToMonoWav(file);
    }
    progress('Handing it to Mova Flow...');
    const id = await handOverToApp(wav, `${baseName}.wav`, { transcribe: true, language });
    if (!id) {
      uploadStatus('<div id="uploadAppStatus"></div>');
      await renderAppStatus($('uploadAppStatus'));
      return;
    }
    const result = await waitForApp(id, progress);
    uploadStatus(`
      <div class="transcript-box">${escapeHtml(result.text)}</div>
      <div class="actions">
        <button class="action" id="uploadCopyBtn">Copy</button>
        <button class="action secondary" id="uploadDownloadBtn">Download .txt</button>
      </div>`);
    $('uploadCopyBtn').addEventListener('click', async (e) => {
      await navigator.clipboard.writeText(result.text);
      (e.currentTarget as HTMLButtonElement).textContent = 'Copied';
    });
    $('uploadDownloadBtn').addEventListener('click', () => downloadText(result.text, baseName));
  } catch (err) {
    const msg = (err as Error).message || String(err);
    const hint = /decode|EncodingError/i.test(msg) ? "This browser can't read that file's audio. Try mp3, m4a, wav or webm." : msg;
    uploadStatus(`<div class="error-text">${escapeHtml(hint)}</div>`);
  } finally {
    uploading = false;
    btn.disabled = !chosenFile;
  }
}

function initUpload(): void {
  const input = $('fileInput') as HTMLInputElement;
  const zone = $('dropzone');
  input.addEventListener('change', () => chooseFile(input.files?.[0]));
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('is-over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('is-over');
    chooseFile(e.dataTransfer?.files?.[0]);
  });
  $('uploadBtn').addEventListener('click', () => void runUpload());
}

// ── settings & more ─────────────────────────────────────────────────────────
async function initExtensionSettings(): Promise<void> {
  const box = $('panelOnClick') as HTMLInputElement;
  if (!('sidePanel' in chrome)) {
    box.closest('label')!.hidden = true;
    return;
  }
  const behavior = await chrome.sidePanel.getPanelBehavior();
  box.checked = !!behavior.openPanelOnActionClick;
  box.addEventListener('change', () => {
    void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: box.checked });
  });
}

function initMore(): void {
  $('versionNote').textContent = `Mova Flow Meet Recorder ${chrome.runtime.getManifest().version}`;
}

// ── boot ────────────────────────────────────────────────────────────────────
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.movaFlowStatus) {
    void updateRecordDot();
    // A finished recording is in the app's History by the time it's done.
    const stage = changes.movaFlowStatus.newValue?.stage;
    if (stage === 'done' || stage === 'error' || stage === 'saved-locally') void renderHistory();
  }
});

async function init(): Promise<void> {
  initNav();
  initHistory();
  initUpload();
  initMore();
  await initExtensionSettings();
  await mountRecordView($('statusArea'));
  await updateRecordDot();
}

void init();
