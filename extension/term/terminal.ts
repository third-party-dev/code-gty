// gty-term: the browser terminal. It owns the mirror engine (a libghostty-vt
// terminal fed the same bytes as the host's, in the same order), draws it on
// a canvas, and turns keyboard, IME, mouse and wheel input into bytes for the
// program using the mirror's modes.
//
// Nothing here talks to VS Code. The webview glue (webview/main.ts) passes
// bytes in and gets encoded input, resize requests and actions back through
// `TermHooks`.

import { Rgb, Vt } from '../vt/core';
import { encodeFocus, KEY_CODES, KeyEncoder, KeyInput, MouseEncoder } from '../vt/input';
import { KittyImages } from '../vt/kitty';
import { CellFlag, RenderState, Row, rowText } from '../vt/render';
import { format, gridRef, hyperlinkAt, selectAll, SelectionGesture, getSelection, setSelection, selectWord } from '../vt/selection';
import { SnapshotRestore } from '../vt/snapshot';
import { Modes, Terminal } from '../vt/terminal';
import { findFileLinks, FoundLink } from './fileLinks';
import { FindController } from './find';
import { loadLayoutMap, modsOf, toKeyInput } from './keyboard';
import { FrameState, ImageDraw, Palette, Renderer, RenderOptions } from './renderer';
import { hexToRgb, Theme, themePalette } from './theme';

export interface TermOptions extends RenderOptions {
  cursorBlink: boolean;
  scrollback: number;
  wordSeparators: string;
  macOptionIsMeta: boolean;
  isMac: boolean;
  kittyKeyboard: boolean;
  images: boolean;
  /** Pixels of padding around the grid (CSS). */
  padding: number;
}

export interface TermHooks {
  /** Encoded input for the program. `binary` means one byte per char code. */
  input(data: string, binary: boolean): void;
  /** The grid size the webview can show; the host confirms with `applyResize`. */
  requestResize(cols: number, rows: number, cellWidth: number, cellHeight: number): void;
  bell(): void;
  selectionChanged(text: string): void;
  /** Ctrl/Cmd-click on a link. */
  openLink(kind: 'url' | 'file', text: string): void;
  /** Returns true to swallow a key before the terminal sees it (pass-through rules). */
  keyFilter(e: KeyboardEvent): boolean;
  /** Link activation needs this modifier held. */
  linkModifierHeld(e: MouseEvent): boolean;
  log(level: 'info' | 'warn' | 'error', message: string): void;
  /** Called after each processed output batch. */
  outputProcessed?(): void;
}

