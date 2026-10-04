// Logs who spoke when, from Meet's own live captions, while a recording runs.
// Each caption block on screen is one speaker's turn: an avatar + display
// name header and the words below it, which Meet keeps rewriting in place as
// the speaker goes on. The host uses this timeline only to put names on the
// "other side" of the call — telling the user apart from everyone else is
// already done by the recording's channels (user left, call right).
//
// Same caveat as the toolbar button in content.ts: Meet's markup is
// obfuscated and changes without notice. Every lookup here tries the most
// semantic hook first and falls back to the structure observed in Oct 2026:
//   div[role=region][aria-label="Captions"]
//     div.nMcdL                       ← one per turn
//       div.adE6rb > img + div > span ← avatar + name
//       div.ygicle                    ← the words
// If none of it matches any more, recordings just go out without names.
import type { SpeakerTurn } from './state';

const CAPTIONS_BUTTON = 'button[jsname="RrG0hf"]';
// Meet labels the user's own captions with a localized "You". Their side is
// known from the left channel anyway, so these only need to be kept out of
// the names given to other people — a miss here just means a stray "You"
// on a crosstalk line, not a wrong attribution.
const SELF_LABELS = new Set(['you', 'ви', 'вы', 'ty', 'du', 'vous', 'tú', 'tu', 'voi', 'jij', 'você', 'sen', 'siz']);

function findCaptionRegion(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>('div[role="region"][aria-label="Captions" i]') ??
    document.querySelector<HTMLElement>('button[jsname="Xke7ne"]')?.closest<HTMLElement>('[role="region"]') ??
    document.querySelector<HTMLElement>('.nMcdL')?.closest<HTMLElement>('[role="region"]') ??
    null
  );
}

/** A turn block is a direct child of the region with an avatar in its header
 * and the caption text as its last child — the region also holds unrelated
 * children (the "jump to most recent" button, spacers) that have neither. */
function readBlock(block: Element): { name: string; text: string } | null {
  const header = block.firstElementChild;
  const body = block.lastElementChild;
  if (!header || !body || header === body || !header.querySelector('img')) return null;
  const name = (header as HTMLElement).innerText.trim();
  const text = (body as HTMLElement).innerText.trim();
  return name ? { name, text } : null;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export class CaptionLogger {
  private turns: SpeakerTurn[] = [];
  private byBlock = new WeakMap<Element, { turn: SpeakerTurn; text: string }>();
  private observer: MutationObserver | null = null;
  private startedAt = 0;
  private enabledCaptions = false;

  /** `earlier`: turns already logged for this recording, if this tab was
   * reloaded mid-call. */
  start(startedAt: number, earlier: SpeakerTurn[] = []): void {
    this.stop();
    this.turns = [...earlier];
    this.byBlock = new WeakMap();
    this.startedAt = startedAt;
    this.enabledCaptions = false;
    // Whatever is already on screen was said before the recording started.
    const region = findCaptionRegion();
    for (const block of region ? Array.from(region.children) : []) {
      const read = readBlock(block);
      if (read) this.byBlock.set(block, { turn: { name: read.name, start: 0, end: 0, words: 0 }, text: read.text });
    }
    // Without captions on there's nothing to read — turn them on for the
    // recording (they only ever show on this user's own screen) and put
    // them back off afterwards if that's how they were.
    if (!findCaptionRegion()) {
      const button = document.querySelector<HTMLButtonElement>(CAPTIONS_BUTTON);
      if (button) {
        button.click();
        this.enabledCaptions = true;
      }
    }
    // The whole body, not just the region: the region itself is torn down and
    // rebuilt whenever captions get toggled or the layout changes.
    this.observer = new MutationObserver(() => this.scan());
    this.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    this.scan();
  }

  /** Stops logging and returns the turns collected since start(). */
  stop(): SpeakerTurn[] {
    if (!this.observer) return this.turns;
    this.scan();
    this.observer.disconnect();
    this.observer = null;
    if (this.enabledCaptions && findCaptionRegion()) {
      document.querySelector<HTMLButtonElement>(CAPTIONS_BUTTON)?.click();
    }
    this.enabledCaptions = false;
    return this.turns;
  }

  get snapshot(): SpeakerTurn[] {
    return this.turns;
  }

  private scan(): void {
    const region = findCaptionRegion();
    if (!region) return;
    const now = (Date.now() - this.startedAt) / 1000;
    for (const block of Array.from(region.children)) {
      const read = readBlock(block);
      if (!read || !read.text) continue;
      const seen = this.byBlock.get(block);
      if (!seen) {
        const turn: SpeakerTurn = { name: read.name, start: now, end: now, words: countWords(read.text) };
        if (SELF_LABELS.has(read.name.toLowerCase())) turn.self = true;
        this.turns.push(turn);
        this.byBlock.set(block, { turn, text: read.text });
      } else if (seen.text !== read.text) {
        seen.text = read.text;
        seen.turn.end = now;
        seen.turn.words = countWords(read.text);
      }
    }
  }
}
