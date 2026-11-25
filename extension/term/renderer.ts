// Canvas 2D renderer for gty-term, driven by libghostty-vt's render state.
//
// Cells are a whole number of device pixels wide and tall, so the grid, cell
// backgrounds and drawn glyphs (sprites.ts) land exactly on device pixels at
// any zoom or display scale. Text is drawn from a glyph cache: each distinct
// (text, style, colour) is rasterised once into a small canvas and copied.

import type { Rgb } from '../vt/core';
import { Cell, CellFlag, CursorState, Row, Underline, Wide } from '../vt/render';
import { drawSprite, isSprite } from './sprites';

export interface FontOptions {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  fontWeight: string;
  fontWeightBold: string;
}

export interface RenderOptions extends FontOptions {
  cursorStyle: 'block' | 'bar' | 'underline';
  cursorWidth: number;
  drawBoldTextInBrightColors: boolean;
  minimumContrastRatio: number;
  customGlyphs: boolean;
}

export interface Metrics {
  dpr: number;
  /** Device pixels. */
  cellW: number;
  cellH: number;
  baseline: number;
  underlineY: number;
  strikeY: number;
  lineW: number;
  /** CSS pixels (cellW / dpr). */
  cssCellWidth: number;
  cssCellHeight: number;
}

export interface Palette {
  foreground: Rgb;
  background: Rgb;
  cursor: Rgb | undefined;
  cursorAccent: Rgb;
  selectionBackground: Rgb;
  selectionForeground: Rgb | undefined;
  findMatch: Rgb;
  findMatchHighlight: Rgb;
  palette: Rgb[];
}

/** Ranges of a row to highlight (search matches), inclusive columns. */
export interface Highlight {
  y: number;
  start: number;
  end: number;
  current: boolean;
}

export interface ImageDraw {
  layer: 0 | 1 | 2;
  z: number;
  source: CanvasImageSource;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Device pixels. */
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

export interface FrameState {
  focused: boolean;
  cursorOn: boolean;
  blinkOn: boolean;
  /** IME pre-edit text shown at the cursor. */
  preedit: string;
  highlights: Highlight[];
  /** Hovered link: row and inclusive column range. */
  hover: { y: number; start: number; end: number } | undefined;
  images: ImageDraw[];
}

const css = (c: Rgb) => `#${c.toString(16).padStart(6, '0')}`;

// ---- colour maths -----------------------------------------------------------

function luminance(c: Rgb): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch((c >> 16) & 255) + 0.7152 * ch((c >> 8) & 255) + 0.0722 * ch(c & 255);
}

export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function mix(c: Rgb, toward: Rgb, t: number): Rgb {
  const m = (s: number) => Math.round(((c >> s) & 255) * (1 - t) + ((toward >> s) & 255) * t);
  return (m(16) << 16) | (m(8) << 8) | m(0);
}

const contrastCache = new Map<string, Rgb>();

/** Moves `fg` toward black or white until it reaches `ratio` against `bg` (like xterm.js). */
export function ensureContrast(fg: Rgb, bg: Rgb, ratio: number): Rgb {
  if (ratio <= 1 || contrast(fg, bg) >= ratio) return fg;
  const key = `${fg},${bg},${ratio}`;
  const hit = contrastCache.get(key);
  if (hit !== undefined) return hit;
  const target = luminance(bg) > 0.5 ? 0x000000 : 0xffffff;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (contrast(mix(fg, target, mid), bg) >= ratio) hi = mid;
    else lo = mid;
  }
  const out = mix(fg, target, hi);
  if (contrastCache.size > 4096) contrastCache.clear();
  contrastCache.set(key, out);
  return out;
}

// ---- glyph cache ------------------------------------------------------------

interface Glyph {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /** Offset of the cell origin inside the glyph canvas. */
  pad: number;
}

function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

class GlyphCache {
  private map = new Map<string, Glyph>();
  constructor(private readonly max = 6000) {}
  clear(): void {
    this.map.clear();
  }
  get(key: string, make: () => Glyph): Glyph {
    let g = this.map.get(key);
    if (g) {
      // Refresh recency.
      this.map.delete(key);
      this.map.set(key, g);
      return g;
    }
    g = make();
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value!);
    this.map.set(key, g);
    return g;
  }
}

