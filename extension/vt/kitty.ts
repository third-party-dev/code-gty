// Kitty graphics: the PNG decoder the library needs, image placements from
// the render state, and pixels from the terminal's image storage. Only
// available in builds with Kitty graphics (the wasm32-wasi module).

import { E, OK, S, Vt } from './core';
import { decodePng } from './png';
import type { RenderState } from './render';
import type { Terminal } from './terminal';

const ID = E.GhosttyRenderStateImageData;
const KD = E.GhosttyKittyGraphicsImageData;
const installed = new WeakSet<Vt>();

/**
 * Installs the synchronous PNG decoder (GHOSTTY_SYS_OPT_DECODE_PNG). It is
 * per module instance, so call it once per Vt before images arrive.
 */
export function installPngDecoder(vt: Vt, log?: (m: string) => void): void {
  if (installed.has(vt) || !vt.features.kittyGraphics) return;
  installed.add(vt);
  const fn = vt.callback('decode_png', { params: ['i32', 'i32', 'i32', 'i32', 'i32'], result: 'i32' }, (_ud, allocator, data, len, out) => {
    try {
      const img = decodePng(vt.copyOut(data >>> 0, len >>> 0));
      const p = vt.ex.ghostty_alloc(allocator, img.rgba.length) >>> 0;
      if (!p) return 0;
      vt.u8.set(img.rgba, p);
      const f = S.GhosttySysImage.f;
      const dv = vt.dv;
      dv.setUint32((out >>> 0) + f.width, img.width, true);
      dv.setUint32((out >>> 0) + f.height, img.height, true);
      dv.setUint32((out >>> 0) + f.data, p, true);
      dv.setUint32((out >>> 0) + f.data_len, img.rgba.length, true);
      return 1;
    } catch (e) {
      log?.(`PNG decode failed: ${(e as Error).message}`);
      return 0;
    }
  });
  vt.check(vt.ex.ghostty_sys_set(E.GhosttySysOption.DECODE_PNG, fn), 'sys_set decode_png');
}

export interface Placement {
  imageId: number;
  generation: bigint;
  layer: 0 | 1 | 2;
  z: number;
  col: number;
  row: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export interface ImagePixels {
  width: number;
  height: number;
  /** 8-bit RGBA, converted from the stored format. */
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

export class KittyImages {
  private readonly iter: number;
  private disposed = false;

  constructor(readonly vt: Vt) {
    this.iter = vt.construct('image_iterator_new', (slot) => vt.ex.ghostty_render_state_image_iterator_new(0, slot));
  }

  /** Placements of the last render state update, in iteration order. */
  placements(rs: RenderState): Placement[] {
    const vt = this.vt;
    const ex = vt.ex;
    const out: Placement[] = [];
    vt.withScratch((take) => {
      const slot = take(4);
      vt.dv.setUint32(slot, this.iter, true);
      if (ex.ghostty_render_state_get(rs.handle, E.GhosttyRenderStateData.IMAGE_ITERATOR, slot) !== OK) return;
      const v = take(8);
      const u32 = (k: number) => (ex.ghostty_render_state_image_get(this.iter, k, v) === OK ? vt.dv.getUint32(v, true) : 0);
      const i32 = (k: number) => (ex.ghostty_render_state_image_get(this.iter, k, v) === OK ? vt.dv.getInt32(v, true) : 0);
      while (ex.ghostty_render_state_image_iterator_next(this.iter)) {
        if (i32(ID.PROTOCOL) !== E.GhosttyImageProtocol.KITTY) continue;
        ex.ghostty_render_state_image_get(this.iter, ID.IMAGE_GENERATION, v);
        const generation = vt.dv.getBigUint64(v, true);
        out.push({
          imageId: u32(ID.IMAGE_ID),
          generation,
          layer: Math.max(0, Math.min(2, i32(ID.LAYER))) as 0 | 1 | 2,
          z: i32(ID.Z),
          col: i32(ID.VIEWPORT_COL),
          row: i32(ID.VIEWPORT_ROW),
          offsetX: u32(ID.CELL_OFFSET_X),
          offsetY: u32(ID.CELL_OFFSET_Y),
          width: u32(ID.PIXEL_WIDTH),
          height: u32(ID.PIXEL_HEIGHT),
          sx: u32(ID.SOURCE_X),
          sy: u32(ID.SOURCE_Y),
          sw: u32(ID.SOURCE_WIDTH),
          sh: u32(ID.SOURCE_HEIGHT),
        });
      }
    });
    return out;
  }

  private graphics(term: Terminal): number {
    const vt = this.vt;
    return vt.withScratch((take) => {
      const p = take(4);
      return vt.ex.ghostty_terminal_get(term.handle, E.GhosttyTerminalData.KITTY_GRAPHICS, p) === OK ? vt.dv.getUint32(p, true) : 0;
    });
  }

  /** Reads and converts an image's pixels (call while the terminal is unchanged since the update). */
  pixels(term: Terminal, imageId: number): ImagePixels | undefined {
    const vt = this.vt;
    const ex = vt.ex;
    const g = this.graphics(term);
    if (!g) return undefined;
    const img = ex.ghostty_kitty_graphics_image(g, imageId) >>> 0;
    if (!img) return undefined;
    return vt.withScratch((take) => {
      const v = take(8);
      const u32 = (k: number) => (ex.ghostty_kitty_graphics_image_get(img, k, v) === OK ? vt.dv.getUint32(v, true) : 0);
      const width = u32(KD.WIDTH);
      const height = u32(KD.HEIGHT);
      const format = u32(KD.FORMAT);
      if (ex.ghostty_kitty_graphics_image_get(img, KD.PIXELS, v) !== OK) return undefined;
      const ptr = vt.dv.getUint32(v, true);
      const len = vt.dv.getUint32(v + 4, true);
      if (!width || !height || !len) return undefined;
      const src = vt.u8.subarray(ptr, ptr + len);
      const n = width * height;
      const rgba = new Uint8ClampedArray(n * 4);
      const F = E.GhosttyKittyImageFormat;
      if (format === F.RGBA) rgba.set(src.subarray(0, n * 4));
      else
        for (let i = 0; i < n; i++) {
          const o = i * 4;
          if (format === F.RGB) {
            rgba[o] = src[i * 3];
            rgba[o + 1] = src[i * 3 + 1];
            rgba[o + 2] = src[i * 3 + 2];
            rgba[o + 3] = 255;
          } else if (format === F.GRAY_ALPHA) {
            rgba[o] = rgba[o + 1] = rgba[o + 2] = src[i * 2];
            rgba[o + 3] = src[i * 2 + 1];
          } else {
            rgba[o] = rgba[o + 1] = rgba[o + 2] = src[i];
            rgba[o + 3] = 255;
          }
        }
      return { width, height, rgba };
    });
  }

  /** Advances animations; returns ms until the next frame is due, if any. */
  tick(term: Terminal, nowMs: number): number | undefined {
    const vt = this.vt;
    const g = this.graphics(term);
    if (!g) return undefined;
    return vt.withScratch((take) => {
      const next = take(8);
      const f = vt.ex.ghostty_kitty_graphics_animation_tick as unknown as (g: number, now: bigint, out: number) => number;
      if (f(g, BigInt(Math.floor(nowMs)), next) !== OK) return undefined;
      const at = Number(vt.dv.getBigUint64(next, true));
      return at > 0 ? Math.max(0, at - nowMs) : undefined;
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.vt.ex.ghostty_render_state_image_iterator_free(this.iter);
  }
}
