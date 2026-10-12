// What to tell the user when Chrome wants the extension invoked on the tab
// before it may be recorded (see background.ts) — shared by the record view
// and the hint next to the in-page button.

/** The ways that work, as trusted HTML: the shortcut and the page's context
 * menu always; the toolbar icon only when it opens the popup. */
export function grantWays(shortcut: string, iconGrants: boolean): string {
  const ways = [
    ...(iconGrants ? ['click the <b>Mova Flow</b> icon in the toolbar (marked <b>REC</b>)'] : []),
    ...(shortcut ? [`press <kbd>${shortcut.replace(/[<>&]/g, '')}</kbd>`] : []),
    'right-click the call page → <b>Record this call with Mova Flow</b>',
  ];
  const list = ways.length > 1 ? `${ways.slice(0, -1).join(', ')} or ${ways[ways.length - 1]}` : ways[0];
  return `Chrome only lets an extension record a tab once you've called on it there: ${list} — recording starts by itself.`;
}
