// GhosttyTerminal: state, options, writes and effects (callbacks).

import { E, NO_VALUE, OK, Rgb, S, Vt, VtError, utf8Encoder } from './core';

const O = E.GhosttyTerminalOption;
const D = E.GhosttyTerminalData;

/** Packs a mode number the way GHOSTTY_MODE_* macros do. */
export function mode(value: number, ansi = false): number {
  return (value & 0x7fff) | (ansi ? 0x8000 : 0);
}

export const Modes = {
  INSERT: mode(4, true),
  LINEFEED: mode(20, true),
  CURSOR_KEYS: mode(1),
  REVERSE_COLORS: mode(5),
  ORIGIN: mode(6),
  WRAPAROUND: mode(7),
  CURSOR_BLINKING: mode(12),
  CURSOR_VISIBLE: mode(25),
  KEYPAD_KEYS: mode(66),
  MOUSE_EVENT_X10: mode(9),
  MOUSE_EVENT_NORMAL: mode(1000),
  MOUSE_EVENT_BUTTON: mode(1002),
  MOUSE_EVENT_ANY: mode(1003),
  FOCUS_EVENT: mode(1004),
  MOUSE_ALTERNATE_SCROLL: mode(1007),
  ALT_SCREEN: mode(1047),
  ALT_SCREEN_1049: mode(1049),
  BRACKETED_PASTE: mode(2004),
  SYNCHRONIZED_OUTPUT: mode(2026),
  GRAPHEME_CLUSTER: mode(2027),
  REPORT_COLOR_SCHEME: mode(2031),
  IN_BAND_SIZE_REPORTS: mode(2048),
  KITTY_PASTE_EVENTS: mode(5522),
} as const;

export type ClipboardLocation = 'standard' | 'selection' | 'primary';
const LOCATIONS: ClipboardLocation[] = ['standard', 'selection', 'primary'];

export interface ClipboardContent {
  mime: string;
  data: Uint8Array;
}

export interface ClipboardWriteRequest {
  location: ClipboardLocation;
  /** Empty means "clear the clipboard". */
  contents: ClipboardContent[];
  /** Program name, when the protocol carries one (OSC 5522). */
  name: string;
  /** A session grant already covers this request: skip any prompt. */
  granted: boolean;
  canRemember: boolean;
}
export type ClipboardWriteResult = keyof typeof E.GhosttyClipboardWriteResult;

export interface ClipboardReadRequest {
  location: ClipboardLocation;
  /** Requested MIME types, most preferred first ("text/plain" for OSC 52). */
  mimes: string[];
  /** The program also wants the list of available types. */
  list: boolean;
  name: string;
  granted: boolean;
  canRemember: boolean;
}
export interface ClipboardReadReply {
  result: keyof typeof E.GhosttyClipboardReadResult;
  contents?: ClipboardContent[];
  available?: string[];
  remember?: boolean;
}

export interface SemanticPromptEvent {
  kind: 'promptStart' | 'inputStart' | 'outputStart' | 'commandEnd';
  promptKind: 'primary' | 'right' | 'continuation' | 'secondary';
  exitCode?: number;
  command: string;
  error: string;
}

export interface ProgramStatusReport {
  state: 'idle' | 'working' | 'done' | 'blocked' | 'error' | 'clear';
  kind: 'none' | 'permission' | 'question' | 'auth';
  /** 0..100, or -1 when indeterminate or absent. */
  progress: number;
  id: string;
  app: string;
  title: string;
  message: string;
}

export type ProgressState = 'remove' | 'set' | 'error' | 'indeterminate' | 'pause';

export type UnknownSequence =
  | { kind: 'apc'; content: Uint8Array; truncated: boolean }
  | { kind: 'osc'; content: Uint8Array; truncated: boolean; terminator: 'st' | 'bel' };

export interface DeviceAttributes {
  /** DA1: conformance level (62 = VT220) and feature numbers. */
  conformance: number;
  features: number[];
  /** DA2. */
  deviceType: number;
  firmwareVersion: number;
  romCartridge: number;
  /** DA3. */
  unitId: number;
}

export interface SizeReport {
  rows: number;
  cols: number;
  cellWidth: number;
  cellHeight: number;
}

/**
 * Effects: what a program asks of the terminal. Only the ones provided are
 * registered, so a terminal without `writePty` answers no queries.
 * Handlers run synchronously inside `write`; they must not write to the same
 * terminal. Exceptions are caught and passed to `onError`.
 */
export interface Effects {
  writePty?(data: Uint8Array): void;
  bell?(): void;
  titleChanged?(title: string): void;
  pwdChanged?(pwd: string): void;
  size?(): SizeReport | undefined;
  colorScheme?(): 'light' | 'dark' | undefined;
  deviceAttributes?(): DeviceAttributes | undefined;
  clipboardWrite?(req: ClipboardWriteRequest): { result: ClipboardWriteResult; remember?: boolean };
  clipboardRead?(req: ClipboardReadRequest): ClipboardReadReply;
  desktopNotification?(title: string, body: string): void;
  progressReport?(state: ProgressState, progress: number): void;
  programStatus?(report: ProgramStatusReport): void;
  unknownSequence?(seq: UnknownSequence): void;
  renderHold?(held: boolean): void;
  semanticPrompt?(ev: SemanticPromptEvent): void;
  reset?(): void;
  resizeWindow?(rows: number, cols: number): void;
  onError?(e: unknown): void;
}

export interface TerminalColors {
  foreground?: Rgb;
  background?: Rgb;
  cursor?: Rgb;
  /** Up to 256 entries; missing entries keep the default palette. */
  palette?: Rgb[];
}

