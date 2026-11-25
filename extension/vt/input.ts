// Input encoders: keys (legacy and Kitty keyboard protocol), mouse (X10,
// UTF-8, SGR, URxvt, SGR-Pixels) and focus. They follow the terminal's modes
// through set_from_terminal, so call `sync` after output and before encoding.

import { E, OK, OUT_OF_SPACE, S, Vt, utf8Encoder } from './core';
import type { Terminal } from './terminal';

export const Mods = {
  SHIFT: 1 << 0,
  CTRL: 1 << 1,
  ALT: 1 << 2,
  SUPER: 1 << 3,
  CAPS_LOCK: 1 << 4,
  NUM_LOCK: 1 << 5,
  SHIFT_RIGHT: 1 << 6,
  CTRL_RIGHT: 1 << 7,
  ALT_RIGHT: 1 << 8,
  SUPER_RIGHT: 1 << 9,
} as const;

/** W3C `KeyboardEvent.code` -> GhosttyKey. */
export const KEY_CODES: ReadonlyMap<string, number> = (() => {
  const m = new Map<string, number>();
  for (const [name, value] of Object.entries(E.GhosttyKey)) {
    if (name === 'UNIDENTIFIED') continue;
    const code = /^[A-Z]$/.test(name)
      ? `Key${name}`
      : name
          .split('_')
          .map((p) => p.charAt(0) + p.slice(1).toLowerCase())
          .join('');
    m.set(code, value);
  }
  // Older names some engines still report.
  m.set('OSLeft', E.GhosttyKey.META_LEFT);
  m.set('OSRight', E.GhosttyKey.META_RIGHT);
  return m;
})();

export interface KeyInput {
  action: 'press' | 'repeat' | 'release';
  /** GhosttyKey; 0 when the physical key is unknown. */
  key: number;
  mods: number;
  /** Modifiers consumed to produce `text` (e.g. Shift for "A"). */
  consumedMods?: number;
  /** Text the key produces in the current layout, without Ctrl/Meta applied. */
  text?: string;
  /** The codepoint of the key without Shift, in the current layout. */
  unshifted?: number;
  composing?: boolean;
}

const KA = E.GhosttyKeyAction;

export class KeyEncoder {
  private readonly encoder: number;
  private readonly event: number;
  private textPtr = 0;
  private textCap = 0;
  private out = 0;
  private outCap = 256;
  private disposed = false;
  macOptionAsAlt: 'false' | 'true' | 'left' | 'right' = 'false';

  constructor(readonly vt: Vt) {
    this.encoder = vt.construct('key_encoder_new', (slot) => vt.ex.ghostty_key_encoder_new(0, slot));
    this.event = vt.construct('key_event_new', (slot) => vt.ex.ghostty_key_event_new(0, slot));
    this.out = vt.alloc(this.outCap);
  }

  /** Copies the terminal's keyboard modes (cursor keys, keypad, Kitty flags...). */
  sync(term: Terminal, kittyKeyboard = true): void {
    const vt = this.vt;
    vt.check(vt.ex.ghostty_key_encoder_set_from_terminal(this.encoder, term.handle), 'key_encoder_set_from_terminal');
    vt.withScratch((take) => {
      const p = take(4);
      vt.dv.setInt32(p, E.GhosttyOptionAsAlt[this.macOptionAsAlt.toUpperCase() as 'FALSE'], true);
      vt.check(vt.ex.ghostty_key_encoder_set(this.encoder, E.GhosttyKeyEncoderOption.MACOS_OPTION_AS_ALT, p), 'option as alt');
      if (!kittyKeyboard) {
        vt.u8[p] = 0;
        vt.check(vt.ex.ghostty_key_encoder_set(this.encoder, E.GhosttyKeyEncoderOption.KITTY_FLAGS, p), 'kitty flags');
      }
    });
  }

