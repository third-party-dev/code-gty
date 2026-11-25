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
import { mode } from '../../vt/terminal';
import { restoreSnapshot } from '../../vt/snapshot';
import type { DecodedImage, DecodeRequest } from '../sidecar';
import { KittyNotification, KittyNotifications, KittyOutcome } from './kittyNotify';
import { classifyDcs, classifyImageOsc, itermPlacement, kittyCommands, parseItermArgs } from './imageBridge';
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
  GHOSTTY_MODE_DEFAULTS,
} from '../../vt/terminal';

const OSC_START = 1 << 5;
const DCS_START = 1 << 3;
const CAN = 0x18;
const SUB = 0x1a;
/** Largest image sequence we collect (base64 of a 16 MB file is ~22 MB). */
const MAX_IMAGE_SEQUENCE = 24 * 1024 * 1024;
/** DECSDM: sixel display mode (images at the top left, cursor unchanged). */
const SIXEL_DISPLAY_MODE = mode(80);
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
  /** ConEmu OSC 9;3: the tab title, or undefined to go back to the usual one. */
  tabTitle?(title: string | undefined): void;
  /** ConEmu OSC 9;2: a message box. */
  messageBox?(text: string): void;
  /** Kitty OSC 99: shows a notification; resolves with what the user did. Undefined if not shown. */
  showNotification?(n: KittyNotification): Promise<KittyOutcome> | undefined;
  /** Brings the terminal forward (a notification was activated). */
  focusTerminal?(): void;
  progress?(state: ProgressState, percent: number): void;
  programStatus?(report: ProgramStatusReport): void;
  semanticPrompt?(ev: SemanticPromptEvent): void;
  reset?(): void;
  unknownSequence?(seq: UnknownSequence): void;
  colorScheme?(): 'light' | 'dark';
  error?(e: unknown): void;
  /**
   * Decodes an image (sixel, or an iTerm2 inline image file) for Kitty
   * graphics. Without it, those sequences are ignored as before.
   */
  decodeImage?(req: DecodeRequest): Promise<DecodedImage | undefined>;
  /** Bytes from the PTY the engine consumed without forwarding (image data): acknowledge them. */
  dropped?(bytes: number): void;
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
  /** Start from this snapshot (a claimed session) instead of an empty screen. */
  restore?: Uint8Array;
}

/** Image storage per screen, the same in both engines. */
export const IMAGE_STORAGE_BYTES = 320 * 1024 * 1024;

/** Bytes of scrollback per line we budget for, to turn lines into a byte cap. */
const BYTES_PER_LINE = 512;

export class HostEngine {
  readonly term: Terminal;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private state: 'idle' | 'processing' | 'awaitingClipboard' | 'awaitingImage' = 'idle';
  /** The next pending bytes are a DCS body that has not been classified yet. */
  private atDcs = false;
  /** An image sequence being collected (its introducer was cancelled with CAN). */
  private collecting: { kind: 'osc' | 'dcs'; chunks: Uint8Array[]; size: number; tooBig: boolean } | undefined;
  /** iTerm2 MultipartFile: arguments and the base64 parts received so far. */
  private multipart: { args: string; parts: string[]; size: number } | undefined;
  private nextImageId = 0x60000000;
  private imagesOn = true;
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
    this.imagesOn = opts.images !== false;
    const termOpts = {
      scrollbackLines: opts.scrollbackLines,
      scrollbackBytes: Math.max(1, opts.scrollbackLines) * BYTES_PER_LINE,
      continuationMaxBytes: 64 * 1024,
      unknownMaxBytes: 64 * 1024,
      clipboardWriteMaxBytes: 8 * 1024 * 1024,
      kittyImageStorageLimit: opts.images === false ? 0 : IMAGE_STORAGE_BYTES,
      modeDefaults: GHOSTTY_MODE_DEFAULTS,
      colors: opts.colors,
      cursorStyle: opts.cursorStyle,
      cursorBlink: opts.cursorBlink,
      xtversion: opts.xtversion,
      answerback: opts.answerback,
      effects: this.effects(),
    };
    // A session claimed back from the sidecar daemon starts from its snapshot.
    this.term = opts.restore ? restoreSnapshot(vt, opts.restore, termOpts) : Terminal.create(vt, { cols: opts.cols, rows: opts.rows, ...termOpts });
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
    // Sixel (4) when images are on: sixel is translated to Kitty graphics.
    if (this.imageBridgeOn) features.unshift(4);
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

  /**
   * ConEmu OSC 9 commands that libghostty-vt parses but drops. The terminal
   * still consumes the sequence (as a no-op); this acts on it.
   */
  /** Kitty OSC 99 state: chunks being assembled, notifications on screen. */
  private readonly notifications = new KittyNotifications({
    show: (n) => this.host.showNotification?.(n),
    reply: (d) => {
      if (!this.disposed) this.host.writePty(new TextEncoder().encode(d));
    },
    focus: () => this.host.focusTerminal?.(),
  });