export interface TerminalOptions {
  cols: number;
  rows: number;
  scrollbackBytes?: number;
  scrollbackLines?: number;
  /** Track unfinished input so snapshots can be taken mid-sequence. */
  continuationMaxBytes?: number;
  /** Report unknown OSC/APC sequences up to this many bytes (0 = off). */
  unknownMaxBytes?: number;
  clipboardWriteMaxBytes?: number;
  colors?: TerminalColors;
  cursorStyle?: 'bar' | 'block' | 'underline';
  cursorBlink?: boolean;
  /** XTVERSION reply. Empty uses the library default. */
  xtversion?: string;
  /** ENQ answerback. */
  answerback?: string;
  /** Allow OSC 21 / title reporting (CSI 21 t). Off by default for safety. */
  titleReport?: boolean;
  effects?: Effects;
  /** Kitty graphics image storage limit in bytes (0 disables images). */
  kittyImageStorageLimit?: number;
  /**
   * Modes on (or off) from the start and after a full reset (RIS), like
   * Ghostty's own defaults. Key: a packed mode (see `Modes`).
   */
  modeDefaults?: Record<number, boolean>;
}

/**
 * What the Ghostty app turns on by default: width by grapheme cluster
 * (mode 2027), so emoji with VS16, flags and ZWJ sequences take 2 cells.
 * Host and mirror must use the same defaults.
 */
export const GHOSTTY_MODE_DEFAULTS: Record<number, boolean> = { [mode(2027)]: true };

export interface WriteStop {
  consumed: number;
  reached: number;
  kind: 'apc' | 'dcs' | 'osc';
  byte: number;
}

export interface Scrollbar {
  total: number;
  offset: number;
  len: number;
}

export type ScrollTo = { top: true } | { bottom: true } | { delta: number } | { row: number } | { prompts: number };

const SEMANTIC_KIND: SemanticPromptEvent['kind'][] = ['promptStart', 'promptStart', 'inputStart', 'outputStart', 'commandEnd'];
const PROMPT_KIND: SemanticPromptEvent['promptKind'][] = ['primary', 'right', 'continuation', 'secondary'];
const STATUS_STATE: ProgramStatusReport['state'][] = ['idle', 'working', 'done', 'blocked', 'error', 'clear'];
const STATUS_KIND: ProgramStatusReport['kind'][] = ['none', 'permission', 'question', 'auth'];
const PROGRESS_STATE: ProgressState[] = ['remove', 'set', 'error', 'indeterminate', 'pause'];
const STRING_KIND: WriteStop['kind'][] = ['apc', 'dcs', 'osc'];

/** Terminals by userdata id, for the shared callback thunks. */
const registry = new WeakMap<Vt, Map<number, Terminal>>();
let nextId = 1;

function lookup(vt: Vt, userdata: number): Terminal | undefined {
  return registry.get(vt)?.get(userdata >>> 0);
}

export class Terminal {
  readonly id: number;
  private disposed = false;
  private inPtr = 0;
  private inCap = 0;
  private stopPtr = 0;
  private replyStrings: { ptr: number; len: number }[] = [];
  private effects: Effects;
  /** Data for an in-flight paste, read by the mime-reader thunk. */
  pasteData: Uint8Array | undefined;

  private constructor(
    readonly vt: Vt,
    readonly handle: number,
    effects: Effects,
  ) {
    this.id = nextId++;
    this.effects = effects;
    let map = registry.get(vt);
    if (!map) registry.set(vt, (map = new Map()));
    map.set(this.id, this);
    vt.check(vt.ex.ghostty_terminal_set(handle, O.USERDATA, this.id), 'set userdata');
    vt.leaks?.register(this, `terminal ${this.id}`, this);
  }

  static create(vt: Vt, opts: TerminalOptions): Terminal {
    const handle = vt.construct('ghostty_terminal_new', (slot) => vt.ex.ghostty_terminal_new(0, slot, opts.cols, opts.rows));
    const t = new Terminal(vt, handle, opts.effects ?? {});
    t.configure(opts);
    return t;
  }

  /** Wraps a terminal produced by the snapshot decoder. */
  static adopt(vt: Vt, handle: number, opts: Omit<TerminalOptions, 'cols' | 'rows'>): Terminal {
    const t = new Terminal(vt, handle, opts.effects ?? {});
    // The snapshot carries the current modes; only the defaults (for a later
    // RIS) are set here.
    const { modeDefaults, ...rest } = opts;
    t.configure({ ...rest, cols: 0, rows: 0 });
    for (const [m, on] of Object.entries(modeDefaults ?? {})) t.setModeDefault(Number(m), on, false);
    return t;
  }

  private configure(opts: TerminalOptions): void {
    if (opts.scrollbackBytes !== undefined) this.setU32(O.SCROLLBACK_MAX_BYTES, opts.scrollbackBytes);
    if (opts.scrollbackLines !== undefined) this.setU32(O.SCROLLBACK_MAX_LINES, opts.scrollbackLines);
    if (opts.continuationMaxBytes !== undefined) this.setU32(O.CONTINUATION_MAX_BYTES, opts.continuationMaxBytes);
    if (opts.unknownMaxBytes !== undefined) this.setU32(O.UNKNOWN_MAX_BYTES, opts.unknownMaxBytes);
    if (opts.clipboardWriteMaxBytes !== undefined) this.setU32(O.CLIPBOARD_WRITE_MAX_BYTES, opts.clipboardWriteMaxBytes);
    if (opts.titleReport !== undefined) this.setBool(O.TITLE_REPORT, opts.titleReport);
    if (opts.kittyImageStorageLimit !== undefined && this.vt.features.kittyGraphics) this.setU64(O.KITTY_IMAGE_STORAGE_LIMIT, opts.kittyImageStorageLimit);
    for (const [m, on] of Object.entries(opts.modeDefaults ?? {})) this.setModeDefault(Number(m), on);
    if (opts.colors) this.setColors(opts.colors);
    if (opts.cursorStyle) this.setCursorDefaults(opts.cursorStyle, opts.cursorBlink ?? false);
    this.setReplyStrings(opts.xtversion ?? '', opts.answerback ?? '');
    this.setEffects(opts.effects ?? {});
  }

