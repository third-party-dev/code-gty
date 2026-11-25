// A small synchronous PNG decoder for Kitty graphics. libghostty-vt asks for
// PNG decoding through a synchronous callback (GHOSTTY_SYS_OPT_DECODE_PNG),
// and neither Node's zlib nor the browser's DecompressionStream can be used
// synchronously in both places, so this carries its own inflate. Host and
// webview use the same code, so both engines accept exactly the same images.
//
// Supports every colour type and bit depth, palettes with tRNS transparency,
// and Adam7 interlacing. Returns 8-bit RGBA.

export interface DecodedImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** Refuse images larger than this many pixels (Kitty's own limit is similar). */
const MAX_PIXELS = 10000 * 10000;

// ---- inflate (RFC 1951) -------------------------------------------------------

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface Huffman {
  counts: Uint16Array;
  symbols: Uint16Array;
}

function huffman(lengths: Uint8Array): Huffman {
  const counts = new Uint16Array(16);
  for (const l of lengths) counts[l]++;
  counts[0] = 0;
  const offs = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1];
  const symbols = new Uint16Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) if (lengths[s]) symbols[offs[lengths[s]]++] = s;
  return { counts, symbols };
}

class BitReader {
  pos = 0;
  bit = 0;
  bits = 0;
  constructor(readonly data: Uint8Array) {}
  need(n: number): number {
    while (this.bits < n) {
      if (this.pos >= this.data.length) throw new Error('png: truncated deflate stream');
      this.bit |= this.data[this.pos++] << this.bits;
      this.bits += 8;
    }
    const v = this.bit & ((1 << n) - 1);
    this.bit >>>= n;
    this.bits -= n;
    return v;
  }
  decode(h: Huffman): number {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= this.need(1);
      const count = h.counts[len];
      if (code - first < count) return h.symbols[index + code - first];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('png: bad Huffman code');
  }
  align(): void {
    this.bit = 0;
    this.bits = 0;
  }
}

const FIXED_LIT = (() => {
  const l = new Uint8Array(288);
  l.fill(8, 0, 144);
  l.fill(9, 144, 256);
  l.fill(7, 256, 280);
  l.fill(8, 280, 288);
  return huffman(l);
})();
const FIXED_DIST = huffman(new Uint8Array(30).fill(5));

/** Inflates a zlib stream (2-byte header, deflate data, Adler-32). */
export function inflate(zlib: Uint8Array, maxOut: number): Uint8Array {
  if (zlib.length < 2 || (zlib[0] & 0x0f) !== 8 || ((zlib[0] << 8) | zlib[1]) % 31 !== 0) throw new Error('png: bad zlib header');
  const r = new BitReader(zlib.subarray(2));
  let out = new Uint8Array(Math.min(maxOut, Math.max(1024, zlib.length * 4)));
  let n = 0;
  const ensure = (k: number) => {
    if (n + k <= out.length) return;
    if (n + k > maxOut) throw new Error('png: image data too large');
    const next = new Uint8Array(Math.min(maxOut, Math.max(out.length * 2, n + k)));
    next.set(out.subarray(0, n));
    out = next;
  };
  for (;;) {
    const last = r.need(1);
    const type = r.need(2);
    if (type === 0) {
      r.align();
      const d = r.data;
      if (r.pos + 4 > d.length) throw new Error('png: truncated stored block');
      const len = d[r.pos] | (d[r.pos + 1] << 8);
      r.pos += 4;
      ensure(len);
      out.set(d.subarray(r.pos, r.pos + len), n);
      n += len;
      r.pos += len;
    } else if (type === 1 || type === 2) {
      let lit = FIXED_LIT;
      let dist = FIXED_DIST;
      if (type === 2) {
        const hlit = r.need(5) + 257;
        const hdist = r.need(5) + 1;
        const hclen = r.need(4) + 4;
        const cl = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = r.need(3);
        const clh = huffman(cl);
        const lens = new Uint8Array(hlit + hdist);
        for (let i = 0; i < hlit + hdist; ) {
          const sym = r.decode(clh);
          if (sym < 16) lens[i++] = sym;
          else {
            const [rep, val] = sym === 16 ? [3 + r.need(2), i ? lens[i - 1] : 0] : sym === 17 ? [3 + r.need(3), 0] : [11 + r.need(7), 0];
            for (let k = 0; k < rep && i < lens.length; k++) lens[i++] = val;
          }
        }
        lit = huffman(lens.subarray(0, hlit));
        dist = huffman(lens.subarray(hlit));
      }
      for (;;) {
        const sym = r.decode(lit);
        if (sym < 256) {
          ensure(1);
          out[n++] = sym;
        } else if (sym === 256) {
          break;
        } else {
          const li = sym - 257;
          if (li >= 29) throw new Error('png: bad length code');
          const len = LEN_BASE[li] + r.need(LEN_EXTRA[li]);
          const di = r.decode(dist);
          if (di >= 30) throw new Error('png: bad distance code');
          const d = DIST_BASE[di] + r.need(DIST_EXTRA[di]);
          if (d > n) throw new Error('png: distance too far back');
          ensure(len);
          for (let k = 0; k < len; k++, n++) out[n] = out[n - d];
        }
      }
    } else {
      throw new Error('png: bad block type');
    }
    if (last) break;
  }
  return out.subarray(0, n);
}

