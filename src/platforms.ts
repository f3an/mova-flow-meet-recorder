// The call services the extension records. Recording itself is the same for
// all of them — capture the tab, plus the audio the page sends over WebRTC
// (callAudioHook.ts) — so a service only needs to be recognized by its URL.
// What differs is the extras: each gets the button in its own controls
// (content.ts), but only Google Meet gives speaker names (its captions) —
// elsewhere the other side is just "the others" — and Zoom needs another
// source for the user's own side (see callAudioHook.ts).
//
// Keep the hosts in sync with manifest.json (host_permissions and both
// content_scripts entries).

export interface CallPlatform {
  id: 'meet' | 'teams' | 'zoom' | 'jitsi';
  name: string;
  matches: (url: URL) => boolean;
  /** A short, stable label for the call, used in the recording's filename. */
  room: (url: URL) => string | null;
}

const lastSegment = (url: URL): string | null => url.pathname.split('/').filter(Boolean).pop() ?? null;
const isHost = (url: URL, host: string): boolean => url.hostname === host || url.hostname.endsWith(`.${host}`);

export const PLATFORMS: CallPlatform[] = [
  {
    id: 'meet',
    name: 'Google Meet',
    matches: (url) => url.hostname === 'meet.google.com',
    room: (url) => url.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i)?.[1] ?? null,
  },
  {
    id: 'teams',
    name: 'Microsoft Teams',
    matches: (url) => ['teams.microsoft.com', 'teams.live.com', 'teams.cloud.microsoft'].includes(url.hostname),
    // Teams keeps one URL for the whole app; the call has no id in it.
    room: () => null,
  },
  {
    id: 'zoom',
    name: 'Zoom',
    // Only the web client (/wc/) is a call — the rest of zoom.us just
    // launches the desktop app, which a browser extension can't record.
    matches: (url) => isHost(url, 'zoom.us') && url.pathname.startsWith('/wc/'),
    room: (url) => url.pathname.match(/\/wc\/(?:join\/)?(\d{9,12})/)?.[1] ?? null,
  },
  {
    id: 'jitsi',
    name: 'Jitsi Meet',
    matches: (url) => url.hostname === 'meet.jit.si',
    room: lastSegment,
  },
];

export function platformForUrl(href: string | undefined): CallPlatform | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    return PLATFORMS.find((p) => p.matches(url)) ?? null;
  } catch {
    return null;
  }
}

/** "Google Meet, Microsoft Teams, Zoom, …" — for messages that list them. */
export const PLATFORM_NAMES = PLATFORMS.map((p) => p.name).join(', ');

/** Recordings are named `<platform>-record-<room>-<date>.wav`; this reads the
 * platform back from such a name (Meet recordings predate the others, and
 * have always been "meet-record-…"). */
export function platformForRecording(filename: string): CallPlatform | null {
  const id = filename.match(/^([a-z]+)-record\b/)?.[1];
  return PLATFORMS.find((p) => p.id === id) ?? null;
}

/** A History title for a recording: "Google Meet · abc-defg-hij", "Microsoft
 * Teams call" — the date and time are shown next to it anyway. Anything not
 * named by this extension (an uploaded file) keeps its own name. */
export function recordingTitle(filename: string): string {
  const bare = filename.replace(/\.[^.]+$/, '');
  const platform = platformForRecording(bare);
  const room = bare.match(/^[a-z]+-record-(.*?)-?\d{4}-\d{2}-\d{2}T[\d-]+Z$/)?.[1];
  if (!platform || room === undefined) return bare;
  return room && room !== 'call' && room !== 'meeting' ? `${platform.name} · ${room}` : `${platform.name} call`;
}
