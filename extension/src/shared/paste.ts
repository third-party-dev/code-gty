// Paste preparation, matching xterm.js and the built-in terminal.

/** Strips embedded bracketed-paste markers (a paste must not end its own bracket) and normalises newlines to CR. */
export function preparePaste(text: string): string {
  return text.replace(/\x1b\[20[01]~/g, '').replace(/\r?\n/g, '\r');
}

export function isMultiline(text: string): boolean {
  const t = text.replace(/\r?\n$/, '');
  return /[\r\n]/.test(t);
}