const BYTES_PER_LINE = 512;
const HOLD_TIMEOUT_MS = 1000;
const BLINK_MS = 600;
const URL_RE = /\b(?:https?|ftp|file|mailto|ssh|git):[^\s"'<>`]+[^\s"'<>`.,;:!?)\]}]/g;

interface Link {
  kind: 'url' | 'file';
  text: string;
  y: number;
  start: number;
  end: number;
}

export class GtyTerminal {
  readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly scrollbar: HTMLDivElement;
  private readonly thumb: HTMLDivElement;
  private readonly renderer: Renderer;
  private term: Terminal | undefined;
  private rs: RenderState | undefined;
  private keys: KeyEncoder;
  private mouse: MouseEncoder;
  private gesture: SelectionGesture | undefined;
  private restore: SnapshotRestore | undefined;
  readonly find: FindController;
  private opts: TermOptions;
  private theme: Theme;
  private palette!: Palette;
  private cols = 0;
  private rows = 0;
  private focused = false;
  private held = false;
  private holdTimer: ReturnType<typeof setTimeout> | undefined;
  private frame: number | undefined;
  private forceFull = true;
  private cursorOn = true;
  private blinkOn = true;
  private blinkTimer: ReturnType<typeof setInterval> | undefined;
  private preedit = '';
  private composing = false;
  private hover: Link | undefined;
  private lastRows: Row[] = [];
  private buttons = 0;
  private dragging = false;
  private autoscrollTimer: ReturnType<typeof setInterval> | undefined;
  private lastPointer: { x: number; y: number } = { x: 0, y: 0 };
  private resizeObserver: ResizeObserver;
  private dprQuery: MediaQueryList | undefined;
  private readonly abort = new AbortController();
  private disposed = false;
  private wheelRemainder = 0;
  private selectionText = '';

  constructor(
    readonly vt: Vt,
    container: HTMLElement,
    findRoot: HTMLElement,
    opts: TermOptions,
    theme: Theme,
    private readonly hooks: TermHooks,
  ) {
    this.opts = opts;
    this.theme = theme;
    this.root = container;
    container.replaceChildren();
    container.classList.add('gty');
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'gty-canvas';
    this.textarea = document.createElement('textarea');
    this.textarea.className = 'gty-input';
    this.textarea.setAttribute('autocorrect', 'off');
    this.textarea.setAttribute('autocapitalize', 'off');
    this.textarea.setAttribute('spellcheck', 'false');
    this.textarea.setAttribute('aria-label', 'Terminal input');
    this.textarea.tabIndex = 0;
    this.scrollbar = document.createElement('div');
    this.scrollbar.className = 'gty-scrollbar';
    this.thumb = document.createElement('div');
    this.thumb.className = 'gty-thumb';
    this.scrollbar.append(this.thumb);
    container.append(this.canvas, this.textarea, this.scrollbar);
    this.palette = this.makePalette(theme);
    this.renderer = new Renderer(this.canvas, opts, this.palette);
    this.keys = new KeyEncoder(vt);
    this.mouse = new MouseEncoder(vt);
    const mirror = () => this.term;
    this.find = new FindController(
      {
        get mirror() {
          return mirror();
        },
        refresh: () => this.schedule(true),
        focusTerminal: () => this.focus(),
        selectionText: () => this.getSelection(),
        cols: () => this.cols,
        rows: () => this.rows,
      },
      findRoot,
    );
    this.bindEvents();
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(container);
    this.watchDpr();
    void loadLayoutMap();
    this.restartBlink();
  }

  // ---- engine ---------------------------------------------------------------

  private terminalOptions() {
    const t = this.theme;
    return {
      scrollbackLines: this.opts.scrollback,
      scrollbackBytes: Math.max(1, this.opts.scrollback) * BYTES_PER_LINE,
      kittyImageStorageLimit: this.opts.images ? 320 * 1024 * 1024 : 0,
      continuationMaxBytes: 0,
      colors: { foreground: hexToRgb(t.foreground), background: hexToRgb(t.background), cursor: hexToRgb(t.cursor), palette: themePalette(t) },
      cursorStyle: this.opts.cursorStyle,
      cursorBlink: this.opts.cursorBlink,
      effects: {
        renderHold: (held: boolean) => this.onRenderHold(held),
        bell: () => this.hooks.bell(),
        onError: (e: unknown) => this.hooks.log('error', `mirror: ${String(e)}`),
      },
    };
  }

  /**
   * Starts the mirror: from a host snapshot (exact restore, history streamed
   * in afterwards) or empty, sized `cols` x `rows`.
   */
  attach(snapshot: Uint8Array | undefined, cols: number, rows: number): void {
    this.detach();
    if (snapshot?.length) {
      this.restore = new SnapshotRestore(this.vt, snapshot);
      this.term = this.restore.ready(this.terminalOptions());
      this.pumpHistory();
    } else {
      this.term = Terminal.create(this.vt, { cols, rows, ...this.terminalOptions() });
    }
    this.rs = new RenderState(this.vt);
    this.gesture = new SelectionGesture(this.vt, this.term);
    // Always size the mirror with cell pixels: images are placed in pixels,
    // and without a cell size the library has nothing to draw.
    this.term.resize(cols, rows, this.renderer.cellMetrics.cellW, this.renderer.cellMetrics.cellH);
    this.cols = cols;
    this.rows = rows;
    this.find.reset();
    this.syncMouseGeometry();
    this.schedule(true);
  }

  private pumpHistory(): void {
    const step = () => {
      const r = this.restore;
      if (!r || this.disposed) return;
      try {
        if (r.step(8)) {
          r.dispose();
          this.restore = undefined;
          this.schedule(false);
          return;
        }
      } catch (e) {
        this.hooks.log('warn', `snapshot history: ${String(e)}`);
        r.dispose();
        this.restore = undefined;
        return;
      }
      setTimeout(step, 0);
    };
    setTimeout(step, 0);
  }

  private detach(): void {
    this.restore?.dispose();
    this.restore = undefined;
    this.gesture?.dispose();
    this.gesture = undefined;
    this.rs?.dispose();
    this.rs = undefined;
    this.term?.dispose();
    this.term = undefined;
    this.held = false;
    clearTimeout(this.holdTimer);
  }

  get mirror(): Terminal | undefined {
    return this.term;
  }

  /** Output the host has processed, in stream order. */
  write(data: Uint8Array): void {
    const t = this.term;
    if (!t) return;
    t.write(data);
    this.find.onOutput();
    this.hooks.outputProcessed?.();
    this.schedule(false);
  }

  /** The host resized its engine and the PTY: resize the mirror at the same point in the stream. */
  applyResize(cols: number, rows: number): void {
    const t = this.term;
    if (!t) return;
    const m = this.renderer.cellMetrics;
    t.resize(cols, rows, m.cellW, m.cellH);
    this.cols = cols;
    this.rows = rows;
    this.syncMouseGeometry();
    this.schedule(true);
  }

  private onRenderHold(held: boolean): void {
    // Capture the frame the program wants left on screen, then stop updating
    // until the hold ends (or times out).
    if (held && this.rs && this.term) this.rs.update(this.term);
    this.held = held;
    clearTimeout(this.holdTimer);
    if (held) {
      this.holdTimer = setTimeout(() => {
        if (this.held && this.term) {
          this.term.setMode(Modes.SYNCHRONIZED_OUTPUT, false);
          this.held = false;
          this.schedule(false);
        }
      }, HOLD_TIMEOUT_MS);
    }
  }

  // ---- options ------------------------------------------------------------------

  private makePalette(t: Theme): Palette {
    const pal16 = themePalette(t);
    return {
      foreground: hexToRgb(t.foreground),
      background: hexToRgb(t.background),
      cursor: hexToRgb(t.cursor),
      cursorAccent: hexToRgb(t.cursorAccent),
      selectionBackground: hexToRgb(t.selectionBackground),
      selectionForeground: t.selectionForeground ? hexToRgb(t.selectionForeground) : undefined,
      findMatch: hexToRgb(t.findMatchBackground ?? '#9e6a03'),
      findMatchHighlight: hexToRgb(t.findMatchHighlightBackground ?? '#623315'),
      palette: pal16,
    };
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.palette = this.makePalette(theme);
    this.term?.setColors(this.terminalOptions().colors);
    this.schedule(true);
  }

  setOptions(opts: TermOptions): void {
    const prev = this.opts;
    this.opts = opts;
    const before = this.renderer.cellMetrics;
    this.renderer.setOptions(opts);
    const after = this.renderer.cellMetrics;
    if (before.cellW !== after.cellW || before.cellH !== after.cellH) {
      this.term?.resize(this.cols, this.rows, after.cellW, after.cellH);
      this.syncMouseGeometry();
    }
    if (prev.images !== opts.images) this.term?.setKittyImageLimit(opts.images ? 320 * 1024 * 1024 : 0);
    if (prev.scrollback !== opts.scrollback) this.term?.setScrollback(Math.max(1, opts.scrollback) * BYTES_PER_LINE, opts.scrollback);
    if (prev.cursorStyle !== opts.cursorStyle || prev.cursorBlink !== opts.cursorBlink) this.term?.setCursorDefaults(opts.cursorStyle, opts.cursorBlink);
    this.restartBlink();
    this.fit();
    this.schedule(true);
  }

  /** Re-measures the font (after it loads, or on zoom) and refits. */
  remeasure(): void {
    const m = this.renderer.measure();
    // Same grid, new cell pixels (zoom, another monitor, font change).
    this.term?.resize(this.cols, this.rows, m.cellW, m.cellH);
    this.syncMouseGeometry();
    this.fit();
    this.schedule(true);
  }

  private watchDpr(): void {
    this.dprQuery?.removeEventListener('change', this.onDpr);
    this.dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    this.dprQuery.addEventListener('change', this.onDpr);
  }

  private readonly onDpr = () => {
    this.watchDpr();
    this.remeasure();
  };

  get cellMetrics(): { cellWidth: number; cellHeight: number; dpr: number } {
    const m = this.renderer.cellMetrics;
    return { cellWidth: m.cellW, cellHeight: m.cellH, dpr: m.dpr };
  }

  /** Measures the container and asks the host for the size that fits. */
  fit(): void {
    const pad = this.opts.padding;
    const w = Math.max(0, this.root.clientWidth - pad * 2 - 10);
    const h = Math.max(0, this.root.clientHeight - pad * 2);
    this.renderer.resizeCanvas(w + 10, h);
    const m = this.renderer.cellMetrics;
    const cols = Math.max(2, Math.floor(w / m.cssCellWidth));
    const rows = Math.max(1, Math.floor(h / m.cssCellHeight));
    if (!w || !h) return;
    this.hooks.requestResize(cols, rows, m.cellW, m.cellH);
    this.schedule(true);
  }

  private syncMouseGeometry(): void {
    const m = this.renderer.cellMetrics;
    this.mouse.setGeometry({ screenWidth: this.cols * m.cellW, screenHeight: this.rows * m.cellH, cellWidth: m.cellW, cellHeight: m.cellH });
  }

  // ---- rendering ----------------------------------------------------------------

  /** Schedules a frame. `full` forces a complete redraw. */
  schedule(full: boolean): void {
    if (full) this.forceFull = true;
    if (this.frame !== undefined || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      this.drawFrame();
    });
  }

  private drawFrame(): void {
    const t = this.term;
    const rs = this.rs;
    if (!t || !rs) return;
    try {
      // During a render hold, keep drawing the frame captured when it began.
      if (!this.held) rs.update(t);
      const dirty = rs.dirty;
      const full = this.forceFull || dirty === 'full';
      this.forceFull = false;
      const colors = rs.colors();
      this.palette = { ...this.palette, foreground: colors.foreground, background: colors.background, cursor: colors.cursor ?? this.palette.cursor, palette: colors.palette };
      this.renderer.setPaletteQuiet(this.palette);
      const fresh = dirty === 'clean' && !full ? [] : rs.readRows(colors.palette, !full);
      for (const r of fresh) this.lastRows[r.y] = r;
      this.lastRows.length = this.rows;
      const cursor = rs.cursor();
      const state: FrameState = {
        focused: this.focused,
        cursorOn: this.cursorOn,
        blinkOn: this.blinkOn,
        preedit: this.preedit,
        highlights: this.find.highlights(),
        hover: this.hover ? { y: this.hover.y, start: this.hover.start, end: this.hover.end } : undefined,
        images: this.images(),
      };
      this.renderer.draw(fresh, full, rs.cols, rs.rows, cursor, state);
      if (!this.held) rs.clean();
      this.placeTextarea(cursor.x, cursor.y);
      this.updateScrollbar();
      this.updatePointerShape();
    } catch (e) {
      this.hooks.log('error', `render: ${(e as Error).stack ?? e}`);
    }
  }

  private kitty: KittyImages | undefined;
  private imageCache = new Map<string, HTMLCanvasElement | OffscreenCanvas>();
  private animationTimer: ReturnType<typeof setTimeout> | undefined;

  /** Kitty graphics placements of the current frame, with their pixels. */
  private images(): ImageDraw[] {
    const t = this.term;
    const rs = this.rs;
    if (!t || !rs || !this.vt.features.kittyGraphics) return [];
    this.kitty ??= new KittyImages(this.vt);
    const placements = this.kitty.placements(rs);
    if (!placements.length) {
      if (this.imageCache.size) this.imageCache.clear();
      return [];
    }
    const m = this.renderer.cellMetrics;
    const used = new Set<string>();
    const out: ImageDraw[] = [];
    for (const p of placements) {
      const key = `${p.imageId}:${p.generation}`;
      used.add(key);
      let source = this.imageCache.get(key);
      if (!source) {
        const px = t.isDisposed ? undefined : this.kitty.pixels(t, p.imageId);
        if (!px) continue;
        const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(px.width, px.height) : Object.assign(document.createElement('canvas'), { width: px.width, height: px.height });
        (c.getContext('2d') as CanvasRenderingContext2D).putImageData(new ImageData(px.rgba, px.width, px.height), 0, 0);
        source = c;
        this.imageCache.set(key, c);
      }
      out.push({ layer: p.layer, z: p.z, source: source as CanvasImageSource, sx: p.sx, sy: p.sy, sw: p.sw, sh: p.sh, dx: p.col * m.cellW + p.offsetX, dy: p.row * m.cellH + p.offsetY, dw: p.width, dh: p.height });
    }
    for (const k of [...this.imageCache.keys()]) if (!used.has(k)) this.imageCache.delete(k);
    // Animated images: advance and come back when the next frame is due.
    const next = this.kitty.tick(t, performance.timeOrigin + performance.now());
    clearTimeout(this.animationTimer);
    if (next !== undefined) this.animationTimer = setTimeout(() => this.schedule(true), Math.max(16, next));
    return out;
  }

  private placeTextarea(x: number | undefined, y: number | undefined): void {
    if (x === undefined || y === undefined) return;
    const m = this.renderer.cellMetrics;
    // Keep the IME candidate window next to the cursor.
    this.textarea.style.left = `${this.opts.padding + x * m.cssCellWidth}px`;
    this.textarea.style.top = `${this.opts.padding + y * m.cssCellHeight}px`;
    this.textarea.style.height = `${m.cssCellHeight}px`;
  }

  private updateScrollbar(): void {
    const t = this.term;
    if (!t) return;
    const sb = t.scrollbar;
    if (sb.total <= sb.len) {
      this.scrollbar.hidden = true;
      return;
    }
    this.scrollbar.hidden = false;
    const h = this.scrollbar.clientHeight;
    const th = Math.max(20, (sb.len / sb.total) * h);
    this.thumb.style.height = `${th}px`;
    this.thumb.style.top = `${(sb.offset / Math.max(1, sb.total - sb.len)) * (h - th)}px`;
  }

  private updatePointerShape(): void {
    const t = this.term;
    if (!t) return;
    if (this.hover) {
      this.canvas.style.cursor = 'pointer';
      return;
    }
    const SHAPES = ['', 'context-menu', 'help', 'pointer', 'progress', 'wait', 'cell', 'crosshair', 'text', 'vertical-text', 'alias', 'copy', 'move', 'no-drop', 'not-allowed', 'grab', 'grabbing', 'all-scroll', 'col-resize', 'row-resize', 'n-resize', 'e-resize', 's-resize', 'w-resize', 'ne-resize', 'nw-resize', 'se-resize', 'sw-resize', 'ew-resize', 'ns-resize', 'nesw-resize', 'nwse-resize', 'zoom-in', 'zoom-out'];
    const shape = SHAPES[t.mouseShape] || (t.mouseTracking ? 'default' : 'text');
    this.canvas.style.cursor = shape;
  }

  private restartBlink(): void {
    clearInterval(this.blinkTimer);
    this.cursorOn = true;
    this.blinkTimer = setInterval(() => {
      this.blinkOn = !this.blinkOn;
      const cur = this.rs ? this.rs.cursor() : undefined;
      if (cur?.blinking && this.focused) this.cursorOn = !this.cursorOn;
      else this.cursorOn = true;
      this.schedule(false);
    }, BLINK_MS);
  }

  // ---- text access --------------------------------------------------------------

  hasSelection(): boolean {
    return !!this.term && getSelection(this.term) !== undefined;
  }

  getSelection(): string {
    const t = this.term;
    if (!t) return '';
    const sel = getSelection(t);
    return sel ? format(t, { selection: sel, unwrap: true }) : '';
  }

  /** The selection as HTML, for a second clipboard flavour. */
  getSelectionHtml(): string {
    const t = this.term;
    const sel = t && getSelection(t);
    return t && sel ? format(t, { selection: sel, format: 'html', unwrap: true }) : '';
  }

  clearSelection(): void {
    if (this.term) setSelection(this.term, undefined);
    this.selectionChanged();
  }

  selectAll(): void {
    const t = this.term;
    if (!t) return;
    setSelection(t, selectAll(t));
    this.selectionChanged();
  }

  /** Selects the word at a viewport cell (right-click "selectWord"). */
  selectWordAt(x: number, y: number): void {
    const t = this.term;
    if (!t) return;
    setSelection(t, selectWord(t, 'viewport', { x, y }, this.opts.wordSeparators));
    this.selectionChanged();
  }

  private selectionChanged(): void {
    const text = this.getSelection();
    if (text !== this.selectionText) {
      this.selectionText = text;
      this.hooks.selectionChanged(text);
    }
    this.schedule(true);
  }

  /** The visible rows as text, for the accessibility region. */
  visibleText(): string {
    const lines = this.lastRows.map((r) => (r ? rowText(r) : ''));
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    return lines.join('\n');
  }

  get hasBracketedPaste(): boolean {
    return !!this.term?.getMode(Modes.BRACKETED_PASTE);
  }

  // ---- scrolling ----------------------------------------------------------------

  scrollLines(n: number): void {
    this.term?.scrollViewport({ delta: n });
    this.schedule(true);
  }

  scrollToBottom(): void {
    this.term?.scrollViewport({ bottom: true });
    this.schedule(true);
  }

  /** Moves the viewport to the previous (-1) or next (+1) shell prompt. */
  scrollToPrompt(delta: number): void {
    this.term?.scrollViewport({ prompts: delta });
    this.schedule(true);
  }

  // ---- focus ----------------------------------------------------------------------

  focus(): void {
    this.textarea.focus({ preventScroll: true });
  }

  private setFocused(f: boolean): void {
    if (this.focused === f) return;
    this.focused = f;
    this.cursorOn = true;
    const t = this.term;
    if (t?.getMode(Modes.FOCUS_EVENT)) this.send(encodeFocus(this.vt, f));
    this.schedule(false);
  }

  // ---- input ------------------------------------------------------------------------

  private send(bytes: Uint8Array): void {
    if (!bytes.length) return;
    // Encoders produce UTF-8 except legacy mouse formats; send those byte for byte.
    let binary = false;
    for (const b of bytes) if (b >= 0x80) binary = true;
    if (binary) {
      try {
        this.hooks.input(new TextDecoder('utf-8', { fatal: true }).decode(bytes), false);
        return;
      } catch {
        /* not UTF-8 */
      }
      this.hooks.input(String.fromCharCode(...bytes), true);
    } else {
      this.hooks.input(String.fromCharCode(...bytes), false);
    }
    this.cursorOn = true;
  }

  /** Sends typed text (IME commits, dead-key results) as UTF-8. */
  private sendText(text: string): void {
    if (!text) return;
    this.hooks.input(text, false);
    this.term?.scrollViewport({ bottom: true });
    this.schedule(false);
  }

  /** Encodes and sends a key with the mirror's current modes. */
  sendKey(k: KeyInput): boolean {
    const t = this.term;
    if (!t) return false;
    this.keys.macOptionAsAlt = this.opts.isMac ? (this.opts.macOptionIsMeta ? 'true' : 'false') : 'true';
    this.keys.sync(t, this.opts.kittyKeyboard);
    const bytes = this.keys.encode(k);
    if (!bytes.length) return false;
    if (k.action !== 'release') {
      t.scrollViewport({ bottom: true });
      if (this.hasSelection() && !this.opts.isMac) this.clearSelection();
    }
    this.send(bytes);
    this.schedule(false);
    return true;
  }

  private bindEvents(): void {
    const signal = this.abort.signal;
    const ta = this.textarea;
    ta.addEventListener('focus', () => this.setFocused(true), { signal });
    ta.addEventListener('blur', () => this.setFocused(false), { signal });
    ta.addEventListener(
      'keydown',
      (e) => {
        if (this.hooks.keyFilter(e)) return;
        if (this.composing || e.isComposing || e.key === 'Process' || e.keyCode === 229) return;
        const k = toKeyInput(e, e.repeat ? 'repeat' : 'press', this.opts.isMac && !this.opts.macOptionIsMeta);
        // Dead keys produce no text yet: let the input event deliver the result.
        if (e.key === 'Dead') return;
        if (this.sendKey(k)) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      { signal },
    );
    ta.addEventListener(
      'keyup',
      (e) => {
        if (this.composing || e.isComposing) return;
        // Release events only produce output under Kitty's report-events flag.
        if (this.term && this.term.kittyKeyboardFlags & 0b10) this.sendKey(toKeyInput(e, 'release', this.opts.isMac && !this.opts.macOptionIsMeta));
      },
      { signal },
    );
    ta.addEventListener('compositionstart', () => {
      this.composing = true;
      this.preedit = '';
    }, { signal });
    ta.addEventListener('compositionupdate', (e) => {
      this.preedit = e.data ?? '';
      this.schedule(false);
    }, { signal });
    ta.addEventListener('compositionend', (e) => {
      this.composing = false;
      this.preedit = '';
      this.sendText(e.data ?? '');
      ta.value = '';
      this.schedule(false);
    }, { signal });
    ta.addEventListener('input', (e) => {
      const ie = e as InputEvent;
      if (this.composing || ie.isComposing) return;
      // Text that did not come through keydown (dead keys, emoji picker, dictation).
      if (ie.inputType === 'insertText' && ie.data) this.sendText(ie.data);
      ta.value = '';
    }, { signal });

    const c = this.canvas;
    c.addEventListener('mousedown', (e) => this.onMouseDown(e), { signal });
    window.addEventListener('mousemove', (e) => this.onMouseMove(e), { signal });
    window.addEventListener('mouseup', (e) => this.onMouseUp(e), { signal });
    c.addEventListener('wheel', (e) => this.onWheel(e), { signal, passive: false });
    c.addEventListener('mouseleave', () => {
      if (this.hover) {
        this.hover = undefined;
        this.schedule(false);
      }
    }, { signal });

    // Scrollbar dragging.
    this.thumb.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const t = this.term;
      if (!t) return;
      const startY = e.clientY;
      const sb = t.scrollbar;
      const h = this.scrollbar.clientHeight;
      const th = Math.max(20, (sb.len / sb.total) * h);
      const move = (ev: MouseEvent) => {
        const frac = (ev.clientY - startY) / Math.max(1, h - th);
        t.scrollViewport({ row: Math.round(sb.offset + frac * (sb.total - sb.len)) });
        this.schedule(true);
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    }, { signal });
  }

  /** Device-pixel position inside the grid, and the cell under it. */
  private pointer(e: MouseEvent): { px: number; py: number; col: number; row: number } {
    const rect = this.canvas.getBoundingClientRect();
    const m = this.renderer.cellMetrics;
    const px = (e.clientX - rect.left) * m.dpr;
    const py = (e.clientY - rect.top) * m.dpr;
    const col = Math.max(0, Math.min(this.cols - 1, Math.floor(px / m.cellW)));
    const row = Math.max(0, Math.min(this.rows - 1, Math.floor(py / m.cellH)));
    return { px, py, col, row };
  }

  private reportsMouse(e: MouseEvent): boolean {
    // Shift overrides mouse capture, as in VS Code's terminal.
    return !!this.term?.mouseTracking && !e.shiftKey;
  }

  private mouseButton(e: MouseEvent): number {
    return e.button === 0 ? 1 : e.button === 1 ? 3 : e.button === 2 ? 2 : e.button === 3 ? 8 : e.button === 4 ? 9 : 0;
  }

  private onMouseDown(e: MouseEvent): void {
    const t = this.term;
    if (!t) return;
    this.focus();
    e.preventDefault();
    const p = this.pointer(e);
    this.lastPointer = { x: p.px, y: p.py };
    if (this.hover && e.button === 0 && this.hooks.linkModifierHeld(e)) {
      this.hooks.openLink(this.hover.kind, this.hover.text);
      return;
    }
    if (this.reportsMouse(e)) {
      this.buttons |= 1 << e.button;
      this.mouse.sync(t);
      this.mouse.setAnyButtonPressed(true);
      this.send(this.mouse.encode({ action: 'press', button: this.mouseButton(e), mods: modsOf(e), x: p.px, y: p.py }));
      return;
    }
    if (e.button !== 0 || !this.gesture) return;
    const ref = gridRef(t, 'viewport', { x: p.col, y: p.row });
    if (!ref) return;
    const sel = this.gesture.press({ ref, x: p.px, y: p.py, timeMs: e.timeStamp, separators: this.opts.wordSeparators });
    setSelection(t, sel);
    this.dragging = true;
    this.schedule(true);
  }

  private geometry() {
    const m = this.renderer.cellMetrics;
    return { columns: this.cols, cellWidth: m.cellW, paddingLeft: 0, screenHeight: this.rows * m.cellH };
  }

  private onMouseMove(e: MouseEvent): void {
    const t = this.term;
    if (!t) return;
    const p = this.pointer(e);
    this.lastPointer = { x: p.px, y: p.py };
    if (this.reportsMouse(e) && (this.buttons || e.target === this.canvas)) {
      this.mouse.sync(t);
      this.mouse.setAnyButtonPressed(this.buttons !== 0);
      const btn = this.buttons & 1 ? 1 : this.buttons & 4 ? 3 : this.buttons & 2 ? 2 : 0;
      this.send(this.mouse.encode({ action: 'motion', button: btn, mods: modsOf(e), x: p.px, y: p.py }));
      return;
    }
    if (this.dragging && this.gesture) {
      const ref = gridRef(t, 'viewport', { x: p.col, y: p.row });
      if (ref) {
        const sel = this.gesture.drag({ ref, x: p.px, y: p.py, geometry: this.geometry(), rectangle: e.altKey, separators: this.opts.wordSeparators });
        if (sel) setSelection(t, sel);
        this.schedule(true);
      }
      this.updateAutoscroll();
      return;
    }
    if (e.target === this.canvas) this.updateHover(p.col, p.row);
  }

  private updateAutoscroll(): void {
    const dir = this.gesture?.autoscroll ?? 'none';
    if (dir === 'none') {
      clearInterval(this.autoscrollTimer);
      this.autoscrollTimer = undefined;
      return;
    }
    if (this.autoscrollTimer) return;
    this.autoscrollTimer = setInterval(() => {
      const t = this.term;
      const g = this.gesture;
      if (!t || !g || !this.dragging || g.autoscroll === 'none') {
        clearInterval(this.autoscrollTimer);
        this.autoscrollTimer = undefined;
        return;
      }
      const m = this.renderer.cellMetrics;
      const col = Math.max(0, Math.min(this.cols - 1, Math.floor(this.lastPointer.x / m.cellW)));
      const sel = g.autoscrollTick({ viewport: { x: col, y: g.autoscroll === 'up' ? 0 : this.rows - 1 }, x: this.lastPointer.x, y: this.lastPointer.y, geometry: this.geometry() });
      if (sel) setSelection(t, sel);
      this.schedule(true);
    }, 50);
  }

  private onMouseUp(e: MouseEvent): void {
    const t = this.term;
    if (!t) return;
    if (this.buttons) {
      this.buttons &= ~(1 << e.button);
      const p = this.pointer(e);
      this.mouse.sync(t);
      this.mouse.setAnyButtonPressed(this.buttons !== 0);
      this.send(this.mouse.encode({ action: 'release', button: this.mouseButton(e), mods: modsOf(e), x: p.px, y: p.py }));
      return;
    }
    if (!this.dragging) return;
    this.dragging = false;
    clearInterval(this.autoscrollTimer);
    this.autoscrollTimer = undefined;
    const p = this.pointer(e);
    this.gesture?.release(gridRef(t, 'viewport', { x: p.col, y: p.row }));
    // A plain click leaves no selection behind.
    const sel = getSelection(t);
    if (sel && !this.gesture?.dragged && (this.gesture?.clickCount ?? 0) <= 1) setSelection(t, undefined);
    this.selectionChanged();
  }

  private onWheel(e: WheelEvent): void {
    const t = this.term;
    if (!t) return;
    e.preventDefault();
    const m = this.renderer.cellMetrics;
    const lines = e.deltaMode === 1 ? e.deltaY : e.deltaMode === 2 ? e.deltaY * this.rows : e.deltaY / (m.cssCellHeight || 16);
    this.wheelRemainder += lines;
    const n = Math.trunc(this.wheelRemainder);
    if (!n) return;
    this.wheelRemainder -= n;
    if (this.reportsMouse(e)) {
      const p = this.pointer(e);
      this.mouse.sync(t);
      for (let i = 0; i < Math.min(Math.abs(n), 10); i++) {
        this.send(this.mouse.encode({ action: 'press', button: n < 0 ? 4 : 5, mods: modsOf(e), x: p.px, y: p.py }));
      }
      return;
    }
    if (t.altScreen && t.getMode(Modes.MOUSE_ALTERNATE_SCROLL)) {
      // Alternate scroll: the wheel sends arrow keys to full-screen programs.
      const code = n < 0 ? 'ArrowUp' : 'ArrowDown';
      for (let i = 0; i < Math.min(Math.abs(n), 10); i++) this.sendKey({ action: 'press', key: KEY_CODES.get(code) ?? 0, mods: 0 });
      return;
    }
    t.scrollViewport({ delta: n });
    this.schedule(true);
  }

  // ---- links ------------------------------------------------------------------------

  private updateHover(col: number, row: number): void {
    const t = this.term;
    if (!t) return;
    const next = this.linkAt(col, row);
    const same = next?.y === this.hover?.y && next?.start === this.hover?.start && next?.text === this.hover?.text;
    if (same) return;
    this.hover = next;
    this.schedule(false);
  }

  private linkAt(col: number, row: number): Link | undefined {
    const t = this.term;
    if (!t) return undefined;
    // OSC 8 hyperlinks come from the engine with their URI.
    const uri = hyperlinkAt(t, { x: col, y: row });
    if (uri) {
      const r = this.lastRows[row];
      let start = col;
      let end = col;
      const linked = (x: number) => !!(r?.cells[x] && r.cells[x].flags & CellFlag.Hyperlink) && hyperlinkAt(t, { x, y: row }) === uri;
      while (start > 0 && linked(start - 1)) start--;
      while (end < this.cols - 1 && linked(end + 1)) end++;
      return { kind: 'url', text: uri, y: row, start, end };
    }
    const r = this.lastRows[row];
    if (!r) return undefined;
    // Map string offsets to columns (wide characters take two).
    let text = '';
    const colOf: number[] = [];
    r.cells.forEach((c, x) => {
      if (c.wide === 2 || c.wide === 3) return;
      const s = c.text || ' ';
      for (let i = 0; i < s.length; i++) colOf.push(x);
      text += s;
    });
    colOf.push(r.cells.length);
    const hit = (start: number, end: number) => colOf[start] <= col && col <= colOf[end - 1];
    for (const m of text.matchAll(URL_RE)) {
      if (hit(m.index!, m.index! + m[0].length)) return { kind: 'url', text: m[0], y: row, start: colOf[m.index!], end: colOf[m.index! + m[0].length - 1] };
    }
    for (const l of findFileLinks(text) as FoundLink[]) {
      if (hit(l.start, l.end)) return { kind: 'file', text: l.text, y: row, start: colOf[l.start], end: colOf[l.end - 1] };
    }
    return undefined;
  }

  // ---- lifecycle --------------------------------------------------------------------

  /** The cell under a mouse event (viewport coordinates). */
  cellAt(e: MouseEvent): { x: number; y: number } {
    const p = this.pointer(e);
    return { x: p.col, y: p.row };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.resizeObserver.disconnect();
    this.dprQuery?.removeEventListener('change', this.onDpr);
    clearInterval(this.blinkTimer);
    clearInterval(this.autoscrollTimer);
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.find.dispose();
    clearTimeout(this.animationTimer);
    this.kitty?.dispose();
    this.detach();
    this.keys.dispose();
    this.mouse.dispose();
  }
}

export type { Rgb };