  // ---- options -----------------------------------------------------------

  private set(option: number, value: number, what: string): void {
    this.vt.check(this.vt.ex.ghostty_terminal_set(this.handle, option, value), what);
  }

  private setU32(option: number, v: number): void {
    this.vt.withScratch((take) => {
      const p = take(4);
      this.vt.dv.setUint32(p, Math.min(v, 0xffffffff) >>> 0, true);
      this.set(option, p, `set option ${option}`);
    });
  }

  private setU64(option: number, v: number): void {
    this.vt.withScratch((take) => {
      const p = take(8);
      this.vt.dv.setBigUint64(p, BigInt(Math.max(0, Math.floor(v))), true);
      this.set(option, p, `set option ${option}`);
    });
  }

  private setBool(option: number, v: boolean): void {
    this.vt.withScratch((take) => {
      const p = take(1);
      this.vt.u8[p] = v ? 1 : 0;
      this.set(option, p, `set option ${option}`);
    });
  }

  /** Kitty graphics storage limit; 0 turns the protocol off and drops every image. */
  setKittyImageLimit(bytes: number): void {
    if (this.vt.features.kittyGraphics) this.setU64(O.KITTY_IMAGE_STORAGE_LIMIT, bytes);
  }

  setScrollback(bytes: number | undefined, lines: number | undefined): void {
    if (bytes !== undefined) this.setU32(O.SCROLLBACK_MAX_BYTES, bytes);
    if (lines !== undefined) this.setU32(O.SCROLLBACK_MAX_LINES, lines);
  }

  /** Sets the default colours (what OSC 10/11/12/4 resets return to). */
  setColors(c: TerminalColors): void {
    const vt = this.vt;
    vt.withScratch((take) => {
      const rgb = take(3, 1);
      const one = (opt: number, v: Rgb | undefined) => {
        if (v === undefined) return;
        vt.setRgb(rgb, v);
        this.set(opt, rgb, 'set colour');
      };
      one(O.COLOR_FOREGROUND, c.foreground);
      one(O.COLOR_BACKGROUND, c.background);
      one(O.COLOR_CURSOR, c.cursor);
      if (c.palette?.length) {
        const pal = take(768, 1);
        const cur = this.palette(true);
        for (let i = 0; i < 256; i++) vt.setRgb(pal + i * 3, c.palette[i] ?? cur[i]);
        this.set(O.COLOR_PALETTE, pal, 'set palette');
      }
    });
  }

  setCursorDefaults(style: 'bar' | 'block' | 'underline', blink: boolean): void {
    const v = { bar: E.GhosttyCursorStyle.BAR, block: E.GhosttyCursorStyle.BLOCK, underline: E.GhosttyCursorStyle.UNDERLINE }[style];
    this.vt.withScratch((take) => {
      const p = take(4);
      this.vt.dv.setInt32(p, v, true);
      this.set(O.DEFAULT_CURSOR_STYLE, p, 'set cursor style');
    });
    this.setBool(O.DEFAULT_CURSOR_BLINK, blink);
  }

  /** XTVERSION and ENQ replies are read by the library after the callback returns, so they live in our own allocations. */
  setReplyStrings(xtversion: string, answerback: string): void {
    for (const s of this.replyStrings) this.vt.free(s.ptr, s.len + 1);
    this.replyStrings = [xtversion, answerback].map((s) => {
      const bytes = utf8Encoder.encode(s);
      const ptr = this.vt.alloc(bytes.length + 1);
      this.vt.u8.set(bytes, ptr);
      return { ptr, len: bytes.length };
    });
  }