// ---- PNG -----------------------------------------------------------------------

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Undoes the per-row filters of one (sub)image, in place. */
function unfilter(data: Uint8Array, offset: number, width: number, height: number, bpp: number, stride: number): number {
  let prev = -1;
  let p = offset;
  for (let y = 0; y < height; y++) {
    const ft = data[p++];
    const row = p;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? data[row + x - bpp] : 0;
      const b = prev >= 0 ? data[prev + x] : 0;
      const c = prev >= 0 && x >= bpp ? data[prev + x - bpp] : 0;
      const v = data[row + x];
      switch (ft) {
        case 0: break;
        case 1: data[row + x] = (v + a) & 255; break;
        case 2: data[row + x] = (v + b) & 255; break;
        case 3: data[row + x] = (v + ((a + b) >> 1)) & 255; break;
        case 4: data[row + x] = (v + paeth(a, b, c)) & 255; break;
        default: throw new Error(`png: bad filter ${ft}`);
      }
    }
    prev = row;
    p += stride;
  }
  void width;
  return p;
}

export function decodePng(bytes: Uint8Array): DecodedImage {
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 8 || SIG.some((b, i) => bytes[i] !== b)) throw new Error('png: not a PNG');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let ctype = 0;
  let interlace = 0;
  let palette: Uint8Array | undefined;
  let trns: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  while (pos + 8 <= bytes.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const body = bytes.subarray(pos + 8, pos + 8 + len);
    if (body.length !== len) throw new Error('png: truncated chunk');
    pos += 12 + len;
    if (type === 'IHDR') {
      const h = new DataView(body.buffer, body.byteOffset, body.byteLength);
      width = h.getUint32(0);
      height = h.getUint32(4);
      depth = body[8];
      ctype = body[9];
      interlace = body[12];
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
  }
  if (!width || !height || width * height > MAX_PIXELS) throw new Error('png: bad size');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype as 0];
  if (!channels || ![1, 2, 4, 8, 16].includes(depth)) throw new Error('png: unsupported format');
  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const zlib = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of idat) {
    zlib.set(c, off);
    off += c.length;
  }
  const strideOf = (w: number) => Math.ceil((w * bitsPerPixel) / 8);
  const passes: [number, number, number, number][] = interlace
    ? [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2],
      ]
    : [[0, 0, 1, 1]];
  let expected = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((width - x0) / dx);
    const ph = Math.ceil((height - y0) / dy);
    if (pw > 0 && ph > 0) expected += ph * (1 + strideOf(pw));
  }
  const raw = inflate(zlib, expected);
  if (raw.length < expected) throw new Error('png: image data too short');
  const rgba = new Uint8Array(width * height * 4);
  const sample = (row: number, x: number, ch: number): number => {
    // One channel of pixel x, scaled to 8 bits.
    if (depth === 8) return raw[row + x * channels + ch];
    if (depth === 16) return raw[row + (x * channels + ch) * 2];
    const bit = (x * channels + ch) * depth;
    const v = (raw[row + (bit >> 3)] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
    return ctype === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
  };
  const raw16 = (row: number, x: number, ch: number) => (raw[row + (x * channels + ch) * 2] << 8) | raw[row + (x * channels + ch) * 2 + 1];
  let p = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((width - x0) / dx);
    const ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const stride = strideOf(pw);
    const start = p;
    p = unfilter(raw, p, pw, ph, bpp, stride);
    for (let y = 0; y < ph; y++) {
      const row = start + y * (stride + 1) + 1;
      for (let x = 0; x < pw; x++) {
        const o = ((y0 + y * dy) * width + (x0 + x * dx)) * 4;
        let r: number, g: number, b: number;
        let a = 255;
        if (ctype === 3) {
          const i = sample(row, x, 0);
          if (!palette || i * 3 + 2 >= palette.length) throw new Error('png: bad palette index');
          r = palette[i * 3];
          g = palette[i * 3 + 1];
          b = palette[i * 3 + 2];
          if (trns && i < trns.length) a = trns[i];
        } else if (ctype === 0 || ctype === 4) {
          r = g = b = sample(row, x, 0);
          if (ctype === 4) a = sample(row, x, 1);
          else if (trns && trns.length >= 2) {
            const key = (trns[0] << 8) | trns[1];
            const v = depth === 16 ? raw16(row, x, 0) : depth === 8 ? raw[row + x] : (raw[row + ((x * depth) >> 3)] >> (8 - depth - ((x * depth) & 7))) & ((1 << depth) - 1);
            if (v === key) a = 0;
          }
        } else {
          r = sample(row, x, 0);
          g = sample(row, x, 1);
          b = sample(row, x, 2);
          if (ctype === 6) a = sample(row, x, 3);
          else if (trns && trns.length >= 6) {
            const k = [0, 2, 4].map((i) => (trns![i] << 8) | trns![i + 1]);
            const v = depth === 16 ? [0, 1, 2].map((c) => raw16(row, x, c)) : [r, g, b];
            if (v[0] === k[0] && v[1] === k[1] && v[2] === k[2]) a = 0;
          }
        }
        rgba[o] = r;
        rgba[o + 1] = g;
        rgba[o + 2] = b;
        rgba[o + 3] = a;
      }
    }
  }
  return { width, height, rgba };
}