  encode(k: KeyInput): Uint8Array {
    const vt = this.vt;
    const ex = vt.ex;
    const ev = this.event;
    ex.ghostty_key_event_set_action(ev, k.action === 'release' ? KA.RELEASE : k.action === 'repeat' ? KA.REPEAT : KA.PRESS);
    ex.ghostty_key_event_set_key(ev, k.key);
    ex.ghostty_key_event_set_mods(ev, k.mods);
    ex.ghostty_key_event_set_consumed_mods(ev, k.consumedMods ?? 0);
    ex.ghostty_key_event_set_composing(ev, k.composing ? 1 : 0);
    ex.ghostty_key_event_set_unshifted_codepoint(ev, k.unshifted ?? 0);
    // The event borrows the text, so it lives in our own buffer.
    const text = k.text && !/^[\x00-\x1f\x7f]/.test(k.text) ? utf8Encoder.encode(k.text) : new Uint8Array(0);
    if (text.length > this.textCap) {
      vt.free(this.textPtr, this.textCap);
      this.textCap = Math.max(64, text.length);
      this.textPtr = vt.alloc(this.textCap);
    }
    if (text.length) vt.u8.set(text, this.textPtr);
    vt.withScratch((take) => {
      const s = take(8, 4);
      vt.dv.setUint32(s, text.length ? this.textPtr : 0, true);
      vt.dv.setUint32(s + 4, text.length, true);
      vt.check(ex.ghostty_key_event_set_utf8(ev, s), 'key_event_set_utf8');
    });
    return this.run((buf, cap, written) => ex.ghostty_key_encoder_encode(this.encoder, ev, buf, cap, written));
  }

  private run(call: (buf: number, cap: number, written: number) => number): Uint8Array {
    const vt = this.vt;
    for (;;) {
      const r = vt.withScratch((take) => {
        const w = take(4);
        const res = call(this.out, this.outCap, w);
        return { res, n: vt.dv.getUint32(w, true) };
      });
      if (r.res === OK) return vt.copyOut(this.out, r.n);
      if (r.res !== OUT_OF_SPACE) vt.check(r.res, 'key_encoder_encode');
      vt.free(this.out, this.outCap);
      this.outCap = Math.max(r.n, this.outCap * 2);
      this.out = vt.alloc(this.outCap);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.vt.ex.ghostty_key_event_free(this.event);
    this.vt.ex.ghostty_key_encoder_free(this.encoder);
    this.vt.free(this.textPtr, this.textCap);
    this.vt.free(this.out, this.outCap);
  }
}

export interface MouseGeometry {
  screenWidth: number;
  screenHeight: number;
  cellWidth: number;
  cellHeight: number;
  paddingTop?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingBottom?: number;
}

export interface MouseInput {
  action: 'press' | 'release' | 'motion';
  /** 1 left, 2 right, 3 middle, 4/5 wheel up/down, 6/7 wheel left/right; 0 none. */
  button: number;
  mods: number;
  /** Surface pixels, relative to the top-left of the terminal area. */
  x: number;
  y: number;
}

const MA = E.GhosttyMouseAction;

export class MouseEncoder {
  private readonly encoder: number;
  private readonly event: number;
  private readonly out: number;
  private disposed = false;

  constructor(readonly vt: Vt) {
    this.encoder = vt.construct('mouse_encoder_new', (slot) => vt.ex.ghostty_mouse_encoder_new(0, slot));
    this.event = vt.construct('mouse_event_new', (slot) => vt.ex.ghostty_mouse_event_new(0, slot));
    this.out = vt.alloc(128);
    vt.withScratch((take) => {
      const p = take(1);
      vt.u8[p] = 1;
      vt.check(vt.ex.ghostty_mouse_encoder_set(this.encoder, E.GhosttyMouseEncoderOption.TRACK_LAST_CELL, p), 'track last cell');
    });
  }

