// ghostty-web 0.4 keeps `viewportY` as "lines scrolled back from the bottom"
// and `scrollToLine(n)` sets that value directly. These helpers speak in
// absolute buffer lines (0 = oldest scrollback line) instead.

import type { Terminal } from 'ghostty-web';

export function viewportTop(t: Terminal): number {
  return t.getScrollbackLength() - Math.round(t.getViewportY());
}

export function setViewportTop(t: Terminal, line: number): void {
  const sb = t.getScrollbackLength();
  t.scrollToLine(Math.max(0, Math.min(sb, sb - line)));
}
