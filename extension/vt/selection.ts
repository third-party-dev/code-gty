// Grid references, selections, selection gestures and the formatter.
//
// A GhosttySelection holds untracked grid references: it is a snapshot that
// is only valid until the terminal changes. `Sel` keeps its raw bytes; pass it
// back to the library right away, or install it as the terminal's selection
// (`setSelection`), which the terminal then tracks itself.

import { E, NO_VALUE, OK, S, Vt, utf8Decoder } from './core';
import type { Terminal } from './terminal';

export type PointSpace = 'active' | 'viewport' | 'screen' | 'history';
const TAG: Record<PointSpace, number> = {
  active: E.GhosttyPointTag.ACTIVE,
  viewport: E.GhosttyPointTag.VIEWPORT,
  screen: E.GhosttyPointTag.SCREEN,
  history: E.GhosttyPointTag.HISTORY,
};

/** Raw GhosttySelection bytes (a snapshot). */
export type Sel = Uint8Array;
/** Raw GhosttyGridRef bytes (a snapshot). */
export type Ref = Uint8Array;

export interface Coord {
  x: number;
  y: number;
}

function writePoint(vt: Vt, p: number, space: PointSpace, c: Coord): void {
  const dv = vt.dv;
  dv.setInt32(p + S.GhosttyPoint.f.tag, TAG[space], true);
  const v = p + S.GhosttyPoint.f.value + S.GhosttyPointValue.f.coordinate;
  dv.setUint16(v + S.GhosttyPointCoordinate.f.x, c.x, true);
  dv.setUint32(v + S.GhosttyPointCoordinate.f.y, c.y, true);
}

/** Resolves a point to a grid reference, or undefined if out of bounds. */
export function gridRef(term: Terminal, space: PointSpace, c: Coord): Ref | undefined {
  const vt = term.vt;
  return vt.withScratch((take) => {
    const pt = take(S.GhosttyPoint.size);
    writePoint(vt, pt, space, c);
    const out = take(S.GhosttyGridRef.size);
    const r = vt.ex.ghostty_terminal_grid_ref(term.handle, pt, out);
    return r === OK ? vt.copyOut(out, S.GhosttyGridRef.size) : undefined;
  });
}

/** Converts a reference back to coordinates, or undefined if not representable there. */
export function refPoint(term: Terminal, ref: Ref, space: PointSpace): Coord | undefined {
  const vt = term.vt;
  return vt.withScratch((take) => {
    const rp = take(ref.length);
    vt.u8.set(ref, rp);
    const out = take(S.GhosttyPointCoordinate.size);
    const r = vt.ex.ghostty_terminal_point_from_grid_ref(term.handle, rp, TAG[space], out);
    if (r !== OK) return undefined;
    return { x: vt.dv.getUint16(out + S.GhosttyPointCoordinate.f.x, true), y: vt.dv.getUint32(out + S.GhosttyPointCoordinate.f.y, true) };
  });
}

/** The OSC 8 URI of the cell at a viewport position, if it has one. */
export function hyperlinkAt(term: Terminal, c: Coord): string | undefined {
  const ref = gridRef(term, 'viewport', c);
  if (!ref) return undefined;
  const vt = term.vt;
  return vt.withScratch((take) => {
    const rp = take(ref.length);
    vt.u8.set(ref, rp);
    const w = take(4);
    let r = vt.ex.ghostty_grid_ref_hyperlink_uri(rp, 0, 0, w);
    if (r === NO_VALUE) return undefined;
    const need = vt.dv.getUint32(w, true);
    if (!need) return undefined;
    const buf = take(need, 1);
    r = vt.ex.ghostty_grid_ref_hyperlink_uri(rp, buf, need, w);
    return r === OK ? utf8Decoder.decode(vt.u8.subarray(buf, buf + vt.dv.getUint32(w, true))) : undefined;
  });
}

export interface SelEnds {
  start: Coord;
  end: Coord;
  rectangle: boolean;
}

