// Render state: a copy of what one frame needs, read row by row.
//
// Rows are read in bulk: GHOSTTY_RENDER_STATE_ROW_DATA_CELLS_RAW gives the
// packed cells of a row in one call, and only cells that have a style, a
// grapheme cluster or a background-only content tag need a further call. This
// keeps the number of calls across the WebAssembly boundary small.

import { E, NO_VALUE, OK, P, Rgb, S, Vt } from './core';
import type { Terminal } from './terminal';

const RD = E.GhosttyRenderStateData;
const RowD = E.GhosttyRenderStateRowData;
const CellD = E.GhosttyRenderStateRowCellsData;
const CT = E.GhosttyCellContentTag;

export type Dirty = 'clean' | 'partial' | 'full';

export const enum Underline {
  None = 0,
  Single = 1,
  Double = 2,
  Curly = 3,
  Dotted = 4,
  Dashed = 5,
}

export const enum Wide {
  Narrow = 0,
  Wide = 1,
  SpacerTail = 2,
  SpacerHead = 3,
}

/** Cell attribute bits (`Cell.flags`). */
export const enum CellFlag {
  Bold = 1 << 0,
  Italic = 1 << 1,
  Faint = 1 << 2,
  Blink = 1 << 3,
  Inverse = 1 << 4,
  Invisible = 1 << 5,
  Strikethrough = 1 << 6,
  Overline = 1 << 7,
  Hyperlink = 1 << 8,
  Selected = 1 << 9,
  /** Foreground came from palette 0-7 (for bold-as-bright). */
  FgBasePalette = 1 << 10,
}

/** A styled colour: undefined means "default". */
export interface Cell {
  /** The grapheme cluster, or '' for an empty cell. */
  text: string;
  wide: Wide;
  flags: number;
  underline: Underline;
  fg: Rgb | undefined;
  bg: Rgb | undefined;
  underlineColor: Rgb | undefined;
  /** Palette index of the foreground when it came from the palette, else -1. */
  fgIndex: number;
}

export interface Row {
  y: number;
  dirty: boolean;
  /** Stable identity across updates (two u64 halves as a string key). */
  id: string;
  cells: Cell[];
  /** Inclusive selected column range on this row, if any. */
  selection: [number, number] | undefined;
}

export interface CursorState {
  visible: boolean;
  blinking: boolean;
  passwordInput: boolean;
  style: 'bar' | 'block' | 'underline' | 'hollow';
  /** Position in the viewport, when the cursor is in it. */
  x: number | undefined;
  y: number | undefined;
  wideTail: boolean;
}

export interface Colors {
  foreground: Rgb;
  background: Rgb;
  cursor: Rgb | undefined;
  palette: Rgb[];
}

const CURSOR_STYLE: CursorState['style'][] = ['bar', 'block', 'underline', 'hollow'];

function bits(name: keyof typeof P.GhosttyCell.bits): [number, number] {
  return P.GhosttyCell.bits[name] as unknown as [number, number];
}
const B_TAG = bits('content_tag');
const B_CP = bits('content.CODEPOINT.codepoint');
const B_STYLE = bits('style_id');
const B_WIDE = bits('wide');
const B_LINK = bits('hyperlink');
const B_PAL = bits('content.BG_COLOR_PALETTE.index');
const B_R = bits('content.BG_COLOR_RGB.r');
const B_G = bits('content.BG_COLOR_RGB.g');
const B_B = bits('content.BG_COLOR_RGB.b');

/** Extracts a bitfield from a cell split into two u32 halves. */
function field(lo: number, hi: number, [lsb, width]: [number, number]): number {
  let v: number;
  if (lsb >= 32) v = hi >>> (lsb - 32);
  else if (lsb + width <= 32) v = lo >>> lsb;
  else v = (lo >>> lsb) | (hi << (32 - lsb));
  return width >= 32 ? v >>> 0 : v & ((1 << width) - 1);
}

const SF = P.GhosttyStyleFlags.bits as unknown as Record<string, [number, number]>;