// ---- renderer ---------------------------------------------------------------

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private metrics!: Metrics;
  private readonly glyphs = new GlyphCache();
  private opts: RenderOptions;
  private pal: Palette;
  /** Last drawn content per viewport row. */
  private rows: Row[] = [];
  private cols = 0;
  private rowCount = 0;
  private lastCursorRow: number | undefined;
  private lastHighlightRows = new Set<number>();
  private lastHoverRow: number | undefined;
  private blinkRows = new Set<number>();
  private hadImages = false;
  private needFull = true;

  constructor(
    readonly canvas: HTMLCanvasElement,
    opts: RenderOptions,
    palette: Palette,
  ) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('canvas 2D is not available');
    this.ctx = ctx;
    this.opts = opts;
    this.pal = palette;
    this.measure();
  }

  get cellMetrics(): Metrics {
    return this.metrics;
  }

  private font(bold: boolean, italic: boolean): string {
    const o = this.opts;
    const weight = bold ? o.fontWeightBold : o.fontWeight;
    return `${italic ? 'italic ' : ''}${weight} ${o.fontSize * this.metrics.dpr}px ${o.fontFamily}`;
  }

  /** Measures the cell from the font. Call after fonts load or DPR/options change. */
  measure(): Metrics {
    const dpr = window.devicePixelRatio || 1;
    const o = this.opts;
    const ctx = this.ctx;
    ctx.font = `${o.fontWeight} ${o.fontSize * dpr}px ${o.fontFamily}`;
    const m = ctx.measureText('M');
    const asc = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent ?? o.fontSize * dpr * 0.8;
    const desc = m.fontBoundingBoxDescent ?? o.fontSize * dpr * 0.2;
    const cellW = Math.max(1, Math.round(m.width + o.letterSpacing * dpr));
    const natural = Math.ceil(asc + desc);
    const cellH = Math.max(1, Math.ceil(natural * Math.max(1, o.lineHeight)));
    const baseline = Math.round((cellH - natural) / 2 + asc);
    const lineW = Math.max(1, Math.round((o.fontSize * dpr) / 14));
    const x = ctx.measureText('x');
    const xh = x.actualBoundingBoxAscent || asc * 0.5;
    this.metrics = {
      dpr,
      cellW,
      cellH,
      baseline,
      underlineY: Math.min(cellH - lineW, baseline + Math.max(1, Math.round(desc * 0.35))),
      strikeY: Math.round(baseline - xh / 2),
      lineW,
      cssCellWidth: cellW / dpr,
      cssCellHeight: cellH / dpr,
    };
    this.glyphs.clear();
    this.needFull = true;
    return this.metrics;
  }

  setOptions(o: RenderOptions): void {
    const fontChanged = (['fontFamily', 'fontSize', 'lineHeight', 'letterSpacing', 'fontWeight', 'fontWeightBold'] as const).some((k) => o[k] !== this.opts[k]);
    this.opts = o;
    if (fontChanged) this.measure();
    this.glyphs.clear();
    this.needFull = true;
  }

  setPalette(p: Palette): void {
    this.pal = p;
    this.glyphs.clear();
    this.needFull = true;
  }

  /** Updates colours the program changed (OSC 4/10/11/12); redraws only if they differ. */
  setPaletteQuiet(p: Palette): void {
    const a = this.pal;
    const same =
      a.foreground === p.foreground && a.background === p.background && a.cursor === p.cursor && a.palette.length === p.palette.length && a.palette.every((c, i) => c === p.palette[i]);
    this.pal = p;
    if (!same) {
      this.glyphs.clear();
      this.needFull = true;
    }
  }

  invalidate(): void {
    this.needFull = true;
  }

  /** Sizes the canvas backing store to the container (CSS pixels). */
  resizeCanvas(cssWidth: number, cssHeight: number): void {
    const dpr = this.metrics.dpr;
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.canvas.style.width = `${w / dpr}px`;
      this.canvas.style.height = `${h / dpr}px`;
      this.needFull = true;
    }
  }

  /**
   * Draws one frame. `fresh` holds the rows read from the render state this
   * frame (all rows when `full`, otherwise only dirty ones).
   */
  draw(fresh: Row[], full: boolean, cols: number, rowCount: number, cursor: CursorState, state: FrameState): void {
    const ctx = this.ctx;
    const m = this.metrics;
    full = full || this.needFull || cols !== this.cols || rowCount !== this.rowCount || state.images.length > 0 || this.hadImages;
    this.hadImages = state.images.length > 0;
    if (full) this.rows = [];
    for (const r of fresh) this.rows[r.y] = r;
    this.rows.length = rowCount;
    this.cols = cols;
    this.rowCount = rowCount;

    const redraw = new Set<number>();
    if (full) {
      ctx.fillStyle = css(this.pal.background);
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      for (let y = 0; y < rowCount; y++) redraw.add(y);
    } else {
      for (const r of fresh) redraw.add(r.y);
      if (this.lastCursorRow !== undefined) redraw.add(this.lastCursorRow);
      if (cursor.y !== undefined) redraw.add(cursor.y);
      for (const y of this.blinkRows) redraw.add(y);
      for (const y of this.lastHighlightRows) redraw.add(y);
      for (const h of state.highlights) redraw.add(h.y);
      if (this.lastHoverRow !== undefined) redraw.add(this.lastHoverRow);
      if (state.hover) redraw.add(state.hover.y);
    }
    this.lastHighlightRows = new Set(state.highlights.map((h) => h.y));
    this.lastHoverRow = state.hover?.y;
    this.lastCursorRow = cursor.y;

    const byRow = new Map<number, Highlight[]>();
    for (const h of state.highlights) {
      const list = byRow.get(h.y) ?? [];
      list.push(h);
      byRow.set(h.y, list);
    }
    const layers = (l: 0 | 1 | 2) => state.images.filter((i) => i.layer === l).sort((a, b) => a.z - b.z);
    if (full) for (const img of layers(0)) this.drawImage(img);

    const blink = new Set<number>();
    for (const y of [...redraw].sort((a, b) => a - b)) {
      const row = this.rows[y];
      if (!row) continue;
      if (this.drawRowBackground(row, cols, byRow.get(y))) blink.add(y);
    }
    if (full) for (const img of layers(1)) this.drawImage(img);
    for (const y of redraw) {
      const row = this.rows[y];
      if (row) this.drawRowText(row, cols, state, cursor);
    }
    if (full) for (const img of layers(2)) this.drawImage(img);
    this.blinkRows = blink;
    if (cursor.y !== undefined && cursor.x !== undefined && redraw.has(cursor.y)) this.drawCursor(cursor, state);
    // Clear anything right of or below the grid after a full redraw.
    if (full) {
      ctx.fillStyle = css(this.pal.background);
      ctx.fillRect(cols * m.cellW, 0, this.canvas.width - cols * m.cellW, this.canvas.height);
      ctx.fillRect(0, rowCount * m.cellH, this.canvas.width, this.canvas.height - rowCount * m.cellH);
    }
    this.needFull = false;
  }

  private drawImage(i: ImageDraw): void {
    try {
      this.ctx.drawImage(i.source, i.sx, i.sy, i.sw, i.sh, i.dx, i.dy, i.dw, i.dh);
    } catch {
      /* image not decodable yet */
    }
  }

  /** Resolved fg/bg for a cell, honouring inverse, selection and bold-as-bright. */
  private colors(c: Cell): { fg: Rgb; bg: Rgb; bgSet: boolean } {
    const p = this.pal;
    let fg = c.fg ?? p.foreground;
    if (this.opts.drawBoldTextInBrightColors && c.flags & CellFlag.Bold && c.flags & CellFlag.FgBasePalette && c.fgIndex >= 0 && c.fgIndex < 8) {
      fg = p.palette[c.fgIndex + 8];
    }
    let bg = c.bg ?? p.background;
    let bgSet = c.bg !== undefined;
    if (c.flags & CellFlag.Inverse) {
      [fg, bg] = [bg, fg];
      bgSet = true;
    }
    if (c.flags & CellFlag.Selected) {
      bg = p.selectionBackground;
      bgSet = true;
      if (p.selectionForeground !== undefined) fg = p.selectionForeground;
    }
    return { fg, bg, bgSet };
  }

  /** Returns true if the row has blinking text. */
  private drawRowBackground(row: Row, cols: number, highlights: Highlight[] | undefined): boolean {
    const ctx = this.ctx;
    const m = this.metrics;
    const y0 = row.y * m.cellH;
    ctx.fillStyle = css(this.pal.background);
    ctx.fillRect(0, y0, cols * m.cellW, m.cellH);
    let blink = false;
    let runStart = 0;
    let runColor: Rgb | undefined;
    const flush = (end: number) => {
      if (runColor !== undefined && end > runStart) {
        ctx.fillStyle = css(runColor);
        ctx.fillRect(runStart * m.cellW, y0, (end - runStart) * m.cellW, m.cellH);
      }
    };
    for (let x = 0; x < cols; x++) {
      const c = row.cells[x];
      let color: Rgb | undefined;
      if (c) {
        if (c.flags & CellFlag.Blink) blink = true;
        const { bg, bgSet } = this.colors(c);
        if (bgSet) color = bg;
      }
      if (color !== runColor) {
        flush(x);
        runStart = x;
        runColor = color;
      }
    }
    flush(cols);
    for (const h of highlights ?? []) {
      ctx.fillStyle = css(h.current ? this.pal.findMatch : this.pal.findMatchHighlight);
      ctx.fillRect(h.start * m.cellW, y0, (h.end - h.start + 1) * m.cellW, m.cellH);
    }
    return blink;
  }

  private drawRowText(row: Row, cols: number, state: FrameState, cursor: CursorState): void {
    const m = this.metrics;
    const y0 = row.y * m.cellH;
    for (let x = 0; x < cols; x++) {
      const c = row.cells[x];
      if (!c || c.wide === Wide.SpacerTail || c.wide === Wide.SpacerHead) continue;
      const span = c.wide === Wide.Wide ? 2 : 1;
      const { fg, bg } = this.colors(c);
      let color = this.opts.minimumContrastRatio > 1 ? ensureContrast(fg, bg, this.opts.minimumContrastRatio) : fg;
      // A block cursor draws its own text in the accent colour.
      const underBlock = cursor.visible && state.cursorOn && state.focused && cursor.style === 'block' && row.y === cursor.y && x === cursor.x;
      if (underBlock) continue;
      const hidden = c.flags & CellFlag.Invisible || (c.flags & CellFlag.Blink && !state.blinkOn);
      const alpha = c.flags & CellFlag.Faint ? 0.5 : 1;
      if (c.text && !hidden) this.drawText(c, x, y0, span, color, alpha);
      const hovered = state.hover && state.hover.y === row.y && x >= state.hover.start && x <= state.hover.end;
      if (c.underline !== Underline.None || c.flags & (CellFlag.Strikethrough | CellFlag.Overline) || hovered) {
        if (c.underlineColor !== undefined && c.underline !== Underline.None) color = c.underlineColor;
        this.drawDecorations(c, x, y0, span, c.underlineColor ?? color, color, alpha, !!hovered);
      }
    }
  }

  private drawText(c: Cell, x: number, y0: number, span: number, color: Rgb, alpha: number): void {
    const ctx = this.ctx;
    const m = this.metrics;
    const cp = c.text.codePointAt(0)!;
    if (this.opts.customGlyphs && c.text.length <= 2 && isSprite(cp) && String.fromCodePoint(cp) === c.text) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = css(color);
      drawSprite(ctx, cp, { x0: x * m.cellW, y0, x1: (x + span) * m.cellW, y1: y0 + m.cellH, dpr: m.dpr });
      ctx.restore();
      return;
    }
    const bold = !!(c.flags & CellFlag.Bold);
    const italic = !!(c.flags & CellFlag.Italic);
    const key = `${c.text}\u0000${bold ? 1 : 0}${italic ? 1 : 0}${span}\u0000${color}`;
    const g = this.glyphs.get(key, () => {
      const pad = m.cellW;
      const w = m.cellW * span + pad * 2;
      const canvas = makeCanvas(w, m.cellH);
      const gc = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
      gc.font = this.font(bold, italic);
      gc.fillStyle = css(color);
      gc.textBaseline = 'alphabetic';
      const metrics = gc.measureText(c.text);
      // Centre glyphs narrower than their cells (e.g. a narrow fallback glyph in a wide cell).
      const dx = Math.max(0, Math.round((m.cellW * span - metrics.width) / 2));
      gc.fillText(c.text, pad + dx, m.baseline);
      return { canvas, pad };
    });
    ctx.globalAlpha = alpha;
    ctx.drawImage(g.canvas as CanvasImageSource, x * m.cellW - g.pad, y0);
    ctx.globalAlpha = 1;
  }

  private drawDecorations(c: Cell, x: number, y0: number, span: number, ulColor: Rgb, color: Rgb, alpha: number, hovered: boolean): void {
    const ctx = this.ctx;
    const m = this.metrics;
    const x0 = x * m.cellW;
    const w = m.cellW * span;
    const t = m.lineW;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = css(ulColor);
    ctx.strokeStyle = css(ulColor);
    ctx.lineWidth = t;
    const uy = y0 + m.underlineY;
    switch (c.underline) {
      case Underline.Single:
        ctx.fillRect(x0, uy, w, t);
        break;
      case Underline.Double:
        ctx.fillRect(x0, uy - t, w, t);
        ctx.fillRect(x0, Math.min(y0 + m.cellH - t, uy + t), w, t);
        break;
      case Underline.Curly: {
        const amp = Math.max(1, t);
        ctx.beginPath();
        for (let i = 0; i <= w; i++) {
          const yy = uy + Math.sin(((x0 + i) / m.cellW) * Math.PI * 2) * amp;
          if (i === 0) ctx.moveTo(x0 + i, yy);
          else ctx.lineTo(x0 + i, yy);
        }
        ctx.stroke();
        break;
      }
      case Underline.Dotted:
        for (let i = 0; i < w; i += t * 2) ctx.fillRect(x0 + i, uy, t, t);
        break;
      case Underline.Dashed: {
        const dash = Math.max(2, Math.round(m.cellW / 3));
        for (let i = 0; i < w; i += dash * 2) ctx.fillRect(x0 + i, uy, Math.min(dash, w - i), t);
        break;
      }
    }
    if (hovered && c.underline === Underline.None) ctx.fillRect(x0, uy, w, t);
    ctx.fillStyle = css(color);
    if (c.flags & CellFlag.Strikethrough) ctx.fillRect(x0, y0 + m.strikeY, w, t);
    if (c.flags & CellFlag.Overline) ctx.fillRect(x0, y0, w, t);
    ctx.restore();
  }

  private drawCursor(cur: CursorState, state: FrameState): void {
    if (cur.x === undefined || cur.y === undefined) return;
    const ctx = this.ctx;
    const m = this.metrics;
    const row = this.rows[cur.y];
    const cell = row?.cells[cur.x];
    const span = cell?.wide === Wide.Wide ? 2 : 1;
    const x0 = cur.x * m.cellW;
    const y0 = cur.y * m.cellH;
    const w = m.cellW * span;
    const color = this.pal.cursor ?? (cell ? this.colors(cell).fg : this.pal.foreground);
    if (state.preedit) {
      // IME composition: draw the pre-edit text at the cursor, underlined.
      ctx.fillStyle = css(this.pal.background);
      const pw = m.cellW * Math.max(1, [...state.preedit].length);
      ctx.fillRect(x0, y0, pw, m.cellH);
      ctx.font = this.font(false, false);
      ctx.fillStyle = css(this.pal.foreground);
      ctx.fillText(state.preedit, x0, y0 + m.baseline);
      ctx.fillRect(x0, y0 + m.underlineY, pw, m.lineW);
      return;
    }
    if (!cur.visible || !state.cursorOn) return;
    ctx.fillStyle = css(color);
    ctx.strokeStyle = css(color);
    if (cur.passwordInput) {
      this.drawLock(x0, y0, m.cellW, m.cellH);
      return;
    }
    // The shape comes from the terminal (DECSCUSR, or the configured default).
    const style = !state.focused ? 'hollow' : cur.style;
    if (style === 'hollow') {
      const t = Math.max(1, Math.round(m.dpr));
      ctx.lineWidth = t;
      ctx.strokeRect(x0 + t / 2, y0 + t / 2, w - t, m.cellH - t);
    } else if (style === 'bar') {
      ctx.fillRect(x0, y0, Math.max(1, Math.round(this.opts.cursorWidth * m.dpr)), m.cellH);
    } else if (style === 'underline') {
      const t = Math.max(1, Math.round(2 * m.dpr));
      ctx.fillRect(x0, y0 + m.cellH - t, w, t);
    } else {
      ctx.fillRect(x0, y0, w, m.cellH);
      if (cell?.text) {
        const accent = this.pal.cursorAccent;
        this.drawText({ ...cell, flags: cell.flags & ~(CellFlag.Faint | CellFlag.Blink | CellFlag.Invisible) }, cur.x, y0, span, accent, 1);
      }
    }
  }

  /** A small padlock, shown at the cursor while a program reads a password. */
  private drawLock(x0: number, y0: number, w: number, h: number): void {
    const ctx = this.ctx;
    const bodyW = Math.round(w * 0.7);
    const bodyH = Math.round(h * 0.35);
    const bx = x0 + Math.round((w - bodyW) / 2);
    const by = y0 + Math.round(h * 0.5);
    ctx.fillRect(bx, by, bodyW, bodyH);
    ctx.lineWidth = Math.max(1, Math.round(w / 8));
    ctx.beginPath();
    const r = bodyW * 0.32;
    ctx.arc(x0 + w / 2, by, r, Math.PI, 0);
    ctx.stroke();
  }
}
