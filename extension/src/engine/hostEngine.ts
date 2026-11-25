// The authoritative engine of one session (extension host side).
//
// Every byte from the sidecar goes through this terminal before it is
// forwarded to the webview, in order. It owns all effects: query replies go
// straight back to the PTY, and titles, cwd, clipboard, notifications,
// progress and prompt marks are reported to the session. It also answers what
// other extensions ask about the screen, and encodes snapshots for webviews
// that attach.
//
// libghostty-vt callbacks are synchronous, but reading VS Code's clipboard is
// not. So output is fed with write_until, stopping at every OSC start; if the
// OSC is a clipboard read, the clipboard is fetched first and processing
// continues once it is there. The webview never sees the delay, because it
// only receives bytes after this engine has processed them. Free of `vscode`
// imports so it runs under the unit tests.

import { Vt } from '../../vt/core';
import { format, selectOutput } from '../../vt/selection';
import {
  ClipboardReadReply,
  ClipboardReadRequest,
  DeviceAttributes,
  ProgramStatusReport,
  ProgressState,
  SemanticPromptEvent,
  Terminal,
  TerminalColors,
  UnknownSequence,
} from '../../vt/terminal';

const OSC_START = 1 << 5;
const ESC = 0x1b;
const BEL = 0x07;
const BACKSLASH = 0x5c;

/** Longest OSC we hold back while waiting for its terminator. */
const MAX_HELD_OSC = 1024 * 1024;

export interface CellMetrics {
  cellWidth: number;
  cellHeight: number;
}

/** What the engine reports to its session. */
export interface EngineHost {
  /** Replies and paste data for the program, in order. */
  writePty(data: Uint8Array): void;
  /**
   * Bytes the engine has processed, to forward to the webview, in order.
   * `fromPty` is false for bytes the host injected (they carry no flow-control credit).
   */
  forward(data: Uint8Array, fromPty: boolean): void;
  title?(title: string): void;
  pwd?(pwd: string): void;
  bell?(): void;
  clipboardWrite?(text: string): void;
  /** Fetches the clipboard for a read request; undefined denies it. */
  clipboardRead?(): Promise<string | undefined>;
  notification?(title: string, body: string): void;
  progress?(state: ProgressState, percent: number): void;
  programStatus?(report: ProgramStatusReport): void;
  semanticPrompt?(ev: SemanticPromptEvent): void;
  reset?(): void;
  unknownSequence?(seq: UnknownSequence): void;
  colorScheme?(): 'light' | 'dark';
  error?(e: unknown): void;
}

export interface EngineOptions {
  cols: number;
  rows: number;
  scrollbackLines: number;
  colors: TerminalColors;
  cursorStyle: 'bar' | 'block' | 'underline';
  cursorBlink: boolean;
  xtversion: string;
  answerback: string;
  /** OSC 52 policy: whether programs may write and read the clipboard. */
  clipboard: 'off' | 'write' | 'readWrite';
  /** Kitty graphics (default on). */
  images?: boolean;
}

/** Image storage per screen, the same in both engines. */
export const IMAGE_STORAGE_BYTES = 320 * 1024 * 1024;

/** Bytes of scrollback per line we budget for, to turn lines into a byte cap. */
const BYTES_PER_LINE = 512;

export class HostEngine {
  readonly term: Terminal;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private state: 'idle' | 'processing' | 'awaitingClipboard' = 'idle';
  /** The next pending bytes are an OSC body that has not been classified yet. */
  private atOsc = false;
  private prefetched: string | undefined | null = null;
  private metrics: CellMetrics = { cellWidth: 9, cellHeight: 18 };
  private clipboardPolicy: EngineOptions['clipboard'];
  private disposed = false;
  private compressTimer: ReturnType<typeof setTimeout> | undefined;
  private lastActivity: bigint | undefined;

