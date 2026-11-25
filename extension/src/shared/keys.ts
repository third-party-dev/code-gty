// Key pass-through: which key presses skip the shell and go to the workbench.
// VS Code has no API to read the user's keybindings, so this is a seeded list
// plus settings.

export interface KeySpec {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  key: string;
}

export type Platform = 'mac' | 'windows' | 'linux';

// Like VS Code's own terminal, a key goes to the workbench only when its
// default binding is a command in VS Code's DEFAULT_COMMANDS_TO_SKIP_SHELL
// (src/vs/workbench/contrib/terminal/common/terminal.ts). Everything else,
// Ctrl+B for tmux included, goes to the shell. Debug and task keys (F5, F10,
// Ctrl+Shift+B...) are left to the shell: their bindings only apply in some
// contexts, which a webview cannot see, and full-screen programs use them.
const COMMON_NON_MAC = [
  'ctrl+p', // workbench.action.quickOpen
  'ctrl+shift+p', // workbench.action.showCommands
  'f1',
  'ctrl+`', // terminal toggle
  'ctrl+shift+`', // new terminal
  'ctrl+alt+`', // new Ghostty terminal (this extension)
  'ctrl+j', // workbench.action.togglePanel
  'ctrl+tab', // quickOpen recently used editor
  'ctrl+shift+tab',
  'ctrl+pageup', // workbench.action.previousEditor
  'ctrl+pagedown', // workbench.action.nextEditor
  'ctrl+1', 'ctrl+2', 'ctrl+3', 'ctrl+4', 'ctrl+5', 'ctrl+6', 'ctrl+7', 'ctrl+8', // focus*EditorGroup
  'f6', // workbench.action.focusNextPart
  'shift+f6', // workbench.action.focusPreviousPart
  'f11', // workbench.action.toggleFullScreen
  'ctrl+=', 'ctrl+-', // workbench.action.zoomIn / zoomOut
];

const COMMON_MAC = [
  'cmd+p', 'cmd+shift+p', 'f1',
  'ctrl+`', 'ctrl+shift+`', 'ctrl+alt+`',
  'cmd+j', 'cmd+b',
  'ctrl+tab', 'ctrl+shift+tab',
  'cmd+1', 'cmd+2', 'cmd+3', 'cmd+4', 'cmd+5', 'cmd+6', 'cmd+7', 'cmd+8', 'cmd+9',
  'cmd+shift+e', 'cmd+shift+f', 'cmd+shift+g', 'cmd+shift+x', 'cmd+shift+d', 'cmd+shift+m', 'cmd+shift+u', 'cmd+shift+y',
  'cmd+,', 'cmd+shift+n', 'cmd+n', 'cmd+w', 'cmd+q', 'cmd+t', 'cmd+s', 'cmd+o',
  'cmd+=', 'cmd+-', 'cmd+0',
  'cmd+alt+left', 'cmd+alt+right', 'cmd+shift+[', 'cmd+shift+]',
];

/** Keys that still reach the workbench with sendKeybindingsToShell on. */
const ALWAYS = { mac: ['cmd+shift+p', 'f1'], windows: ['ctrl+shift+p', 'f1'], linux: ['ctrl+shift+p', 'f1'] };

/** Keys that reach the workbench even while a full-screen program has the keyboard. */
export function fullScreenPassThrough(platform: Platform): string[] {
  return ALWAYS[platform];
}

export function defaultPassThrough(platform: Platform, sendKeybindingsToShell: boolean): string[] {
  if (sendKeybindingsToShell) return ALWAYS[platform];
  return platform === 'mac' ? COMMON_MAC : COMMON_NON_MAC;
}

/** Parses "ctrl+shift+p" / "cmd+k". Returns undefined for nonsense. */
export function parseKey(spec: string): KeySpec | undefined {
  const parts = spec.toLowerCase().trim().split('+');
  // "ctrl++" -> key "+"
  if (spec.endsWith('++')) parts.splice(parts.length - 2, 2, '+');
  const k: KeySpec = { ctrl: false, shift: false, alt: false, meta: false, key: '' };
  for (const p of parts.slice(0, -1)) {
    if (p === 'ctrl' || p === 'control') k.ctrl = true;
    else if (p === 'shift') k.shift = true;
    else if (p === 'alt' || p === 'option' || p === 'opt') k.alt = true;
    else if (p === 'cmd' || p === 'meta' || p === 'win' || p === 'super') k.meta = true;
    else return undefined;
  }
  k.key = parts[parts.length - 1];
  return k.key ? k : undefined;
}

/** Maps KeyboardEvent.code to the names used in key specs (layout independent for letters and digits). */
export function keyName(code: string, key: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F[0-9]{1,2}$/.test(code)) return code.toLowerCase();
  switch (code) {
    case 'Backquote': return '`';
    case 'Minus': return '-';
    case 'Equal': return '=';
    case 'BracketLeft': return '[';
    case 'BracketRight': return ']';
    case 'Backslash': return '\\';
    case 'Semicolon': return ';';
    case 'Quote': return "'";
    case 'Comma': return ',';
    case 'Period': return '.';
    case 'Slash': return '/';
    case 'ArrowLeft': return 'left';
    case 'ArrowRight': return 'right';
    case 'ArrowUp': return 'up';
    case 'ArrowDown': return 'down';
    case 'PageUp': return 'pageup';
    case 'PageDown': return 'pagedown';
    case 'Enter': case 'NumpadEnter': return 'enter';
    case 'Escape': return 'escape';
    case 'Tab': return 'tab';
    case 'Space': return 'space';
    case 'Backspace': return 'backspace';
    case 'Delete': return 'delete';
    case 'Insert': return 'insert';
    case 'Home': return 'home';
    case 'End': return 'end';
    default: return key.toLowerCase();
  }
}

export interface KeyEventLike {
  code: string;
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export function matches(spec: KeySpec, e: KeyEventLike): boolean {
  return (
    spec.ctrl === e.ctrlKey &&
    spec.shift === e.shiftKey &&
    spec.alt === e.altKey &&
    spec.meta === e.metaKey &&
    spec.key === keyName(e.code, e.key)
  );
}

export class KeyMatcher {
  private readonly specs: KeySpec[];
  constructor(list: string[]) {
    this.specs = list.map(parseKey).filter((k): k is KeySpec => k !== undefined);
  }
  test(e: KeyEventLike): boolean {
    return this.specs.some((s) => matches(s, e));
  }
}