  /** Replaces the effect handlers. Options for absent handlers are cleared. */
  setEffects(effects: Effects): void {
    this.effects = effects;
    const vt = this.vt;
    const has = (k: keyof Effects) => effects[k] !== undefined;
    const reg = (opt: number, enabled: boolean, key: string, sig: Parameters<Vt['callback']>[1], fn: (...a: number[]) => number | void) => {
      this.set(opt, enabled ? vt.callback(key, sig, fn) : 0, `set effect ${key}`);
    };
    const v = (n: number) => ['i32', ...Array(n - 1).fill('i32')] as ('i32')[];
    const call = <T>(ud: number, f: (t: Terminal) => T, fallback: T): T => {
      const t = lookup(vt, ud);
      if (!t || t.disposed) return fallback;
      try {
        return f(t);
      } catch (e) {
        t.effects.onError?.(e);
        return fallback;
      }
    };

    reg(O.WRITE_PTY, has('writePty'), 'write_pty', { params: v(4) }, (_t, ud, ptr, len) =>
      call(ud, (t) => t.effects.writePty?.(vt.copyOut(ptr >>> 0, len >>> 0)), undefined),
    );
    reg(O.BELL, has('bell'), 'bell', { params: v(2) }, (_t, ud) => call(ud, (t) => t.effects.bell?.(), undefined));
    reg(O.TITLE_CHANGED, has('titleChanged'), 'title', { params: v(2) }, (_t, ud) =>
      call(ud, (t) => t.effects.titleChanged?.(t.title), undefined),
    );
    reg(O.PWD_CHANGED, has('pwdChanged'), 'pwd', { params: v(2) }, (_t, ud) => call(ud, (t) => t.effects.pwdChanged?.(t.pwd), undefined));
    // Struct returns are lowered to a hidden first out-pointer on wasm32.
    reg(O.XTVERSION, true, 'xtversion', { params: v(3) }, (out, _t, ud) =>
      call(ud, (t) => t.writeReplyString(out >>> 0, 0), undefined),
    );
    reg(O.ENQUIRY, true, 'enquiry', { params: v(3) }, (out, _t, ud) => call(ud, (t) => t.writeReplyString(out >>> 0, 1), undefined));
    reg(O.SIZE, has('size'), 'size', { params: v(3), result: 'i32' }, (_t, ud, out) =>
      call(
        ud,
        (t) => {
          const s = t.effects.size?.();
          if (!s) return 0;
          const f = S.GhosttySizeReportSize.f;
          const dv = vt.dv;
          const p = out >>> 0;
          dv.setUint16(p + f.rows, s.rows, true);
          dv.setUint16(p + f.columns, s.cols, true);
          dv.setUint32(p + f.cell_width, Math.round(s.cellWidth), true);
          dv.setUint32(p + f.cell_height, Math.round(s.cellHeight), true);
          return 1;
        },
        0,
      ),
    );
    reg(O.COLOR_SCHEME, has('colorScheme'), 'color_scheme', { params: v(3), result: 'i32' }, (_t, ud, out) =>
      call(
        ud,
        (t) => {
          const s = t.effects.colorScheme?.();
          if (!s) return 0;
          vt.dv.setInt32(out >>> 0, s === 'dark' ? E.GhosttyColorScheme.DARK : E.GhosttyColorScheme.LIGHT, true);
          return 1;
        },
        0,
      ),
    );
    reg(O.DEVICE_ATTRIBUTES, has('deviceAttributes'), 'device_attributes', { params: v(3), result: 'i32' }, (_t, ud, out) =>
      call(
        ud,
        (t) => {
          const da = t.effects.deviceAttributes?.();
          if (!da) return 0;
          const dv = vt.dv;
          const p = out >>> 0;
          const pri = S.GhosttyDeviceAttributes.f.primary;
          const pf = S.GhosttyDeviceAttributesPrimary.f;
          dv.setUint16(p + pri + pf.conformance_level, da.conformance, true);
          const feats = da.features.slice(0, 64);
          feats.forEach((n, i) => dv.setUint16(p + pri + pf.features + i * 2, n, true));
          dv.setUint32(p + pri + pf.num_features, feats.length, true);
          const sec = p + S.GhosttyDeviceAttributes.f.secondary;
          const sf = S.GhosttyDeviceAttributesSecondary.f;
          dv.setUint16(sec + sf.device_type, da.deviceType, true);
          dv.setUint16(sec + sf.firmware_version, da.firmwareVersion, true);
          dv.setUint16(sec + sf.rom_cartridge, da.romCartridge, true);
          dv.setUint32(p + S.GhosttyDeviceAttributes.f.tertiary + S.GhosttyDeviceAttributesTertiary.f.unit_id, da.unitId >>> 0, true);
          return 1;
        },
        0,
      ),
    );
    reg(O.CLIPBOARD_WRITE, has('clipboardWrite'), 'clipboard_write', { params: v(3) }, (_t, ud, req) =>
      call(ud, (t) => t.onClipboardWrite(req >>> 0), undefined),
    );
    reg(O.CLIPBOARD_READ, has('clipboardRead'), 'clipboard_read', { params: v(3) }, (_t, ud, req) =>
      call(ud, (t) => t.onClipboardRead(req >>> 0), undefined),
    );
    reg(O.DESKTOP_NOTIFICATION, has('desktopNotification'), 'notification', { params: v(3) }, (_t, ud, p) =>
      call(
        ud,
        (t) => {
          const f = S.GhosttyTerminalDesktopNotification.f;
          t.effects.desktopNotification?.(vt.gstr((p >>> 0) + f.title), vt.gstr((p >>> 0) + f.body));
        },
        undefined,
      ),
    );
    reg(O.PROGRESS_REPORT, has('progressReport'), 'progress', { params: v(3) }, (_t, ud, p) =>
      call(
        ud,
        (t) => {
          const f = S.GhosttyTerminalProgressReport.f;
          const dv = vt.dv;
          t.effects.progressReport?.(PROGRESS_STATE[dv.getInt32((p >>> 0) + f.state, true)] ?? 'remove', dv.getInt8((p >>> 0) + f.progress));
        },
        undefined,
      ),
    );
    reg(O.PROGRAM_STATUS, has('programStatus'), 'program_status', { params: v(3) }, (_t, ud, p) =>
      call(
        ud,
        (t) => {
          const f = S.GhosttyTerminalProgramStatus.f;
          const dv = vt.dv;
          const b = p >>> 0;
          t.effects.programStatus?.({
            state: STATUS_STATE[dv.getInt32(b + f.state, true)] ?? 'idle',
            kind: STATUS_KIND[dv.getInt32(b + f.kind, true)] ?? 'none',
            progress: dv.getInt8(b + f.progress),
            id: vt.gstr(b + f.id),
            app: vt.gstr(b + f.app),
            title: vt.gstr(b + f.title),
            message: vt.gstr(b + f.message),
          });
        },
        undefined,
      ),
    );
    reg(O.UNKNOWN_SEQUENCE, has('unknownSequence'), 'unknown', { params: v(3) }, (_t, ud, p) =>
      call(
        ud,
        (t) => {
          const b = p >>> 0;
          const dv = vt.dv;
          const tag = dv.getInt32(b + S.GhosttyTerminalUnknownSequence.f.tag, true);
          const val = b + S.GhosttyTerminalUnknownSequence.f.value;
          if (tag === E.GhosttyTerminalUnknownSequenceTag.OSC) {
            const f = S.GhosttyTerminalUnknownOscSequence.f;
            t.effects.unknownSequence?.({
              kind: 'osc',
              truncated: vt.u8[val + f.truncated] !== 0,
              content: vt.gbytes(val + f.content),
              terminator: dv.getInt32(val + f.terminator, true) === E.GhosttyOscTerminator.BEL ? 'bel' : 'st',
            });
          } else if (tag === E.GhosttyTerminalUnknownSequenceTag.APC) {
            const f = S.GhosttyTerminalUnknownStringSequence.f;
            t.effects.unknownSequence?.({ kind: 'apc', truncated: vt.u8[val + f.truncated] !== 0, content: vt.gbytes(val + f.content) });
          }
        },
        undefined,
      ),
    );
    reg(O.RENDER_HOLD, has('renderHold'), 'render_hold', { params: v(3) }, (_t, ud, held) =>
      call(ud, (t) => t.effects.renderHold?.(held !== 0), undefined),
    );
    reg(O.SEMANTIC_PROMPT, has('semanticPrompt'), 'semantic_prompt', { params: v(3) }, (_t, ud, p) =>
      call(
        ud,
        (t) => {
          const f = S.GhosttyTerminalSemanticPrompt.f;
          const b = p >>> 0;
          const dv = vt.dv;
          const kind = dv.getInt32(b + f.kind, true);
          if (kind < 1 || kind > 4) return;
          t.effects.semanticPrompt?.({
            kind: SEMANTIC_KIND[kind],
            promptKind: PROMPT_KIND[dv.getInt32(b + f.prompt_kind, true)] ?? 'primary',
            exitCode: vt.u8[b + f.has_exit_code] ? dv.getInt32(b + f.exit_code, true) : undefined,
            command: vt.gstr(b + f.command),
            error: vt.gstr(b + f.error),
          });
        },
        undefined,
      ),
    );
    reg(O.RESET, has('reset'), 'reset', { params: v(2) }, (_t, ud) => call(ud, (t) => t.effects.reset?.(), undefined));
    reg(O.RESIZE_WINDOW, has('resizeWindow'), 'resize_window', { params: v(3) }, (_t, ud, p) =>
      call(
        ud,
        (t) => {
          const b = p >>> 0;
          if (vt.dv.getInt32(b + S.GhosttyTerminalResizeWindow.f.tag, true) !== E.GhosttyTerminalResizeWindowTag.GRID) return;
          const g = b + S.GhosttyTerminalResizeWindow.f.value;
          const gf = S.GhosttyTerminalResizeWindowGrid.f;
          t.effects.resizeWindow?.(vt.dv.getUint16(g + gf.rows, true), vt.dv.getUint16(g + gf.columns, true));
        },
        undefined,
      ),
    );
  }