function readStyleColor(vt: Vt, p: number, palette: Rgb[]): { rgb: Rgb | undefined; index: number } {
  const u8 = vt.u8;
  const tag = u8[p + S.GhosttyStyleColor.f.tag];
  const v = p + S.GhosttyStyleColor.f.value;
  if (tag === E.GhosttyStyleColorTag.PALETTE) return { rgb: palette[u8[v]], index: u8[v] };
  if (tag === E.GhosttyStyleColorTag.RGB) return { rgb: (u8[v] << 16) | (u8[v + 1] << 8) | u8[v + 2], index: -1 };
  return { rgb: undefined, index: -1 };
}

const decoder = new TextDecoder();

interface ParsedStyle {
  flags: number;
  underline: Underline;
  fg: Rgb | undefined;
  fgIndex: number;
  bg: Rgb | undefined;
  underlineColor: Rgb | undefined;
}

function parseStyle(vt: Vt, style: number, palette: Rgb[]): ParsedStyle {
  const raw = vt.dv.getUint16(style + S.GhosttyStyle.f.flags, true);
  const bit = (k: string) => (raw >>> SF[k][0]) & ((1 << SF[k][1]) - 1);
  let flags = 0;
  if (bit('bold')) flags |= CellFlag.Bold;
  if (bit('italic')) flags |= CellFlag.Italic;
  if (bit('faint')) flags |= CellFlag.Faint;
  if (bit('blink')) flags |= CellFlag.Blink;
  if (bit('inverse')) flags |= CellFlag.Inverse;
  if (bit('invisible')) flags |= CellFlag.Invisible;
  if (bit('strikethrough')) flags |= CellFlag.Strikethrough;
  if (bit('overline')) flags |= CellFlag.Overline;
  const fg = readStyleColor(vt, style + S.GhosttyStyle.f.fg_color, palette);
  if (fg.index >= 0 && fg.index < 8) flags |= CellFlag.FgBasePalette;
  return {
    flags,
    underline: bit('underline'),
    fg: fg.rgb,
    fgIndex: fg.index,
    bg: readStyleColor(vt, style + S.GhosttyStyle.f.bg_color, palette).rgb,
    underlineColor: readStyleColor(vt, style + S.GhosttyStyle.f.underline_color, palette).rgb,
  };
}

export class RenderState {
  readonly handle: number;
  private readonly rowIter: number;
  private readonly rowCells: number;
  private disposed = false;
  /** Scratch for per-row reads, allocated once. */
  private readonly buf: number;
  private static readonly BUF = 4096;

  constructor(readonly vt: Vt) {
    this.handle = vt.construct('render_state_new', (slot) => vt.ex.ghostty_render_state_new(0, slot));
    this.rowIter = vt.construct('row_iterator_new', (slot) => vt.ex.ghostty_render_state_row_iterator_new(0, slot));
    this.rowCells = vt.construct('row_cells_new', (slot) => vt.ex.ghostty_render_state_row_cells_new(0, slot));
    this.buf = vt.alloc(RenderState.BUF);
    vt.leaks?.register(this, 'render state', this);
  }

  /** Captures the terminal as it is now. */
  update(term: Terminal): void {
    this.vt.check(this.vt.ex.ghostty_render_state_update(this.handle, term.handle), 'render_state_update');
  }

  private getU(data: number, size: number, read: (p: number) => number | boolean): number | boolean | undefined {
    return this.vt.withScratch((take) => {
      const p = take(Math.max(size, 8));
      const r = this.vt.ex.ghostty_render_state_get(this.handle, data, p);
      if (r === NO_VALUE) return undefined;
      this.vt.check(r, `render_state_get ${data}`);
      return read(p);
    });
  }

  get dirty(): Dirty {
    const d = this.getU(RD.DIRTY, 4, (p) => this.vt.dv.getInt32(p, true)) as number;
    return d === E.GhosttyRenderStateDirty.FULL ? 'full' : d === E.GhosttyRenderStateDirty.PARTIAL ? 'partial' : 'clean';
  }

  get cols(): number {
    return this.getU(RD.COLS, 2, (p) => this.vt.dv.getUint16(p, true)) as number;
  }
  get rows(): number {
    return this.getU(RD.ROWS, 2, (p) => this.vt.dv.getUint16(p, true)) as number;
  }

  /** Marks the frame fully drawn (clears global and per-row dirty state). */
  clean(): void {
    this.vt.check(this.vt.ex.ghostty_render_state_clean(this.handle), 'render_state_clean');
  }