  sync(term: Terminal): void {
    this.vt.check(this.vt.ex.ghostty_mouse_encoder_set_from_terminal(this.encoder, term.handle), 'mouse_encoder_set_from_terminal');
  }

  setGeometry(g: MouseGeometry): void {
    const vt = this.vt;
    vt.withScratch((take) => {
      const s = S.GhosttyMouseEncoderSize;
      const p = vt.sized(take(s.size), s.size);
      const dv = vt.dv;
      const u = (k: keyof typeof s.f, v: number | undefined) => dv.setUint32(p + s.f[k], Math.max(0, Math.round(v ?? 0)), true);
      u('screen_width', g.screenWidth);
      u('screen_height', g.screenHeight);
      u('cell_width', Math.max(1, g.cellWidth));
      u('cell_height', Math.max(1, g.cellHeight));
      u('padding_top', g.paddingTop);
      u('padding_bottom', g.paddingBottom);
      u('padding_left', g.paddingLeft);
      u('padding_right', g.paddingRight);
      vt.check(vt.ex.ghostty_mouse_encoder_set(this.encoder, E.GhosttyMouseEncoderOption.SIZE, p), 'mouse size');
    });
  }

  setAnyButtonPressed(pressed: boolean): void {
    const vt = this.vt;
    vt.withScratch((take) => {
      const p = take(1);
      vt.u8[p] = pressed ? 1 : 0;
      vt.check(vt.ex.ghostty_mouse_encoder_set(this.encoder, E.GhosttyMouseEncoderOption.ANY_BUTTON_PRESSED, p), 'any button pressed');
    });
  }

  reset(): void {
    this.vt.ex.ghostty_mouse_encoder_reset(this.encoder);
  }

  encode(m: MouseInput): Uint8Array {
    const vt = this.vt;
    const ex = vt.ex;
    const ev = this.event;
    ex.ghostty_mouse_event_set_action(ev, m.action === 'press' ? MA.PRESS : m.action === 'release' ? MA.RELEASE : MA.MOTION);
    if (m.button) ex.ghostty_mouse_event_set_button(ev, m.button);
    else ex.ghostty_mouse_event_clear_button(ev);
    ex.ghostty_mouse_event_set_mods(ev, m.mods);
    return vt.withScratch((take) => {
      const pos = take(S.GhosttyMousePosition.size, 4);
      vt.dv.setFloat32(pos + S.GhosttyMousePosition.f.x, m.x, true);
      vt.dv.setFloat32(pos + S.GhosttyMousePosition.f.y, m.y, true);
      ex.ghostty_mouse_event_set_position(ev, pos);
      const w = take(4);
      const r = ex.ghostty_mouse_encoder_encode(this.encoder, ev, this.out, 128, w);
      if (r !== OK) return new Uint8Array(0);
      return vt.copyOut(this.out, vt.dv.getUint32(w, true));
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.vt.ex.ghostty_mouse_event_free(this.event);
    this.vt.ex.ghostty_mouse_encoder_free(this.encoder);
    this.vt.free(this.out, 128);
  }
}

/** CSI I / CSI O. Check the terminal's focus mode (1004) before sending. */
export function encodeFocus(vt: Vt, gained: boolean): Uint8Array {
  return vt.withScratch((take) => {
    const buf = take(16, 1);
    const w = take(4);
    vt.check(vt.ex.ghostty_focus_encode(gained ? E.GhosttyFocusEvent.GAINED : E.GhosttyFocusEvent.LOST, buf, 16, w), 'focus_encode');
    return vt.copyOut(buf, vt.dv.getUint32(w, true));
  });
}

/** Whether pasting `text` raw could inject commands (ignores terminal modes). */
export function pasteIsSafe(vt: Vt, text: string): boolean {
  const bytes = utf8Encoder.encode(text);
  const p = vt.copyIn(bytes);
  try {
    return vt.ex.ghostty_paste_is_safe(p, bytes.length) !== 0;
  } finally {
    vt.free(p, bytes.length);
  }
}