  private writeReplyString(out: number, which: 0 | 1): void {
    const s = this.replyStrings[which];
    const dv = this.vt.dv;
    dv.setUint32(out, s?.len ? s.ptr : 0, true);
    dv.setUint32(out + 4, s?.len ?? 0, true);
  }

  private onClipboardWrite(req: number): void {
    const vt = this.vt;
    const f = S.GhosttyClipboardWrite.f;
    const dv = vt.dv;
    const contentsPtr = dv.getUint32(req + f.contents, true);
    const n = dv.getUint32(req + f.contents_len, true);
    const contents: ClipboardContent[] = [];
    for (let i = 0; i < n; i++) {
      const c = contentsPtr + i * S.GhosttyClipboardContent.size;
      contents.push({ mime: vt.gstr(c + S.GhosttyClipboardContent.f.mime), data: vt.gbytes(c + S.GhosttyClipboardContent.f.data) });
    }
    const answer = this.effects.clipboardWrite!({
      location: LOCATIONS[dv.getInt32(req + f.location, true)] ?? 'standard',
      contents,
      name: vt.gstr(req + f.name),
      granted: vt.u8[req + f.granted] !== 0,
      canRemember: vt.u8[req + f.can_remember] !== 0,
    });
    const replyFn = vt.dv.getUint32(req + f.reply, true);
    vt.withScratch((take) => {
      const rf = S.GhosttyClipboardWriteReply;
      const r = vt.sized(take(rf.size), rf.size);
      vt.dv.setInt32(r + rf.f.result, E.GhosttyClipboardWriteResult[answer.result], true);
      vt.u8[r + rf.f.remember] = answer.remember ? 1 : 0;
      vt.callPtr(replyFn, req, r);
    });
  }