  /** Forces the next frame to be a full redraw. */
  markFull(): void {
    this.vt.withScratch((take) => {
      const p = take(4);
      this.vt.dv.setInt32(p, E.GhosttyRenderStateDirty.FULL, true);
      this.vt.check(this.vt.ex.ghostty_render_state_set(this.handle, E.GhosttyRenderStateOption.DIRTY, p), 'render_state_set dirty');
    });
  }

  colors(): Colors {
    const vt = this.vt;
    return vt.withScratch((take) => {
      const s = S.GhosttyRenderStateColors;
      const p = vt.sized(take(s.size), s.size);
      vt.check(vt.ex.ghostty_render_state_get(this.handle, RD.COLORS, p), 'render colors');
      const palette: Rgb[] = [];
      for (let i = 0; i < 256; i++) palette.push(vt.rgb(p + s.f.palette + i * 3));
      return {
        foreground: vt.rgb(p + s.f.foreground),
        background: vt.rgb(p + s.f.background),
        cursor: vt.u8[p + s.f.cursor_has_value] ? vt.rgb(p + s.f.cursor) : undefined,
        palette,
      };
    });
  }

  cursor(): CursorState {
    const vt = this.vt;
    return vt.withScratch((take) => {
      const s = S.GhosttyRenderStateCursor;
      const p = vt.sized(take(s.size), s.size);
      vt.check(vt.ex.ghostty_render_state_get(this.handle, RD.CURSOR, p), 'render cursor');
      const u8 = vt.u8;
      const dv = vt.dv;
      const inView = u8[p + s.f.viewport_has_value] !== 0;
      return {
        visible: u8[p + s.f.visible] !== 0,
        blinking: u8[p + s.f.blinking] !== 0,
        passwordInput: u8[p + s.f.password_input] !== 0,
        style: CURSOR_STYLE[dv.getInt32(p + s.f.visual_style, true)] ?? 'block',
        x: inView ? dv.getUint16(p + s.f.viewport_x, true) : undefined,
        y: inView ? dv.getUint16(p + s.f.viewport_y, true) : undefined,
        wideTail: u8[p + s.f.wide_tail] !== 0,
      };
    });
  }

