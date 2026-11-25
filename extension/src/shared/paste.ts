// Paste helpers. Encoding (bracketed paste, unsafe-byte stripping, Kitty
// paste events) is done by the host engine with ghostty_terminal_paste.

/** True if the text has a line break other than one trailing newline. */
export function isMultiline(text: string): boolean {
  const t = text.replace(/\r?\n$/, '');
  return /[\r\n]/.test(t);
}