  private onConEmu(c: ConEmuCommand): void {
    switch (c.kind) {
      case 'tabTitle':
        this.host.tabTitle?.(c.title);
        break;
      case 'messageBox':
        this.host.messageBox?.(c.text);
        break;
      case 'dropped':
        // Sleep, wait for input, GUI macros, running processes and printing
        // environment variables are ConEmu's own business (and the last two
        // would let any output run commands or leak secrets): only offered
        // to other extensions, like any sequence the terminal does not know.
        this.host.unknownSequence?.({ kind: 'osc', content: c.content, truncated: false, terminator: c.terminator });
        break;
    }
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
        if (this.collecting) {
          if (!this.collect()) return; // wait for the rest of the image
          // A decode in flight holds everything after the image until it is placed.
          if (this.state !== 'processing') return;
          continue;
        }
        if (this.atOsc) {
          // The next bytes are the body of an OSC whose introducer was just
          // processed. A clipboard read needs the clipboard before the
          // terminal sees the rest of it; an iTerm2 image or a Kitty text
          // sizing command (OSC 66) is collected.
          const data = this.joined();
          const image = this.imageBridgeOn ? classifyImageOsc(data) : 'other';
          const sizing = classifyTextSizing(data);
          const decision = image === 'image' || sizing === 'textSizing' ? 'collect' : classifyOsc(data);
          const conEmu = classifyConEmu(data);
          const kitty = classifyKittyNotification(data);
          if ((decision === 'incomplete' || image === 'incomplete' || sizing === 'incomplete' || conEmu === 'incomplete' || kitty === 'incomplete') && this.pendingBytes < MAX_HELD_OSC) return; // wait for more output
          this.atOsc = false;
          if (typeof conEmu === 'object') this.onConEmu(conEmu);
          if (typeof kitty === 'object') this.notifications.handle(kitty.body, kitty.terminator);
          if (decision === 'collect') {
            this.startCollecting('osc');
            continue;
          }
          if (decision === 'clipboardRead' && this.host.clipboardRead && this.clipboardPolicy === 'readWrite') {
            this.state = 'awaitingClipboard';
            this.host.clipboardRead().then(
              (text) => this.resume(text),
              () => this.resume(undefined),
            );
            return;
          }
        }
        if (this.atDcs) {
          const decision = this.imageBridgeOn ? classifyDcs(this.joined()) : 'other';
          if (decision === 'incomplete') return;
          this.atDcs = false;
          if (decision === 'sixel') {
            this.startCollecting('dcs');
            continue;
          }
        }
        const data = this.joined();
        const stop = this.term.writeUntil(data, OSC_START | DCS_START);
        this.host.forward(this.take(stop ? stop.consumed : data.length), true);
        if (stop) {
          if (stop.kind === 'osc') this.atOsc = true;
          else if (stop.kind === 'dcs') this.atDcs = true;
        }
      }
    } catch (e) {
      this.host.error?.(e);
    } finally {
      if (this.state === 'processing') this.state = 'idle';
      this.scheduleCompression();
    }
    this.flushInjected();
  }

  private get imageBridgeOn(): boolean {
    return this.imagesOn && !!this.host.decodeImage && this.vt.features.kittyGraphics;
  }

  // ---- sixel and iTerm2 images -----------------------------------------------------

  /**
   * Both engines have just seen the introducer (ESC ] or ESC P). CAN cancels
   * the string in both, so they are back at ground; the rest of the sequence
   * is collected here instead of being parsed, and acknowledged as it comes
   * so a large image cannot stall flow control.
   */
  private startCollecting(kind: 'osc' | 'dcs'): void {
    const cancel = Uint8Array.of(CAN);
    this.term.write(cancel);
    this.host.forward(cancel, false);
    this.collecting = { kind, chunks: [], size: 0, tooBig: false };
  }

  /** Consumes collected bytes up to the terminator. Returns false while incomplete. */
  private collect(): boolean {
    const c = this.collecting!;
    const data = this.joined();
    let end = -1; // bytes that belong to the sequence, terminator included
    let content = -1; // bytes of content before the terminator
    let ok = true;
    for (let i = 0; i < data.length; i++) {
      const b = data[i];
      if (b === 0x07 && c.kind === 'osc') {
        end = i + 1;
        content = i;
        break;
      }
      if (b === CAN || b === SUB) {
        end = i + 1;
        content = i;
        ok = false;
        break;
      }
      if (b === 0x1b) {
        if (i + 1 >= data.length) {
          // Cannot tell ST from an abort yet: keep the ESC for later.
          end = -2;
          content = i;
          break;
        }
        if (data[i + 1] === 0x5c) {
          end = i + 2;
          content = i;
        } else {
          // ESC starts a new sequence: the string ends here, unterminated.
          end = i;
          content = i;
          ok = false;
        }
        break;
      }
    }
    const take = end === -1 ? data.length : end === -2 ? content : end;
    const bytes = this.take(take);
    this.host.dropped?.(take);
    const body = end === -1 || end === -2 ? bytes : bytes.subarray(0, content);
    if (!c.tooBig) {
      c.size += body.length;
      if (c.size > MAX_IMAGE_SEQUENCE) c.tooBig = true;
      else c.chunks.push(body.slice());
    }
    if (end < 0) return false;
    this.collecting = undefined;
    if (!ok || c.tooBig) return true;
    const all = new Uint8Array(c.size);
    let off = 0;
    for (const ch of c.chunks) {
      all.set(ch, off);
      off += ch.length;
    }
    if (c.kind === 'dcs') this.decode({ kind: 'sixel', data: all, background: this.term.background ?? 0 }, 'sixel');
    else {
      const text = new TextDecoder().decode(all);
      if (text.startsWith('66;')) this.textSizingFallback(text);
      else this.itermCommand(text);
    }
    return true;
  }

  /**
   * Kitty text sizing (OSC 66 ; metadata ; text): libghostty-vt has no
   * scaled text and drops the whole sequence, text included. Print the text
   * at normal size instead, as the protocol expects of terminals without it.
   */
  private textSizingFallback(osc: string): void {
    const semi = osc.indexOf(';', 3);
    if (semi < 0) return;
    const text = osc
      .slice(semi + 1)
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
      .slice(0, 4096);
    if (!text) return;
    const bytes = new TextEncoder().encode(text);
    // At ground: the OSC was cancelled with CAN and nothing has come after it yet.
    this.term.write(bytes);
    this.host.forward(bytes, false);
  }

  private itermCommand(text: string): void {
    // 1337;File=args:base64 | 1337;MultipartFile=args | 1337;FilePart=base64 | 1337;FileEnd
    const body = text.slice('1337;'.length);
    if (body.startsWith('File=')) {
      const colon = body.indexOf(':');
      if (colon < 0) return;
      this.itermImage(body.slice(5, colon), body.slice(colon + 1));
    } else if (body.startsWith('MultipartFile=')) {
      this.multipart = { args: body.slice('MultipartFile='.length), parts: [], size: 0 };
    } else if (body.startsWith('FilePart=') && this.multipart) {
      const part = body.slice('FilePart='.length);
      this.multipart.size += part.length;
      if (this.multipart.size > MAX_IMAGE_SEQUENCE) this.multipart = undefined;
      else this.multipart.parts.push(part);
    } else if (body.startsWith('FileEnd') && this.multipart) {
      const m = this.multipart;
      this.multipart = undefined;
      this.itermImage(m.args, m.parts.join(''));
    }
  }

  private itermImage(argText: string, base64: string): void {
    const args = parseItermArgs(argText);
    // inline=0 asks to download the file; a terminal tab has nowhere to put it.
    if (!args.inline) return;
    const data = new Uint8Array(Buffer.from(base64, 'base64'));
    if (!data.length) return;
    this.decode({ kind: 'file', data }, args);
  }

  /** Pauses the stream until the sidecar has decoded the image, then places it. */
  private decode(req: DecodeRequest, how: 'sixel' | ReturnType<typeof parseItermArgs>): void {
    const decodeImage = this.host.decodeImage;
    if (!decodeImage) return;
    this.state = 'awaitingImage';
    decodeImage(req).then(
      (img) => this.placeImage(img, how),
      () => this.placeImage(undefined, how),
    );
  }

  private placeImage(img: DecodedImage | undefined, how: 'sixel' | ReturnType<typeof parseItermArgs>): void {
    if (this.disposed) return;
    this.state = 'idle';
    if (img) {
      try {
        const id = this.nextImageId++;
        let seq: string;
        if (how === 'sixel') {
          // Sixel images are drawn at their pixel size. With sixel display
          // mode (DECSDM) the image goes to the top left and the cursor stays;
          // otherwise the cursor moves to the line below the image.
          if (this.term.getMode(SIXEL_DISPLAY_MODE)) {
            seq = `\x1b7\x1b[H${kittyCommands(img, id, { moveCursor: false })}\x1b8`;
          } else {
            const rows = Math.max(1, Math.ceil(img.height / this.metrics.cellHeight));
            seq = kittyCommands(img, id, { moveCursor: false }) + '\n'.repeat(rows);
          }
        } else {
          const place = itermPlacement(how, img.width, img.height, {
            cols: this.term.cols,
            rows: this.term.rows,
            cellWidth: this.metrics.cellWidth,
            cellHeight: this.metrics.cellHeight,
          });
          seq = kittyCommands(img, id, { ...place, moveCursor: true });
        }
        // At ground: the sequence was cancelled and nothing came after it yet.
        const bytes = new TextEncoder().encode(seq);
        this.term.write(bytes);
        this.host.forward(bytes, false);
      } catch (e) {
        this.host.error?.(e);
      }
    }
    this.process();
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
    if (this.state !== 'idle' || this.atOsc || this.atDcs || this.collecting || this.pendingBytes || !this.injected.length) return;
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
    this.imagesOn = on;
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

  /** Nothing in flight (no image decode, no held clipboard read): a snapshot now is consistent. */
  get settled(): boolean {
    return this.state === 'idle' && !this.collecting;
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
/**
 * For the bytes after `ESC ]`: a complete, properly terminated Kitty
 * notification (OSC 99) with its body after `99;`, 'other', or 'incomplete'.
 */
export function classifyKittyNotification(data: Uint8Array): { body: string; terminator: 'st' | 'bel' } | 'other' | 'incomplete' {
  const head = String.fromCharCode(...data.subarray(0, 3));
  if (head !== '99;') return '99;'.startsWith(head) ? 'incomplete' : 'other';
  const end = oscEnd(data);
  if (!end) return 'incomplete';
  const last = data[end - 1];
  if (last !== BEL && !(last === BACKSLASH && data[end - 2] === ESC)) return 'other';
  return { body: utf8.decode(data.subarray(3, last === BEL ? end - 1 : end - 2)), terminator: last === BEL ? 'bel' : 'st' };
}

export type ConEmuCommand =
  | { kind: 'tabTitle'; title: string | undefined }
  | { kind: 'messageBox'; text: string }
  /** Parsed by libghostty-vt but not acted on: 9;1, 9;5 to 9;8, 9;10, 9;11. */
  | { kind: 'dropped'; content: Uint8Array; terminator: 'st' | 'bel' };

const utf8 = new TextDecoder();

/**
 * For the bytes after `ESC ]`: a ConEmu OSC 9 command that libghostty-vt
 * drops, 'other' for anything else (including the OSC 9 forms it handles
 * itself: notifications, 9;4 progress, 9;9 directory, 9;12 prompt), or
 * 'incomplete'. Follows libghostty-vt's OSC 9 parser exactly, so a sequence
 * is never both a notification and a ConEmu command.
 */
export function classifyConEmu(data: Uint8Array): ConEmuCommand | 'other' | 'incomplete' {
  if (data.length < 2) return data.length === 0 || data[0] === 0x39 ? 'incomplete' : 'other';
  if (data[0] !== 0x39 || data[1] !== 0x3b) return 'other';
  const end = oscEnd(data);
  if (!end) return 'incomplete';
  const last = data[end - 1];
  // Cancelled (CAN/SUB) or aborted by another ESC: the terminal drops it too.
  if (last !== BEL && !(last === BACKSLASH && data[end - 2] === ESC)) return 'other';
  const terminator = last === BEL ? 'bel' : 'st';
  const content = data.slice(0, last === BEL ? end - 1 : end - 2);
  const s = String.fromCharCode(...content.subarray(2, 6));
  const text = (from: number) => utf8.decode(content.subarray(2 + from));
  const other = { kind: 'dropped', content, terminator } as const;
  switch (s[0]) {
    case '1':
      if (s[1] === ';') return other; // sleep
      if (s[1] === '0') {
        if (content.length === 4) return other; // xterm emulation
        return s[2] === ';' && s[3] !== undefined && '0123'.includes(s[3]) ? other : 'other';
      }
      if (s[1] === '1') return s[2] === ';' ? other : 'other'; // comment
      return 'other'; // 9;12 prompt (libghostty-vt), or a notification
    case '2':
      return s[1] === ';' ? { kind: 'messageBox', text: text(2) } : 'other';
    case '3':
      if (s[1] !== ';') return 'other';
      return { kind: 'tabTitle', title: content.length === 4 ? undefined : text(2) };
    case '5':
      return other; // wait for input
    case '6':
    case '7':
    case '8':
      return s[1] === ';' ? other : 'other';
    default:
      return 'other';
  }
}

/** For the bytes after `ESC ]`: Kitty text sizing (OSC 66), something else, or too short to tell. */
export function classifyTextSizing(data: Uint8Array): 'textSizing' | 'other' | 'incomplete' {
  const head = String.fromCharCode(...data.subarray(0, 3));
  if (head === '66;') return 'textSizing';
  return '66;'.startsWith(head) ? 'incomplete' : 'other';
}

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