  private onClipboardRead(req: number): void {
    const vt = this.vt;
    const f = S.GhosttyClipboardRead.f;
    const dv = vt.dv;
    const mimesPtr = dv.getUint32(req + f.mimes, true);
    const nm = dv.getUint32(req + f.mimes_len, true);
    const mimes: string[] = [];
    for (let i = 0; i < nm; i++) mimes.push(vt.gstr(mimesPtr + i * 8));
    const answer = this.effects.clipboardRead!({
      location: LOCATIONS[dv.getInt32(req + f.location, true)] ?? 'standard',
      mimes,
      list: vt.u8[req + f.list] !== 0,
      name: vt.gstr(req + f.name),
      granted: vt.u8[req + f.granted] !== 0,
      canRemember: vt.u8[req + f.can_remember] !== 0,
    });
    const replyFn = vt.dv.getUint32(req + f.reply, true);
    // Contents can be large, so they go in their own allocations.
    const allocs: [number, number][] = [];
    const put = (bytes: Uint8Array): number => {
      const p = vt.alloc(Math.max(1, bytes.length));
      allocs.push([p, Math.max(1, bytes.length)]);
      vt.u8.set(bytes, p);
      return p;
    };
    try {
      const contents = answer.contents ?? [];
      const available = answer.available ?? [];
      const cArr = put(new Uint8Array(Math.max(1, contents.length) * S.GhosttyClipboardContent.size));
      contents.forEach((c, i) => {
        const mime = utf8Encoder.encode(c.mime);
        const mp = put(mime);
        const dp = put(c.data);
        const base = cArr + i * S.GhosttyClipboardContent.size;
        const d = vt.dv;
        d.setUint32(base + S.GhosttyClipboardContent.f.mime, mp, true);
        d.setUint32(base + S.GhosttyClipboardContent.f.mime + 4, mime.length, true);
        d.setUint32(base + S.GhosttyClipboardContent.f.data, dp, true);
        d.setUint32(base + S.GhosttyClipboardContent.f.data + 4, c.data.length, true);
      });
      const aArr = put(new Uint8Array(Math.max(1, available.length) * 8));
      available.forEach((m, i) => {
        const b = utf8Encoder.encode(m);
        const mp = put(b);
        vt.dv.setUint32(aArr + i * 8, mp, true);
        vt.dv.setUint32(aArr + i * 8 + 4, b.length, true);
      });
      vt.withScratch((take) => {
        const rf = S.GhosttyClipboardReadReply;
        const r = vt.sized(take(rf.size), rf.size);
        const d = vt.dv;
        d.setInt32(r + rf.f.result, E.GhosttyClipboardReadResult[answer.result], true);
        d.setUint32(r + rf.f.contents, contents.length ? cArr : 0, true);
        d.setUint32(r + rf.f.contents_len, contents.length, true);
        d.setUint32(r + rf.f.available, available.length ? aArr : 0, true);
        d.setUint32(r + rf.f.available_len, available.length, true);
        vt.u8[r + rf.f.remember] = answer.remember ? 1 : 0;
        vt.callPtr(replyFn, req, r);
      });
    } finally {
      for (const [p, n] of allocs) vt.free(p, n);
    }
  }

  // ---- writing -----------------------------------------------------------

  private input(data: Uint8Array): number {
    if (data.length > this.inCap) {
      this.vt.free(this.inPtr, this.inCap);
      this.inCap = Math.max(data.length, 64 * 1024);
      this.inPtr = this.vt.alloc(this.inCap);
    }
    this.vt.u8.set(data, this.inPtr);
    return this.inPtr;
  }

  /** Feeds output from the program. Effects run during this call. */
  write(data: Uint8Array | string): void {
    const bytes = typeof data === 'string' ? utf8Encoder.encode(data) : data;
    if (!bytes.length) return;
    const p = this.input(bytes);
    this.vt.ex.ghostty_terminal_vt_write(this.handle, p, bytes.length);
  }

  /**
   * Feeds `data`, stopping right after the first byte that reaches one of
   * `boundaries` (GhosttyTerminalBoundary flags). Returns where it stopped,
   * or undefined if everything was consumed without reaching one.
   */
  writeUntil(data: Uint8Array, boundaries: number): WriteStop | undefined {
    if (!data.length) return undefined;
    const vt = this.vt;
    const p = this.input(data);
    const st = S.GhosttyTerminalWriteStop;
    if (!this.stopPtr) this.stopPtr = vt.alloc(st.size);
    vt.u8.fill(0, this.stopPtr, this.stopPtr + st.size);
    vt.sized(this.stopPtr, st.size);
    const r = vt.ex.ghostty_terminal_vt_write_until(this.handle, p, data.length, boundaries, this.stopPtr);
    if (r === NO_VALUE) return undefined;
    vt.check(r, 'vt_write_until');
    const dv = vt.dv;
    return {
      consumed: dv.getUint32(this.stopPtr + st.f.consumed, true),
      reached: dv.getUint32(this.stopPtr + st.f.reached, true),
      kind: STRING_KIND[dv.getInt32(this.stopPtr + st.f.kind, true)] ?? 'osc',
      byte: vt.u8[this.stopPtr + st.f.byte],
    };
  }

  resize(cols: number, rows: number, cellWidth: number, cellHeight: number): void {
    this.vt.check(this.vt.ex.ghostty_terminal_resize(this.handle, cols, rows, Math.max(1, Math.round(cellWidth)), Math.max(1, Math.round(cellHeight))), 'resize');
  }

  reset(): void {
    this.vt.ex.ghostty_terminal_reset(this.handle);
  }

  scrollViewport(to: ScrollTo): void {
    const vt = this.vt;
    const T = E.GhosttyTerminalScrollViewportTag;
    vt.withScratch((take) => {
      const s = S.GhosttyTerminalScrollViewport;
      const p = take(s.size);
      const dv = vt.dv;
      const val = p + s.f.value;
      if ('top' in to) dv.setInt32(p, T.TOP, true);
      else if ('bottom' in to) dv.setInt32(p, T.BOTTOM, true);
      else if ('delta' in to) {
        dv.setInt32(p, T.DELTA, true);
        dv.setInt32(val, Math.trunc(to.delta), true);
      } else if ('row' in to) {
        dv.setInt32(p, T.ROW, true);
        dv.setUint32(val, Math.max(0, Math.trunc(to.row)), true);
      } else {
        dv.setInt32(p, T.DELTA_PROMPT, true);
        dv.setInt32(val, Math.trunc(to.prompts), true);
      }
      vt.check(vt.ex.ghostty_terminal_scroll_viewport(this.handle, p), 'scroll_viewport');
    });
  }