/** Selection ends in the given space (undefined if either end is outside it). */
export function selEnds(term: Terminal, sel: Sel, space: PointSpace): SelEnds | undefined {
  const f = S.GhosttySelection.f;
  const start = refPoint(term, sel.subarray(f.start, f.start + S.GhosttyGridRef.size), space);
  const end = refPoint(term, sel.subarray(f.end, f.end + S.GhosttyGridRef.size), space);
  if (!start || !end) return undefined;
  return { start, end, rectangle: sel[f.rectangle] !== 0 };
}

/** Builds a selection from two points. */
export function selectRange(term: Terminal, space: PointSpace, a: Coord, b: Coord, rectangle = false): Sel | undefined {
  const ra = gridRef(term, space, a);
  const rb = gridRef(term, space, b);
  if (!ra || !rb) return undefined;
  const sel = new Uint8Array(S.GhosttySelection.size);
  sel.set(ra, S.GhosttySelection.f.start);
  sel.set(rb, S.GhosttySelection.f.end);
  sel[S.GhosttySelection.f.rectangle] = rectangle ? 1 : 0;
  return sel;
}

function selCall(term: Terminal, fill: (take: (n: number, a?: number) => number, out: number) => number): Sel | undefined {
  const vt = term.vt;
  return vt.withScratch((take) => {
    const out = take(S.GhosttySelection.size);
    const r = fill(take, out);
    if (r === NO_VALUE) return undefined;
    vt.check(r, 'select');
    return vt.copyOut(out, S.GhosttySelection.size);
  });
}

function codepoints(vt: Vt, take: (n: number, a?: number) => number, chars: string | undefined): [number, number] {
  if (!chars) return [0, 0];
  const cps = [...chars].map((c) => c.codePointAt(0)!);
  const p = take(cps.length * 4, 4);
  cps.forEach((cp, i) => vt.dv.setUint32(p + i * 4, cp, true));
  return [p, cps.length];
}

export function selectWord(term: Terminal, space: PointSpace, c: Coord, separators?: string): Sel | undefined {
  const ref = gridRef(term, space, c);
  if (!ref) return undefined;
  const vt = term.vt;
  return selCall(term, (take, out) => {
    const s = S.GhosttyTerminalSelectWordOptions;
    const o = vt.sized(take(s.size), s.size);
    vt.u8.set(ref, o + s.f.ref);
    const [p, n] = codepoints(vt, take, separators);
    vt.dv.setUint32(o + s.f.boundary_codepoints, p, true);
    vt.dv.setUint32(o + s.f.boundary_codepoints_len, n, true);
    return vt.ex.ghostty_terminal_select_word(term.handle, o, out);
  });
}

export function selectLine(term: Terminal, space: PointSpace, c: Coord, semanticPromptBoundary = true): Sel | undefined {
  const ref = gridRef(term, space, c);
  if (!ref) return undefined;
  const vt = term.vt;
  return selCall(term, (take, out) => {
    const s = S.GhosttyTerminalSelectLineOptions;
    const o = vt.sized(take(s.size), s.size);
    vt.u8.set(ref, o + s.f.ref);
    vt.u8[o + s.f.semantic_prompt_boundary] = semanticPromptBoundary ? 1 : 0;
    return vt.ex.ghostty_terminal_select_line(term.handle, o, out);
  });
}

export function selectAll(term: Terminal): Sel | undefined {
  return selCall(term, (_take, out) => term.vt.ex.ghostty_terminal_select_all(term.handle, out));
}

/** The output of the command at a point (needs OSC 133 marks). */
export function selectOutput(term: Terminal, space: PointSpace, c: Coord): Sel | undefined {
  const ref = gridRef(term, space, c);
  if (!ref) return undefined;
  const vt = term.vt;
  return selCall(term, (take, out) => {
    const rp = take(ref.length);
    vt.u8.set(ref, rp);
    return vt.ex.ghostty_terminal_select_output(term.handle, rp, out);
  });
}

/** Installs (or clears) the terminal's own selection, which it then tracks. */
export function setSelection(term: Terminal, sel: Sel | undefined): void {
  const vt = term.vt;
  vt.withScratch((take) => {
    let p = 0;
    if (sel) {
      p = take(sel.length);
      vt.u8.set(sel, p);
    }
    vt.check(vt.ex.ghostty_terminal_set(term.handle, E.GhosttyTerminalOption.SELECTION, p), 'set selection');
  });
}

