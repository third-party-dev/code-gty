// Browser keyboard events -> libghostty-vt key events.

import { KEY_CODES, KeyInput, Mods } from '../vt/input';

/** Unshifted characters of a US layout, for engines without navigator.keyboard. */
const US: Record<string, string> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  IntlBackslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: ' ',
};
for (let c = 65; c <= 90; c++) US[`Key${String.fromCharCode(c)}`] = String.fromCharCode(c + 32);
for (let d = 0; d <= 9; d++) US[`Digit${d}`] = String(d);

let layout: Map<string, string> | undefined;

/** Loads the real layout map where the browser offers one (Chromium, not in every iframe). */
export async function loadLayoutMap(): Promise<void> {
  try {
    const kb = (navigator as unknown as { keyboard?: { getLayoutMap(): Promise<Map<string, string>> } }).keyboard;
    if (kb?.getLayoutMap) layout = new Map(await kb.getLayoutMap());
  } catch {
    layout = undefined;
  }
}

export function unshiftedCodepoint(code: string): number {
  const ch = layout?.get(code) ?? US[code];
  return ch ? ch.codePointAt(0)! : 0;
}

export function modsOf(e: KeyboardEvent | MouseEvent | WheelEvent): number {
  let m = 0;
  if (e.shiftKey) m |= Mods.SHIFT;
  if (e.ctrlKey) m |= Mods.CTRL;
  if (e.altKey) m |= Mods.ALT;
  if (e.metaKey) m |= Mods.SUPER;
  if ('getModifierState' in e) {
    if (e.getModifierState('CapsLock')) m |= Mods.CAPS_LOCK;
    if (e.getModifierState('NumLock')) m |= Mods.NUM_LOCK;
  }
  if ('location' in e && e.location === 2) {
    // Right-hand modifier keys report their own side.
    if (e.key === 'Shift') m |= Mods.SHIFT_RIGHT;
    if (e.key === 'Control') m |= Mods.CTRL_RIGHT;
    if (e.key === 'Alt') m |= Mods.ALT_RIGHT;
    if (e.key === 'Meta') m |= Mods.SUPER_RIGHT;
  }
  return m;
}

/** Text the key produces, or '' for named keys ("Enter", "ArrowUp", ...). */
function keyText(e: KeyboardEvent): string {
  const k = e.key;
  if (!k || k === 'Dead' || k === 'Unidentified' || k === 'Process') return '';
  // A single grapheme (possibly more than one UTF-16 unit) is text; names are longer words.
  if ([...k].length === 1) return k;
  return '';
}

/**
 * Converts a keydown/keyup event. `macOptionProducesText` is true on macOS
 * when Option is not used as Meta: then Option is consumed by the layout.
 */
export function toKeyInput(e: KeyboardEvent, action: KeyInput['action'], macOptionProducesText: boolean): KeyInput {
  const mods = modsOf(e);
  const text = keyText(e);
  const unshifted = unshiftedCodepoint(e.code);
  let consumed = 0;
  if (text) {
    if (e.shiftKey && text.codePointAt(0) !== unshifted) consumed |= Mods.SHIFT;
    if (e.altKey && macOptionProducesText) consumed |= Mods.ALT;
  }
  return {
    action,
    key: KEY_CODES.get(e.code) ?? 0,
    mods,
    consumedMods: consumed,
    text,
    unshifted,
    composing: e.isComposing,
  };
}