  // ---- reading -----------------------------------------------------------

  private get(data: number, size: number, read: (p: number) => unknown): unknown {
    return this.vt.withScratch((take) => {
      const p = take(Math.max(size, 8));
      const r = this.vt.ex.ghostty_terminal_get(this.handle, data, p);
      if (r === NO_VALUE) return undefined;
      this.vt.check(r, `terminal_get ${data}`);
      return read(p);
    });
  }
  private u16(data: number): number {
    return this.get(data, 2, (p) => this.vt.dv.getUint16(p, true)) as number;
  }
  private u32(data: number): number {
    return this.get(data, 4, (p) => this.vt.dv.getUint32(p, true)) as number;
  }
  private bool(data: number): boolean {
    return this.get(data, 1, (p) => this.vt.u8[p] !== 0) as boolean;
  }
  private str(data: number): string {
    return (this.get(data, 8, (p) => this.vt.gstr(p)) as string | undefined) ?? '';
  }
  private color(data: number): Rgb | undefined {
    return this.get(data, 3, (p) => this.vt.rgb(p)) as Rgb | undefined;
  }

  get cols(): number {
    return this.u16(D.COLS);
  }
  get rows(): number {
    return this.u16(D.ROWS);
  }
  get cursorX(): number {
    return this.u16(D.CURSOR_X);
  }
  get cursorY(): number {
    return this.u16(D.CURSOR_Y);
  }
  get cursorVisible(): boolean {
    return this.bool(D.CURSOR_VISIBLE);
  }
  get title(): string {
    return this.str(D.TITLE);
  }
  get pwd(): string {
    return this.str(D.PWD);
  }
  get altScreen(): boolean {
    return (this.get(D.ACTIVE_SCREEN, 4, (p) => this.vt.dv.getInt32(p, true)) as number) === E.GhosttyTerminalScreen.ALTERNATE;
  }
  get mouseTracking(): boolean {
    return this.bool(D.MOUSE_TRACKING);
  }
  get kittyKeyboardFlags(): number {
    return this.get(D.KITTY_KEYBOARD_FLAGS, 1, (p) => this.vt.u8[p]) as number;
  }
  get totalRows(): number {
    return this.u32(D.TOTAL_ROWS);
  }
  get scrollbackRows(): number {
    return this.u32(D.SCROLLBACK_ROWS);
  }
  get viewportAtBottom(): boolean {
    return this.bool(D.VIEWPORT_ACTIVE);
  }
  get atGround(): boolean {
    return this.bool(D.VT_GROUND);
  }
  get cursorAtPrompt(): boolean {
    return this.bool(D.CURSOR_AT_PROMPT);
  }
  get mouseShape(): number {
    return this.get(D.MOUSE_SHAPE, 4, (p) => this.vt.dv.getInt32(p, true)) as number;
  }
  get foreground(): Rgb | undefined {
    return this.color(D.COLOR_FOREGROUND);
  }
  get background(): Rgb | undefined {
    return this.color(D.COLOR_BACKGROUND);
  }
  get cursorColor(): Rgb | undefined {
    return this.color(D.COLOR_CURSOR);
  }
  get scrollbar(): Scrollbar {
    return this.get(D.SCROLLBAR, S.GhosttyTerminalScrollbar.size, (p) => {
      const dv = this.vt.dv;
      const f = S.GhosttyTerminalScrollbar.f;
      return { total: Number(dv.getBigUint64(p + f.total, true)), offset: Number(dv.getBigUint64(p + f.offset, true)), len: Number(dv.getBigUint64(p + f.len, true)) };
    }) as Scrollbar;
  }

  palette(defaults = false): Rgb[] {
    return this.get(defaults ? D.COLOR_PALETTE_DEFAULT : D.COLOR_PALETTE, 768, (p) => {
      const out: Rgb[] = [];
      for (let i = 0; i < 256; i++) out.push(this.vt.rgb(p + i * 3));
      return out;
    }) as Rgb[];
  }

  getMode(m: number): boolean {
    return this.vt.withScratch((take) => {
      const s = S.GhosttyTerminalModeConfig;
      const p = take(s.size);
      this.vt.dv.setUint16(p + s.f.mode, m, true);
      const r = this.vt.ex.ghostty_terminal_get(this.handle, D.MODE, p);
      if (r !== OK) return false;
      return this.vt.u8[p + s.f.value] !== 0;
    });
  }

  /** Sets a mode's default (what RIS restores) and, for a new terminal, its value. */
  setModeDefault(m: number, value: boolean, applyNow = true): void {
    this.vt.withScratch((take) => {
      const s = S.GhosttyTerminalModeConfig;
      const p = take(s.size);
      this.vt.dv.setUint16(p + s.f.mode, m, true);
      this.vt.u8[p + s.f.value] = value ? 1 : 0;
      this.set(O.MODE_DEFAULT, p, 'set mode default');
    });
    if (applyNow) this.setMode(m, value);
  }

  setMode(m: number, value: boolean): void {
    this.vt.withScratch((take) => {
      const s = S.GhosttyTerminalModeConfig;
      const p = take(s.size);
      this.vt.dv.setUint16(p + s.f.mode, m, true);
      this.vt.u8[p + s.f.value] = value ? 1 : 0;
      this.set(O.MODE, p, 'set mode');
    });
  }

