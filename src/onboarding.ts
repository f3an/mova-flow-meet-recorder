// Opened once on install (see chrome.runtime.onInstalled in background.ts),
// and reachable any time after from the Meet button's "open-popup" fallback —
// the one full walkthrough: where the record button lives, and connecting
// to a host. There's no permission to grant: the call is captured from the
// tab, and the user's own voice from what Meet itself sends (meetAudioHook.ts).
import { initSettingsPanel } from './settingsPanel';

void initSettingsPanel();