export function getSelection(term: Terminal): Sel | undefined {
  const vt = term.vt;
  return vt.withScratch((take) => {
    const out = take(S.GhosttySelection.size);
    const r = vt.ex.ghostty_terminal_get(term.handle, E.GhosttyTerminalData.SELECTION, out);
    return r === OK ? vt.copyOut(out, S.GhosttySelection.size) : undefined;
  });
}

export type SelectionAdjust = keyof typeof E.GhosttySelectionAdjust;

/** Moves the selection's logical end, as keyboard selection does. */
export function adjustSelection(term: Terminal, sel: Sel, how: SelectionAdjust): Sel {
  const vt = term.vt;
  return vt.withScratch((take) => {
    const p = take(sel.length);
    vt.u8.set(sel, p);
    vt.check(vt.ex.ghostty_terminal_selection_adjust(term.handle, p, E.GhosttySelectionAdjust[how]), 'selection_adjust');
    return vt.copyOut(p, sel.length);
  });
}

export function selectionContains(term: Terminal, sel: Sel, space: PointSpace, c: Coord): boolean {
  const vt = term.vt;
  return vt.withScratch((take) => {
    const p = take(sel.length);
    vt.u8.set(sel, p);
    const pt = take(S.GhosttyPoint.size);
    writePoint(vt, pt, space, c);
    const out = take(1);
    return vt.ex.ghostty_terminal_selection_contains(term.handle, p, pt, out) === OK && vt.u8[out] !== 0;
  });
}

// ---- formatter -------------------------------------------------------------

export interface FormatOptions {
  format?: 'plain' | 'vt' | 'html';
  /** Only this selection; the whole screen (with scrollback) when omitted. */
  selection?: Sel;
  trim?: boolean;
  /** Join soft-wrapped lines. */
  unwrap?: boolean;
}

/** Formats terminal content as plain text, VT sequences or HTML. */
export function format(term: Terminal, opts: FormatOptions = {}): string {
  const vt = term.vt;
  const f = vt.construct('formatter_new', (slot) => vt.ex.ghostty_formatter_terminal_new(0, slot, term.handle));
  try {
    return vt.withScratch((take) => {
      const FO = E.GhosttyFormatterOption;
      const v = take(4);
      vt.dv.setInt32(v, E.GhosttyFormatterFormat[(opts.format ?? 'plain').toUpperCase() as 'PLAIN'], true);
      vt.check(vt.ex.ghostty_formatter_set(f, FO.EMIT, v), 'formatter emit');
      const b = take(1);
      vt.u8[b] = opts.trim === false ? 0 : 1;
      vt.check(vt.ex.ghostty_formatter_set(f, FO.TRIM, b), 'formatter trim');
      const u = take(1);
      vt.u8[u] = opts.unwrap ? 1 : 0;
      vt.check(vt.ex.ghostty_formatter_set(f, FO.UNWRAP, u), 'formatter unwrap');
      if (opts.selection) {
        const sp = take(opts.selection.length);
        vt.u8.set(opts.selection, sp);
        vt.check(vt.ex.ghostty_formatter_set(f, FO.SELECTION, sp), 'formatter selection');
      }
      const outPtr = take(4);
      const outLen = take(4);
      vt.check(vt.ex.ghostty_formatter_format_alloc(f, 0, outPtr, outLen), 'formatter_format');
      const p = vt.dv.getUint32(outPtr, true);
      const n = vt.dv.getUint32(outLen, true);
      const s = vt.text(p, n);
      vt.freeLib(p, n);
      return s;
    });
  } finally {
    vt.ex.ghostty_formatter_free(f);
  }
}

// ---- gestures ----------------------------------------------------------------

export type GestureBehavior = 'cell' | 'word' | 'line' | 'output';

export interface GestureGeometry {
  columns: number;
  cellWidth: number;
  paddingLeft: number;
  screenHeight: number;
}

const GT = E.GhosttySelectionGestureEventType;
const GO = E.GhosttySelectionGestureEventOption;