  /**
   * Reads every row (or only dirty ones). Row data is copied out, so it stays
   * valid after the next update.
   */
  readRows(palette: Rgb[], onlyDirty: boolean): Row[] {
    const vt = this.vt;
    const ex = vt.ex;
    const out: Row[] = [];
    vt.withScratch((take) => {
      const iterSlot = take(4);
      vt.dv.setUint32(iterSlot, this.rowIter, true);
      vt.check(ex.ghostty_render_state_get(this.handle, RD.ROW_ITERATOR, iterSlot), 'row iterator');
      const cellsSlot = take(4);
      const view = take(S.GhosttyCellsView.size);
      const sel = take(S.GhosttyRenderStateRowSelection.size);
      const tmp = take(8);
      const idp = take(16);
      const style = take(S.GhosttyStyle.size);
      const gbuf = take(S.GhosttyBuffer.size);
      let y = 0;
      while (ex.ghostty_render_state_row_iterator_next(this.rowIter)) {
        const rowY = y++;
        vt.check(ex.ghostty_render_state_row_get(this.rowIter, RowD.DIRTY, tmp), 'row dirty');
        const dirty = vt.u8[tmp] !== 0;
        if (onlyDirty && !dirty) continue;
        ex.ghostty_render_state_row_get(this.rowIter, RowD.ID, idp);
        const dv = vt.dv;
        const id = `${dv.getUint32(idp, true)}:${dv.getUint32(idp + 4, true)}:${dv.getUint32(idp + 8, true)}:${dv.getUint32(idp + 12, true)}`;
        vt.sized(sel, S.GhosttyRenderStateRowSelection.size);
        const sr = ex.ghostty_render_state_row_get(this.rowIter, RowD.SELECTION, sel);
        const selection: [number, number] | undefined =
          sr === OK ? [vt.dv.getUint16(sel + S.GhosttyRenderStateRowSelection.f.start_x, true), vt.dv.getUint16(sel + S.GhosttyRenderStateRowSelection.f.end_x, true)] : undefined;
        vt.check(ex.ghostty_render_state_row_get(this.rowIter, RowD.CELLS_RAW, view), 'row cells raw');
        const cellsPtr = vt.dv.getUint32(view + S.GhosttyCellsView.f.ptr, true);
        const n = vt.dv.getUint32(view + S.GhosttyCellsView.f.len, true);
        // Copy the packed cells out before any further call can move memory.
        const raw = new Uint32Array(vt.u8.slice(cellsPtr, cellsPtr + n * 8).buffer);
        vt.dv.setUint32(cellsSlot, this.rowCells, true);
        vt.check(ex.ghostty_render_state_row_get(this.rowIter, RowD.CELLS, cellsSlot), 'row cells');
        const cells: Cell[] = new Array(n);
        // Style ids are page-local; within one row they always mean the same style.
        const styles = new Map<number, ParsedStyle>();
        for (let x = 0; x < n; x++) {
          const lo = raw[x * 2];
          const hi = raw[x * 2 + 1];
          const tag = field(lo, hi, B_TAG);
          const styleId = field(lo, hi, B_STYLE);
          const cell: Cell = { text: '', wide: field(lo, hi, B_WIDE), flags: field(lo, hi, B_LINK) ? CellFlag.Hyperlink : 0, underline: Underline.None, fg: undefined, bg: undefined, underlineColor: undefined, fgIndex: -1 };
          if (tag === CT.CODEPOINT) {
            const cp = field(lo, hi, B_CP);
            if (cp) cell.text = String.fromCodePoint(cp);
          } else if (tag === CT.BG_COLOR_PALETTE) {
            cell.bg = palette[field(lo, hi, B_PAL)];
          } else if (tag === CT.BG_COLOR_RGB) {
            cell.bg = (field(lo, hi, B_R) << 16) | (field(lo, hi, B_G) << 8) | field(lo, hi, B_B);
          }
          const needText = tag === CT.CODEPOINT_GRAPHEME;
          if (needText || (styleId !== 0 && !styles.has(styleId))) {
            ex.ghostty_render_state_row_cells_select(this.rowCells, x);
            if (needText) {
              const g = S.GhosttyBuffer.f;
              const d2 = vt.dv;
              d2.setUint32(gbuf + g.ptr, this.buf, true);
              d2.setUint32(gbuf + g.cap, RenderState.BUF, true);
              if (ex.ghostty_render_state_row_cells_get(this.rowCells, CellD.GRAPHEMES_UTF8, gbuf) === OK) {
                const len = vt.dv.getUint32(gbuf + g.len, true);
                cell.text = decoder.decode(vt.u8.subarray(this.buf, this.buf + len));
              }
            }
            if (styleId !== 0 && !styles.has(styleId) && ex.ghostty_render_state_row_cells_get(this.rowCells, CellD.STYLE, style) === OK) {
              styles.set(styleId, parseStyle(vt, style, palette));
            }
          }
          const st = styleId !== 0 ? styles.get(styleId) : undefined;
          if (st) {
            cell.flags |= st.flags;
            cell.underline = st.underline;
            cell.fg = st.fg;
            cell.fgIndex = st.fgIndex;
            if (st.bg !== undefined) cell.bg = st.bg;
            cell.underlineColor = st.underlineColor;
          }
          if (selection && x >= selection[0] && x <= selection[1]) cell.flags |= CellFlag.Selected;
          cells[x] = cell;
        }
        out.push({ y: rowY, dirty, id, cells, selection });
      }
    });
    return out;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.vt.leaks?.unregister(this);
    this.vt.ex.ghostty_render_state_row_cells_free(this.rowCells);
    this.vt.ex.ghostty_render_state_row_iterator_free(this.rowIter);
    this.vt.ex.ghostty_render_state_free(this.handle);
    this.vt.free(this.buf, RenderState.BUF);
  }
}

/** Text of a row, with wide-character spacers dropped and trailing blanks trimmed. */
export function rowText(row: Row): string {
  let s = '';
  for (const c of row.cells) {
    if (c.wide === Wide.SpacerTail || c.wide === Wide.SpacerHead) continue;
    s += c.text || ' ';
  }
  return s.replace(/\s+$/, '');
}
