// Messages between the extension host and the webview. Imported by both
// sides; the host validates everything it receives with `parseWebviewMessage`.

export interface WebviewConfig {
  fontFamily: string;
  fontSize: number;
  cursorStyle: 'block' | 'underline' | 'bar';
  cursorBlink: boolean;
  scrollback: number;
  copyOnSelection: boolean;
  rightClickBehavior: 'default' | 'copyPaste' | 'paste' | 'selectWord' | 'nothing';
  macOptionIsMeta: boolean;
  enableBell: boolean;
  /** Pass-through keys, already merged from defaults and settings. */
  passThroughKeys: string[];
  shellKeys: string[];
  sendKeybindingsToShell: boolean;
  allowChords: boolean;
  /** 'alt' when links open with Alt+click (editor.multiCursorModifier = ctrlCmd). */
  linkModifier: 'ctrlCmd' | 'alt';
  colors: Record<string, string>;
  platform: 'mac' | 'windows' | 'linux';
  accessibility: boolean;
}

/** Stored with vscode.setState so the serializer can restore the tab. */
export interface PersistedState {
  cwd?: string;
  title?: string;
  renamed?: string;
}

export type HostToWebview =
  | { type: 'init'; config: WebviewConfig; restored: boolean }
  | { type: 'config'; config: WebviewConfig }
  | { type: 'output'; data: Uint8Array }
  | { type: 'replay'; data: Uint8Array; truncated: boolean }
  | { type: 'paste'; text: string }
  | { type: 'focus' }
  | { type: 'clear' }
  | { type: 'selectAll' }
  | { type: 'copySelection' }
  | { type: 'find' }
  | { type: 'scrollToCommand'; direction: 'previous' | 'next' }
  | { type: 'notice'; text: string }
  | { type: 'exit'; message: string }
  | { type: 'requestRecentOutput' }
  | { type: 'persist'; state: PersistedState };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ack'; bytes: number }
  | { type: 'copy'; text: string }
  | { type: 'paste'; text?: string; bracketed: boolean }
  | { type: 'openLink'; kind: 'url' | 'file'; text: string }
  | { type: 'bell' }
  | { type: 'focusChanged'; focused: boolean }
  | { type: 'recentOutput'; text: string }
  | { type: 'reattach' }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

const MAX_TEXT = 8 * 1024 * 1024;

function str(v: unknown, max = MAX_TEXT): v is string {
  return typeof v === 'string' && v.length <= max;
}
function int(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

/** Strict validation of untrusted webview messages. Returns undefined if invalid. */
export function parseWebviewMessage(m: unknown): WebviewToHost | undefined {
  if (typeof m !== 'object' || m === null) return undefined;
  const o = m as Record<string, unknown>;
  switch (o.type) {
    case 'ready':
    case 'bell':
    case 'reattach':
      return { type: o.type };
    case 'input':
      return str(o.data) ? { type: 'input', data: o.data } : undefined;
    case 'resize':
      return int(o.cols, 1, 2000) && int(o.rows, 1, 1000) ? { type: 'resize', cols: o.cols, rows: o.rows } : undefined;
    case 'ack':
      return int(o.bytes, 0, 0xffffffff) ? { type: 'ack', bytes: o.bytes } : undefined;
    case 'copy':
      return str(o.text) ? { type: 'copy', text: o.text } : undefined;
    case 'paste': {
      const bracketed = o.bracketed === true;
      if (o.text === undefined) return { type: 'paste', bracketed };
      return str(o.text) ? { type: 'paste', text: o.text, bracketed } : undefined;
    }
    case 'openLink':
      return (o.kind === 'url' || o.kind === 'file') && str(o.text, 8192) ? { type: 'openLink', kind: o.kind, text: o.text } : undefined;
    case 'focusChanged':
      return typeof o.focused === 'boolean' ? { type: 'focusChanged', focused: o.focused } : undefined;
    case 'recentOutput':
      return str(o.text) ? { type: 'recentOutput', text: o.text } : undefined;
    case 'log':
      return (o.level === 'info' || o.level === 'warn' || o.level === 'error') && str(o.message, 10000)
        ? { type: 'log', level: o.level, message: o.message }
        : undefined;
    default:
      return undefined;
  }
}