  constructor(
    readonly vt: Vt,
    opts: EngineOptions,
    private readonly host: EngineHost,
  ) {
    this.clipboardPolicy = opts.clipboard;
    this.term = Terminal.create(vt, {
      cols: opts.cols,
      rows: opts.rows,
      scrollbackLines: opts.scrollbackLines,
      scrollbackBytes: Math.max(1, opts.scrollbackLines) * BYTES_PER_LINE,
      continuationMaxBytes: 64 * 1024,
      unknownMaxBytes: 64 * 1024,
      clipboardWriteMaxBytes: 8 * 1024 * 1024,
      kittyImageStorageLimit: opts.images === false ? 0 : IMAGE_STORAGE_BYTES,
      colors: opts.colors,
      cursorStyle: opts.cursorStyle,
      cursorBlink: opts.cursorBlink,
      xtversion: opts.xtversion,
      answerback: opts.answerback,
      effects: this.effects(),
    });
  }

  private effects(): Parameters<Terminal['setEffects']>[0] {
    const h = this.host;
    return {
      writePty: (d) => h.writePty(d),
      bell: () => h.bell?.(),
      titleChanged: (t) => h.title?.(t),
      pwdChanged: (p) => h.pwd?.(p),
      size: () => ({ rows: this.term.rows, cols: this.term.cols, cellWidth: this.metrics.cellWidth, cellHeight: this.metrics.cellHeight }),
      colorScheme: () => h.colorScheme?.() ?? 'dark',
      deviceAttributes: () => this.deviceAttributes(),
      clipboardWrite: (req) => {
        if (this.clipboardPolicy === 'off' || req.location !== 'standard') return { result: 'DENIED' };
        if (!req.contents.length) return { result: 'SUCCESS' };
        const text = req.contents.find((c) => c.mime.startsWith('text/plain')) ?? req.contents[0];
        h.clipboardWrite?.(new TextDecoder().decode(text.data));
        return { result: 'SUCCESS' };
      },
      clipboardRead: (req) => this.answerClipboardRead(req),
      desktopNotification: (title, body) => h.notification?.(title, body),
      progressReport: (state, pct) => h.progress?.(state, pct),
      programStatus: (r) => h.programStatus?.(r),
      semanticPrompt: (ev) => h.semanticPrompt?.(ev),
      reset: () => h.reset?.(),
      unknownSequence: (s) => h.unknownSequence?.(s),
      // CSI 8 t: an editor tab cannot be sized by a program. Registered so
      // the request is consumed rather than reported as unknown.
      resizeWindow: () => undefined,
      onError: (e) => h.error?.(e),
    };
  }

  private deviceAttributes(): DeviceAttributes {
    // The library default (VT220 with ANSI colour), plus clipboard (52) when
    // programs may use OSC 52.
    const features = [22];
    if (this.clipboardPolicy !== 'off') features.push(52);
    return { conformance: 62, features, deviceType: 1, firmwareVersion: 10, romCartridge: 0, unitId: 0 };
  }

  private answerClipboardRead(req: ClipboardReadRequest): ClipboardReadReply {
    if (req.location !== 'standard') return { result: 'UNSUPPORTED' };
    // Only listing the types needs no clipboard contents.
    if (!req.mimes.length) return { result: 'SUCCESS', available: ['text/plain'] };
    const text = this.prefetched;
    this.prefetched = null;
    if (this.clipboardPolicy !== 'readWrite' && !req.granted) return { result: 'DENIED' };
    if (text === null || text === undefined) return { result: text === null ? 'BUSY' : 'DENIED' };
    if (!req.mimes.some((m) => m.startsWith('text/plain'))) return { result: 'SUCCESS', contents: [], available: ['text/plain'] };
    return { result: 'SUCCESS', contents: [{ mime: 'text/plain', data: new TextEncoder().encode(text) }], available: req.list ? ['text/plain'] : undefined };
  }

  // ---- output ------------------------------------------------------------

  /** Output from the PTY. Processed now, or queued behind a clipboard fetch. */
  push(data: Uint8Array): void {
    if (this.disposed || !data.length) return;
    this.pending.push(data);
    this.pendingBytes += data.length;
    this.process();
  }

  /** Bytes received but not yet processed (held for a clipboard fetch). */
  get heldBytes(): number {
    return this.pendingBytes;
  }

