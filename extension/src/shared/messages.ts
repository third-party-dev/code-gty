// Messages between the extension host and the webview. Imported by both
// sides; the host validates everything it receives with `parseWebviewMessage`.

export interface WebviewConfig {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  fontWeight: string;
  fontWeightBold: string;
  cursorStyle: 'block' | 'underline' | 'bar';
  cursorBlink: boolean;
  cursorWidth: number;
  scrollback: number;
  copyOnSelection: boolean;
  rightClickBehavior: 'default' | 'copyPaste' | 'paste' | 'selectWord' | 'nothing';
  macOptionIsMeta: boolean;
  enableBell: boolean;
  drawBoldTextInBrightColors: boolean;
  minimumContrastRatio: number;
  customGlyphs: boolean;
  wordSeparators: string;
  kittyKeyboard: boolean;
  /** Kitty graphics on (both engines keep images) or off (storage limit 0). */
  images: boolean;
  /** Pass-through keys, already merged from defaults and settings. */
  passThroughKeys: string[];
  /**
   * Pass-through keys while a full-screen program (alternate screen: Neovim,
   * tmux, htop...) runs, or undefined to use `passThroughKeys` then too.
   */
  fullScreenPassThroughKeys?: string[];
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
  /**
   * Starts (or restarts) the mirror engine: from a snapshot of the host
   * engine when there is one, else empty. Output that follows continues from
   * exactly the snapshot's stream position.
   */
  | { type: 'attach'; snapshot?: Uint8Array; cols: number; rows: number }
  /** Bytes the host engine has processed. `ack` is false for bytes the host injected itself. */
  | { type: 'output'; data: Uint8Array; ack?: boolean }
  /** The host resized its engine and the PTY at this point in the stream. */
  | { type: 'resized'; cols: number; rows: number }
  | { type: 'focus' }
  | { type: 'selectAll' }
  | { type: 'copySelection' }
  | { type: 'find' }
  | { type: 'scrollToCommand'; direction: 'previous' | 'next' }
  | { type: 'exit'; message: string }
  | { type: 'persist'; state: PersistedState };

export type WebviewToHost =
  | { type: 'ready' }
  /** Encoded input for the program. `binary`: one byte per char code (legacy mouse formats). */
  | { type: 'input'; data: string; binary?: boolean }
  /** The size that fits, with the cell size in device pixels (for size reports and images). */
  | { type: 'resize'; cols: number; rows: number; cellWidth: number; cellHeight: number }
  | { type: 'ack'; bytes: number }
  | { type: 'copy'; text: string }
  /** Paste text (or the clipboard when absent); the host engine applies the program's paste modes. */
  | { type: 'paste'; text?: string }
  | { type: 'openLink'; kind: 'url' | 'file'; text: string }
  | { type: 'bell' }
  | { type: 'focusChanged'; focused: boolean }
  /** Colours as drawn, so the host engine answers colour queries with them. */
  | { type: 'theme'; foreground: number; background: number; cursor: number; palette: number[] }
  | { type: 'clear' }
  | { type: 'reattach' }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

const MAX_TEXT = 8 * 1024 * 1024;

function str(v: unknown, max = MAX_TEXT): v is string {
  return typeof v === 'string' && v.length <= max;
}
function int(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}
function rgb(v: unknown): v is number {
  return int(v, 0, 0xffffff);
}

/** Strict validation of untrusted webview messages. Returns undefined if invalid. */
export function parseWebviewMessage(m: unknown): WebviewToHost | undefined {
  if (typeof m !== 'object' || m === null) return undefined;
  const o = m as Record<string, unknown>;
  switch (o.type) {
    case 'ready':
    case 'bell':
    case 'reattach':
    case 'clear':
      return { type: o.type };
    case 'input':
      return str(o.data) ? { type: 'input', data: o.data, binary: o.binary === true } : undefined;
    case 'resize':
      return int(o.cols, 1, 2000) && int(o.rows, 1, 1000) && int(o.cellWidth, 1, 1000) && int(o.cellHeight, 1, 1000)
        ? { type: 'resize', cols: o.cols, rows: o.rows, cellWidth: o.cellWidth, cellHeight: o.cellHeight }
        : undefined;
    case 'ack':
      return int(o.bytes, 0, 0xffffffff) ? { type: 'ack', bytes: o.bytes } : undefined;
    case 'copy':
      return str(o.text) ? { type: 'copy', text: o.text } : undefined;
    case 'paste':
      if (o.text === undefined) return { type: 'paste' };
      return str(o.text) ? { type: 'paste', text: o.text } : undefined;
    case 'openLink':
      return (o.kind === 'url' || o.kind === 'file') && str(o.text, 8192) ? { type: 'openLink', kind: o.kind, text: o.text } : undefined;
    case 'focusChanged':
      return typeof o.focused === 'boolean' ? { type: 'focusChanged', focused: o.focused } : undefined;
    case 'theme':
      return rgb(o.foreground) && rgb(o.background) && rgb(o.cursor) && Array.isArray(o.palette) && o.palette.length === 16 && o.palette.every(rgb)
        ? { type: 'theme', foreground: o.foreground, background: o.background, cursor: o.cursor, palette: o.palette as number[] }
        : undefined;
    case 'log':
      return (o.level === 'info' || o.level === 'warn' || o.level === 'error') && str(o.message, 10000)
        ? { type: 'log', level: o.level, message: o.message }
        : undefined;
    default:
      return undefined;
  }
}
