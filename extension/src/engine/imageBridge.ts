// Sixel and iTerm2 inline images, translated to Kitty graphics.
//
// libghostty-vt draws images only through the Kitty graphics protocol. The
// host engine recognises sixel (DCS ... q) and iTerm2 (OSC 1337 File=)
// sequences, has the sidecar decode them (Rust `image` crate, sixel decoder),
// and injects equivalent Kitty commands at the same point in the stream, so
// both engines draw the same image. This file holds the protocol details;
// hostEngine.ts does the stream handling.

import type { DecodedImage } from '../core/sidecarClient';
import { encodeBase64 } from '../shared/base64';

// ---- recognising the sequences -------------------------------------------------

const ITERM_PREFIXES = ['1337;File=', '1337;MultipartFile=', '1337;FilePart=', '1337;FileEnd'];

/** For the bytes after `ESC ]`: an iTerm2 image command, something else, or too short to tell. */
export function classifyImageOsc(data: Uint8Array): 'image' | 'other' | 'incomplete' {
  let head = '';
  for (let i = 0; i < Math.min(data.length, 24); i++) head += String.fromCharCode(data[i]);
  if (ITERM_PREFIXES.some((p) => head.startsWith(p))) return 'image';
  if (ITERM_PREFIXES.some((p) => p.startsWith(head))) return 'incomplete';
  return 'other';
}

/** For the bytes after `ESC P`: a sixel image (parameters, then `q`), something else, or too short to tell. */
export function classifyDcs(data: Uint8Array): 'sixel' | 'other' | 'incomplete' {
  for (let i = 0; i < Math.min(data.length, 64); i++) {
    const b = data[i];
    if (b === 0x71) return 'sixel'; // q
    if (!((b >= 0x30 && b <= 0x39) || b === 0x3b)) return 'other'; // digits and ';'
  }
  return data.length >= 64 ? 'other' : 'incomplete';
}

// ---- iTerm2 arguments and sizing ----------------------------------------------------

export interface ItermArgs {
  inline: boolean;
  width: string;
  height: string;
  preserveAspectRatio: boolean;
}

/** `key=value;key=value` (the part before `:` in `File=...:`). */
export function parseItermArgs(s: string): ItermArgs {
  const kv = new Map<string, string>();
  for (const part of s.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) kv.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return {
    inline: kv.get('inline') === '1',
    width: kv.get('width') ?? 'auto',
    height: kv.get('height') ?? 'auto',
    preserveAspectRatio: kv.get('preserveAspectRatio') !== '0',
  };
}

export interface Geometry {
  cols: number;
  rows: number;
  /** Device pixels. */
  cellWidth: number;
  cellHeight: number;
}

/** One iTerm2 dimension in pixels: `N` cells, `Npx`, `N%` of the terminal, or undefined for auto. */
function dimension(spec: string, cell: number, total: number): number | undefined {
  const m = /^(\d+(?:\.\d+)?)(px|%)?$/.exec(spec);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  if (!(n > 0)) return undefined;
  if (m[2] === 'px') return n;
  if (m[2] === '%') return (n / 100) * total;
  return n * cell;
}

/**
 * The cells an iTerm2 image covers. Undefined for a side means "let the
 * image's aspect ratio decide" (Kitty computes it); both undefined means the
 * image's own pixel size.
 */
export function itermPlacement(args: ItermArgs, imgW: number, imgH: number, g: Geometry): { cols?: number; rows?: number } {
  const termW = g.cols * g.cellWidth;
  const termH = g.rows * g.cellHeight;
  const w = dimension(args.width, g.cellWidth, termW);
  const h = dimension(args.height, g.cellHeight, termH);
  const cells = (px: number, cell: number) => Math.max(1, Math.ceil(px / cell - 0.01));
  if (w === undefined && h === undefined) {
    // Native size, but never wider than the terminal (as iTerm2 does).
    return imgW > termW ? { cols: g.cols } : {};
  }
  if (!args.preserveAspectRatio) {
    return { cols: cells(w ?? imgW, g.cellWidth), rows: cells(h ?? imgH, g.cellHeight) };
  }
  if (w !== undefined && h !== undefined) {
    // Fit inside the box, keeping the aspect ratio.
    const scale = Math.min(w / imgW, h / imgH);
    return { cols: cells(imgW * scale, g.cellWidth) };
  }
  return w !== undefined ? { cols: cells(w, g.cellWidth) } : { rows: cells(h!, g.cellHeight) };
}

// ---- Kitty commands -----------------------------------------------------------------

const APC = '\x1b_G';
const ST = '\x1b\\';
/** Kitty's maximum payload per escape code. */
const CHUNK = 4096;

function b64(bytes: Uint8Array): string {
  return encodeBase64(bytes);
}

/** One transmission, split into chunks: the keys go on the first chunk only. */
function chunked(keys: string, payload: Uint8Array): string {
  const data = b64(payload);
  let out = '';
  for (let off = 0; off < data.length || off === 0; off += CHUNK) {
    const piece = data.slice(off, off + CHUNK);
    const more = off + CHUNK < data.length ? 1 : 0;
    out += off === 0 ? `${APC}${keys},m=${more};${piece}${ST}` : `${APC}m=${more};${piece}${ST}`;
    if (!data.length) break;
  }
  return out;
}

export interface KittyPlacement {
  cols?: number;
  rows?: number;
  /** Move the cursor past the image (Kitty's default), or leave it where it is. */
  moveCursor: boolean;
}

/**
 * Kitty graphics commands that transmit and place a decoded image (RGBA,
 * zlib-compressed, as the sidecar returns it). Animated images get their
 * frames and start looping.
 */
export function kittyCommands(img: DecodedImage, id: number, place: KittyPlacement): string {
  const [first, ...rest] = img.frames;
  const size = `f=32,o=z,s=${img.width},v=${img.height}`;
  let keys = `a=T,${size},i=${id},q=2,C=${place.moveCursor ? 0 : 1}`;
  if (place.cols) keys += `,c=${place.cols}`;
  if (place.rows) keys += `,r=${place.rows}`;
  let out = chunked(keys, first.zrgba);
  if (rest.length) {
    for (const f of rest) out += chunked(`a=f,i=${id},${size},z=${Math.max(1, f.delayMs)},q=2`, f.zrgba);
    // Set the first frame's delay, then loop forever.
    out += `${APC}a=a,i=${id},r=1,z=${Math.max(1, first.delayMs)},q=2${ST}`;
    out += `${APC}a=a,i=${id},s=3,v=1,q=2${ST}`;
  }
  return out;
}