/**
 * Turns pointer events into selections: click counts, word and line
 * granularity, dragging and autoscroll, with Ghostty's rules.
 */
export class SelectionGesture {
  private readonly gesture: number;
  private readonly events: Record<'press' | 'release' | 'drag' | 'tick', number>;
  private disposed = false;

  constructor(
    readonly vt: Vt,
    private readonly term: Terminal,
  ) {
    this.gesture = vt.construct('selection_gesture_new', (slot) => vt.ex.ghostty_selection_gesture_new(0, slot));
    const ev = (type: number) => vt.construct('gesture_event_new', (slot) => vt.ex.ghostty_selection_gesture_event_new(0, slot, type));
    this.events = { press: ev(GT.PRESS), release: ev(GT.RELEASE), drag: ev(GT.DRAG), tick: ev(GT.AUTOSCROLL_TICK) };
  }

  private setOpt(ev: number, opt: number, write: (p: number) => void, size: number): void {
    const vt = this.vt;
    vt.withScratch((take) => {
      const p = take(size);
      write(p);
      vt.check(vt.ex.ghostty_selection_gesture_event_set(ev, opt, p), `gesture option ${opt}`);
    });
  }

  private setCommon(ev: number, o: { ref?: Ref; x?: number; y?: number; rectangle?: boolean; geometry?: GestureGeometry; separators?: string }): void {
    const vt = this.vt;
    if (o.ref) this.setOpt(ev, GO.REF, (p) => vt.u8.set(o.ref!, p), S.GhosttyGridRef.size);
    if (o.x !== undefined && o.y !== undefined) {
      this.setOpt(
        ev,
        GO.POSITION,
        (p) => {
          vt.dv.setFloat64(p + S.GhosttySurfacePosition.f.x, o.x!, true);
          vt.dv.setFloat64(p + S.GhosttySurfacePosition.f.y, o.y!, true);
        },
        S.GhosttySurfacePosition.size,
      );
    }
    if (o.rectangle !== undefined) this.setOpt(ev, GO.RECTANGLE, (p) => (vt.u8[p] = o.rectangle ? 1 : 0), 1);
    if (o.geometry) {
      const g = o.geometry;
      const f = S.GhosttySelectionGestureGeometry.f;
      this.setOpt(
        ev,
        GO.GEOMETRY,
        (p) => {
          const dv = vt.dv;
          dv.setUint32(p + f.columns, g.columns, true);
          dv.setUint32(p + f.cell_width, Math.max(1, Math.round(g.cellWidth)), true);
          dv.setUint32(p + f.padding_left, Math.max(0, Math.round(g.paddingLeft)), true);
          dv.setUint32(p + f.screen_height, Math.max(1, Math.round(g.screenHeight)), true);
        },
        S.GhosttySelectionGestureGeometry.size,
      );
    }
    if (o.separators !== undefined) {
      vt.withScratch((take) => {
        const [cp, n] = codepoints(vt, take, o.separators);
        const s = take(8, 4);
        vt.dv.setUint32(s, cp, true);
        vt.dv.setUint32(s + 4, n, true);
        vt.check(vt.ex.ghostty_selection_gesture_event_set(ev, GO.WORD_BOUNDARY_CODEPOINTS, s), 'gesture separators');
      });
    }
  }

  private run(ev: number): Sel | undefined {
    const vt = this.vt;
    return vt.withScratch((take) => {
      const out = take(S.GhosttySelection.size);
      const r = vt.ex.ghostty_selection_gesture_event(this.gesture, this.term.handle, ev, out);
      if (r === NO_VALUE) return undefined;
      vt.check(r, 'selection_gesture_event');
      return vt.copyOut(out, S.GhosttySelection.size);
    });
  }