  memoryUsage(): { residentBytes: number; compressionSupported: boolean } {
    return this.vt.withScratch((take) => {
      const s = S.GhosttyTerminalMemoryUsage;
      const p = this.vt.sized(take(s.size), s.size);
      this.vt.check(this.vt.ex.ghostty_terminal_get(this.handle, D.MEMORY_USAGE, p), 'memory usage');
      const dv = this.vt.dv;
      const n = (k: keyof typeof s.f) => Number(dv.getBigUint64(p + s.f[k], true));
      return { residentBytes: n('primary_resident_bytes') + n('alternate_resident_bytes'), compressionSupported: this.vt.u8[p + s.f.compression_supported] !== 0 };
    });
  }

  /** Opaque token; compression is worth trying again only after it changes. */
  compressionActivity(): bigint {
    return this.vt.withScratch((take) => {
      const p = take(8);
      this.vt.check(this.vt.ex.ghostty_terminal_compression_activity(this.handle, p), 'compression_activity');
      return this.vt.dv.getBigUint64(p, true);
    });
  }

  /** One incremental compression step. Returns 'pending' while more work remains. */
  compress(full = false): 'unsupported' | 'pending' | 'complete' {
    return this.vt.withScratch((take) => {
      const p = take(4);
      const M = E.GhosttyTerminalCompressionMode;
      this.vt.check(this.vt.ex.ghostty_terminal_compress(this.handle, full ? M.FULL : M.INCREMENTAL, p), 'compress');
      const r = this.vt.dv.getInt32(p, true);
      return r === E.GhosttyTerminalCompressionResult.PENDING ? 'pending' : r === E.GhosttyTerminalCompressionResult.COMPLETE ? 'complete' : 'unsupported';
    });
  }

  // ---- paste -------------------------------------------------------------

  /**
   * Pastes text the way the program asked for: bracketed (2004), as a Kitty
   * paste event (5522), or with newlines as CR. Returns 'rejected' when the
   * text could inject commands and `allowUnsafe` is false; nothing is written
   * then. Output goes through the writePty effect.
   */
  paste(text: string, opts: { allowUnsafe?: boolean; source?: 'clipboard' | 'text' } = {}): 'pasted' | 'empty' | 'rejected' {
    const vt = this.vt;
    const reader = vt.callback('paste_reader', { params: ['i32', 'i32', 'i32'], result: 'i32' }, (ud, mimePtr, writerPtr) => {
      const t = lookup(vt, ud);
      const data = t?.pasteData;
      if (!t || !data) return 0;
      const mime = vt.gstr(mimePtr >>> 0);
      if (mime !== 'text/plain' && mime !== 'text/plain;charset=utf-8') return 0;
      const writeFn = vt.dv.getUint32((writerPtr >>> 0) + S.GhosttyWriter.f.write, true);
      const writerUd = vt.dv.getUint32((writerPtr >>> 0) + S.GhosttyWriter.f.userdata, true);
      const CHUNK = 64 * 1024;
      for (let off = 0; off < data.length; off += CHUNK) {
        const piece = data.subarray(off, off + CHUNK);
        const p = vt.alloc(piece.length);
        try {
          vt.u8.set(piece, p);
          if (!vt.callPtr(writeFn, writerUd, p, piece.length)) return 0;
        } finally {
          vt.free(p, piece.length);
        }
      }
      return 1;
    });
    this.pasteData = utf8Encoder.encode(text);
    try {
      return vt.withScratch((take) => {
        const s = S.GhosttyPaste;
        const p = vt.sized(take(s.size), s.size);
        const mime = vt.scratchString(take, 'text/plain');
        const dv = vt.dv;
        dv.setInt32(p + s.f.location, E.GhosttyClipboardLocation.STANDARD, true);
        dv.setInt32(p + s.f.source, opts.source === 'text' ? E.GhosttyPasteSource.TEXT : E.GhosttyPasteSource.CLIPBOARD, true);
        dv.setUint32(p + s.f.mimes, mime, true);
        dv.setUint32(p + s.f.mimes_len, 1, true);
        dv.setUint32(p + s.f.reader + S.GhosttyMimeReader.f.read, reader, true);
        dv.setUint32(p + s.f.reader + S.GhosttyMimeReader.f.userdata, this.id, true);
        vt.u8[p + s.f.allow_unsafe] = opts.allowUnsafe ? 1 : 0;
        const out = take(1);
        const r = vt.ex.ghostty_terminal_paste(this.handle, p, out);
        if (r === E.GhosttyResult.REJECTED) return 'rejected';
        vt.check(r, 'terminal_paste');
        return vt.u8[out] ? 'pasted' : 'empty';
      });
    } finally {
      this.pasteData = undefined;
    }
  }

  // ---- snapshots and continuation -----------------------------------------

  /** Complete state as bytes, for a mirror engine from the same build. */
  snapshot(): Uint8Array {
    const vt = this.vt;
    return vt.withScratch((take) => {
      const outPtr = take(4);
      const outLen = take(4);
      vt.check(vt.ex.ghostty_snapshot_encode_alloc(this.handle, 0, outPtr, outLen), 'snapshot_encode');
      const p = vt.dv.getUint32(outPtr, true);
      const n = vt.dv.getUint32(outLen, true);
      const bytes = vt.copyOut(p, n);
      vt.freeLib(p, n);
      return bytes;
    });
  }

  // ---- lifecycle ---------------------------------------------------------

  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.vt.leaks?.unregister(this);
    registry.get(this.vt)?.delete(this.id);
    this.vt.ex.ghostty_terminal_free(this.handle);
    this.vt.free(this.inPtr, this.inCap);
    this.vt.free(this.stopPtr, S.GhosttyTerminalWriteStop.size);
    for (const s of this.replyStrings) this.vt.free(s.ptr, s.len + 1);
    this.replyStrings = [];
  }
}

export function assertOk(r: number, op: string): void {
  if (r !== OK) throw new VtError(r, op);
}