  private take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const head = this.pending[0];
      const k = Math.min(head.length, n - off);
      out.set(head.subarray(0, k), off);
      off += k;
      if (k === head.length) this.pending.shift();
      else this.pending[0] = head.subarray(k);
    }
    this.pendingBytes -= n;
    return out;
  }

  private joined(): Uint8Array {
    if (this.pending.length === 1) return this.pending[0];
    const all = this.take(this.pendingBytes);
    this.pending = [all];
    this.pendingBytes = all.length;
    return all;
  }

  private process(): void {
    if (this.state !== 'idle') return;
    this.state = 'processing';
    try {
      while (this.pendingBytes && !this.disposed) {
        if (this.atOsc) {
          // The next bytes are the body of an OSC whose introducer was just
          // processed. A clipboard read needs the clipboard before the
          // terminal sees the rest of it.
          const decision = classifyOsc(this.joined());
          if (decision === 'incomplete' && this.pendingBytes < MAX_HELD_OSC) return; // wait for more output
          this.atOsc = false;
          if (decision === 'clipboardRead' && this.host.clipboardRead && this.clipboardPolicy === 'readWrite') {
            this.state = 'awaitingClipboard';
            this.host.clipboardRead().then(
              (text) => this.resume(text),
              () => this.resume(undefined),
            );
            return;
          }
        }
        const data = this.joined();
        const stop = this.term.writeUntil(data, OSC_START);
        this.host.forward(this.take(stop ? stop.consumed : data.length), true);
        if (stop) this.atOsc = true;
      }
    } catch (e) {
      this.host.error?.(e);
    } finally {
      if (this.state === 'processing') this.state = 'idle';
      this.scheduleCompression();
    }
    this.flushInjected();
  }

  private injected: Uint8Array[] = [];

  /**
   * Writes bytes of our own into the stream (notices, clear), so both engines
   * see them at the same point. They go in only between sequences: at ground,
   * with no output held back.
   */
  inject(data: Uint8Array | string): void {
    if (this.disposed) return;
    this.injected.push(typeof data === 'string' ? new TextEncoder().encode(data) : data);
    this.flushInjected();
  }

  private flushInjected(): void {
    if (this.state !== 'idle' || this.atOsc || this.pendingBytes || !this.injected.length) return;
    if (!this.term.atGround) return;
    for (const d of this.injected.splice(0)) {
      this.term.write(d);
      this.host.forward(d, false);
    }
  }

  /**
   * Clears the screen and scrollback but keeps the line the cursor is on, at
   * the top, like VS Code's "Clear". On the alternate screen it does nothing.
   */
  clear(): void {
    const t = this.term;
    if (t.altScreen) return;
    const y = t.cursorY;
    const x = t.cursorX;
    this.inject(`${y > 0 ? `\x1b[${y}S` : ''}\x1b[3J\x1b[1;${x + 1}H`);
  }

  private resume(text: string | undefined): void {
    if (this.disposed) return;
    this.state = 'idle';
    // Feed the clipboard OSC itself; its callback answers with `text`.
    const end = oscEnd(this.joined());
    if (end > 0) {
      this.prefetched = text;
      try {
        this.term.write(this.joined().subarray(0, end));
      } catch (e) {
        this.host.error?.(e);
      }
      this.prefetched = null;
      this.host.forward(this.take(end), true);
    }
    this.process();
  }

  // ---- state -------------------------------------------------------------

  resize(cols: number, rows: number, metrics?: CellMetrics): void {
    if (metrics) this.metrics = metrics;
    this.term.resize(cols, rows, this.metrics.cellWidth, this.metrics.cellHeight);
  }

  setMetrics(m: CellMetrics): void {
    this.metrics = m;
  }

  setColors(c: TerminalColors): void {
    this.term.setColors(c);
  }

  setClipboardPolicy(p: EngineOptions['clipboard']): void {
    this.clipboardPolicy = p;
  }

  setImages(on: boolean): void {
    this.term.setKittyImageLimit(on ? IMAGE_STORAGE_BYTES : 0);
  }

  setScrollback(lines: number): void {
    this.term.setScrollback(Math.max(1, lines) * BYTES_PER_LINE, lines);
  }

  setReplyStrings(xtversion: string, answerback: string): void {
    this.term.setReplyStrings(xtversion, answerback);
  }

  /** A snapshot of everything processed so far, for a webview that attaches. */
  snapshot(): Uint8Array {
    return this.term.snapshot();
  }

  paste(text: string, allowUnsafe: boolean): 'pasted' | 'empty' | 'rejected' {
    return this.term.paste(text, { allowUnsafe });
  }

  get title(): string {
    return this.term.title;
  }

  get cursorAtPrompt(): boolean {
    return this.term.cursorAtPrompt;
  }

  /** The screen and scrollback as plain text. */
  text(maxLines?: number): string {
    const all = format(this.term, { unwrap: true });
    if (maxLines === undefined) return all;
    const lines = all.split('\n');
    return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
  }

  /** The visible screen as plain text. */
  screenText(): string {
    const rows = this.term.rows;
    const lines = format(this.term, { unwrap: false }).split('\n');
    return lines.slice(Math.max(0, lines.length - rows)).join('\n');
  }

  /** Output of the command whose output is at or above the cursor, if known. */
  lastCommandOutput(): string | undefined {
    for (let y = this.term.cursorY; y >= 0; y--) {
      const sel = selectOutput(this.term, 'active', { x: 0, y });
      if (sel) return format(this.term, { selection: sel });
    }
    return undefined;
  }

  // ---- memory --------------------------------------------------------------

  private scheduleCompression(): void {
    clearTimeout(this.compressTimer);
    this.compressTimer = setTimeout(() => this.compressStep(), 5000);
    (this.compressTimer as { unref?: () => void }).unref?.();
  }

  private compressStep(): void {
    if (this.disposed) return;
    const activity = this.term.compressionActivity();
    if (activity === this.lastActivity) return;
    const r = this.term.compress();
    if (r === 'pending') {
      setTimeout(() => this.compressStep(), 0);
      return;
    }
    this.lastActivity = this.term.compressionActivity();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.compressTimer);
    this.term.dispose();
  }
}