  /**
   * A button press. Repeat clicks count when they come within
   * `repeatIntervalMs` and `repeatDistance` pixels of the previous one; the
   * library's defaults for both are zero, which disables double clicks.
   */
  press(o: {
    ref: Ref;
    x: number;
    y: number;
    timeMs: number;
    separators?: string;
    behaviors?: [GestureBehavior, GestureBehavior, GestureBehavior];
    repeatIntervalMs?: number;
    repeatDistance?: number;
  }): Sel | undefined {
    const vt = this.vt;
    const ev = this.events.press;
    this.setCommon(ev, o);
    this.setOpt(ev, GO.TIME_NS, (p) => vt.dv.setBigUint64(p, BigInt(Math.round(o.timeMs * 1e6)), true), 8);
    this.setOpt(ev, GO.REPEAT_INTERVAL_NS, (p) => vt.dv.setBigUint64(p, BigInt(Math.round((o.repeatIntervalMs ?? 500) * 1e6)), true), 8);
    this.setOpt(ev, GO.REPEAT_DISTANCE, (p) => vt.dv.setFloat64(p, o.repeatDistance ?? 6, true), 8);
    if (o.behaviors) {
      const B = E.GhosttySelectionGestureBehavior;
      const f = S.GhosttySelectionGestureBehaviors.f;
      const val = (b: GestureBehavior) => B[b.toUpperCase() as 'CELL'];
      this.setOpt(
        ev,
        GO.BEHAVIORS,
        (p) => {
          vt.dv.setInt32(p + f.single_click, val(o.behaviors![0]), true);
          vt.dv.setInt32(p + f.double_click, val(o.behaviors![1]), true);
          vt.dv.setInt32(p + f.triple_click, val(o.behaviors![2]), true);
        },
        S.GhosttySelectionGestureBehaviors.size,
      );
    }
    return this.run(ev);
  }

  drag(o: { ref: Ref; x: number; y: number; geometry: GestureGeometry; rectangle?: boolean; separators?: string }): Sel | undefined {
    this.setCommon(this.events.drag, o);
    return this.run(this.events.drag);
  }

  release(ref?: Ref): void {
    if (ref) this.setCommon(this.events.release, { ref });
    this.run(this.events.release);
  }

  /** Scrolls one row in the autoscroll direction and continues the drag. */
  autoscrollTick(o: { viewport: Coord; x: number; y: number; geometry: GestureGeometry; rectangle?: boolean }): Sel | undefined {
    const vt = this.vt;
    const ev = this.events.tick;
    this.setCommon(ev, o);
    this.setOpt(
      ev,
      GO.VIEWPORT,
      (p) => {
        vt.dv.setUint16(p + S.GhosttyPointCoordinate.f.x, o.viewport.x, true);
        vt.dv.setUint32(p + S.GhosttyPointCoordinate.f.y, o.viewport.y, true);
      },
      S.GhosttyPointCoordinate.size,
    );
    return this.run(ev);
  }

  /** 'up' or 'down' while the pointer is dragged past an edge. */
  get autoscroll(): 'none' | 'up' | 'down' {
    const vt = this.vt;
    const v = vt.withScratch((take) => {
      const p = take(4);
      const r = vt.ex.ghostty_selection_gesture_get(this.gesture, this.term.handle, E.GhosttySelectionGestureData.AUTOSCROLL, p);
      return r === OK ? vt.dv.getInt32(p, true) : 0;
    });
    return v === 1 ? 'up' : v === 2 ? 'down' : 'none';
  }

  get dragged(): boolean {
    const vt = this.vt;
    return vt.withScratch((take) => {
      const p = take(1);
      return vt.ex.ghostty_selection_gesture_get(this.gesture, this.term.handle, E.GhosttySelectionGestureData.DRAGGED, p) === OK && vt.u8[p] !== 0;
    });
  }

  get clickCount(): number {
    const vt = this.vt;
    return vt.withScratch((take) => {
      const p = take(1);
      return vt.ex.ghostty_selection_gesture_get(this.gesture, this.term.handle, E.GhosttySelectionGestureData.CLICK_COUNT, p) === OK ? vt.u8[p] : 0;
    });
  }

  reset(): void {
    this.vt.ex.ghostty_selection_gesture_reset(this.gesture, this.term.handle);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const ev of Object.values(this.events)) this.vt.ex.ghostty_selection_gesture_event_free(ev);
    this.vt.ex.ghostty_selection_gesture_free(this.gesture, this.term.isDisposed ? 0 : this.term.handle);
  }
}