/** Index just past the OSC terminator in `data` (which starts after `ESC ]`), or 0. */
export function oscEnd(data: Uint8Array): number {
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (b === BEL) return i + 1;
    if (b === 0x18 || b === 0x1a) return i + 1; // CAN/SUB cancel it
    if (b === ESC) {
      if (i + 1 >= data.length) return 0;
      // ESC \ ends it; ESC anything else aborts it (the ESC starts a new sequence).
      return data[i + 1] === BACKSLASH ? i + 2 : i;
    }
  }
  return 0;
}

/**
 * Classifies the OSC that starts `data` (the bytes right after `ESC ]`):
 * a clipboard read (OSC 52 with `?`, or an OSC 5522 read), anything else, or
 * not decidable until more bytes arrive.
 */
export function classifyOsc(data: Uint8Array): 'clipboardRead' | 'other' | 'incomplete' {
  const end = oscEnd(data);
  const body = end ? data.subarray(0, end) : data;
  let head = '';
  for (let i = 0; i < Math.min(body.length, 512); i++) {
    const b = body[i];
    if (b === BEL || b === ESC || b === 0x18 || b === 0x1a) break;
    head += String.fromCharCode(b);
  }
  const maybe = (prefix: string) => prefix.startsWith(head) || head.startsWith(prefix);
  if (!maybe('52;') && !maybe('5522;')) return 'other';
  if (!end) return 'incomplete';
  if (head.startsWith('52;')) {
    const parts = head.split(';');
    return parts.length >= 3 && parts[2] === '?' ? 'clipboardRead' : 'other';
  }
  if (head.startsWith('5522;')) {
    const meta = head.slice(5).split(';')[0];
    return /(^|:)type=read(:|$)/.test(meta) ? 'clipboardRead' : 'other';
  }
  return 'other';
}
