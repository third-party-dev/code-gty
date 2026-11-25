// gty-vt core: loads libghostty-vt's WebAssembly module and gives the other
// binding files safe access to it. No DOM and no VS Code imports, so the same
// code runs in the extension host (Node), in unit tests and in the webview.
//
// Rules every binding follows:
// - Any exported call can grow linear memory, so typed views are fetched
//   through `u8`/`dv` (which re-create them when the buffer changes) right
//   before each access, never kept across a call.
// - Out-parameters live in a small scratch stack (`scratch`). A binding marks
//   it, takes what it needs, and releases it before returning. Callbacks use
//   the same stack above whatever the interrupted call is using, so nesting is
//   safe as long as releases are LIFO, which `withScratch` guarantees.
// - Every GhosttyResult is checked. GHOSTTY_UNSUPPORTED becomes a
//   VtUnsupportedError, so a missing optional feature is not a crash.

import { LAYOUT } from './layout.generated';

export const L = LAYOUT;
export const E = LAYOUT.enums;
export const S = LAYOUT.structs;
export const P = LAYOUT.packed;

/** The libghostty-vt version these bindings were generated for. */
export const BINDINGS_VERSION: string = LAYOUT.version;

type Fn = (...args: number[]) => number;
export type VtExports = Record<string, Fn> & {
  memory: WebAssembly.Memory;
  __indirect_function_table: WebAssembly.Table;
};

const RESULT_NAMES: Record<number, string> = Object.fromEntries(Object.entries(E.GhosttyResult).map(([k, v]) => [v, k]));

export class VtError extends Error {
  constructor(
    readonly code: number,
    readonly op: string,
  ) {
    super(`${op}: ${RESULT_NAMES[code] ?? code}`);
    this.name = 'VtError';
  }
}

export class VtUnsupportedError extends VtError {
  constructor(op: string) {
    super(E.GhosttyResult.UNSUPPORTED, op);
    this.name = 'VtUnsupportedError';
  }
}

export const OK = E.GhosttyResult.SUCCESS;
export const NO_VALUE = E.GhosttyResult.NO_VALUE;
export const OUT_OF_SPACE = E.GhosttyResult.OUT_OF_SPACE;

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface Features {
  simd: boolean;
  kittyGraphics: boolean;
  snapshot: boolean;
  formatter: boolean;
  selection: boolean;
  search: boolean;
  renderState: boolean;
  inputEncode: boolean;
  optimize: string;
}

export interface LoadOptions {
  /** Called for library log lines (WASI builds write them to stderr). */
  log?: (line: string) => void;
  /** Development builds: report handles that were garbage-collected without dispose(). */
  trackLeaks?: boolean;
}

/** A callback signature: WebAssembly value types of the params and the result. */
export type ValType = 'i32' | 'i64' | 'f32' | 'f64';
export interface Signature {
  params: ValType[];
  result?: ValType;
}

const VALTYPE: Record<ValType, number> = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c };

function leb(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}

function section(id: number, body: number[]): number[] {
  return [id, ...leb(body.length), ...body];
}

function name(s: string): number[] {
  const b = [...enc.encode(s)];
  return [...leb(b.length), ...b];
}

/**
 * A minimal module that imports `e.f` with the given signature and exports a
 * real WebAssembly function `f` that calls it. Such a function can go into the
 * libghostty-vt function table in every engine, without the non-standard
 * `WebAssembly.Function` constructor.
 */
export function thunkModuleBytes(sig: Signature): Uint8Array {
  const params = sig.params.map((p) => VALTYPE[p]);
  const results = sig.result ? [VALTYPE[sig.result]] : [];
  const type = [0x60, ...leb(params.length), ...params, ...leb(results.length), ...results];
  const body = [0x00]; // no locals
  for (let i = 0; i < params.length; i++) body.push(0x20, ...leb(i)); // local.get i
  body.push(0x10, 0x00, 0x0b); // call 0; end
  const bytes = [
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [0x01, ...type]),
    ...section(2, [0x01, ...name('e'), ...name('f'), 0x00, 0x00]),
    ...section(3, [0x01, 0x00]),
    ...section(7, [0x01, ...name('f'), 0x00, 0x01]),
    ...section(10, [0x01, ...leb(body.length), ...body]),
  ];
  return new Uint8Array(bytes);
}

/** Scratch stack for out-parameters and small inputs. */
export class Scratch {
  private top = 0;
  constructor(
    private readonly base: number,
    private readonly size: number,
  ) {}
  mark(): number {
    return this.top;
  }
  release(mark: number): void {
    this.top = mark;
  }
  /** Zeroed, aligned bytes; valid until the enclosing mark is released. */
  take(vt: Vt, len: number, align = 8): number {
    const start = (this.top + align - 1) & ~(align - 1);
    if (start + len > this.size) throw new Error(`gty-vt scratch exhausted (${start + len} > ${this.size})`);
    this.top = start + len;
    const p = this.base + start;
    vt.u8.fill(0, p, p + len);
    return p;
  }
}

/**
 * One instance of the module. Terminals, encoders and render states created
 * from it share its memory, so a host and a webview each have their own.
 */
export class Vt {
  readonly ex: VtExports;
  readonly memory: WebAssembly.Memory;
  readonly table: WebAssembly.Table;
  readonly scratch: Scratch;
  readonly version: string;
  readonly features: Features;
  readonly leaks: FinalizationRegistry<string> | undefined;
  private cachedBuffer: ArrayBuffer | undefined;
  private cachedU8 = new Uint8Array(0);
  private cachedDv = new DataView(new ArrayBuffer(0));
  private readonly thunks = new Map<string, number>();
  /** Reusable opaque-handle slot for constructors. */
  private readonly slot: number;

  constructor(instance: WebAssembly.Instance, opts: LoadOptions = {}) {
    this.ex = instance.exports as unknown as VtExports;
    this.memory = this.ex.memory;
    this.table = this.ex.__indirect_function_table;
    const SCRATCH = 64 * 1024;
    const base = this.ex.ghostty_wasm_alloc(SCRATCH) >>> 0;
    if (!base) throw new Error('gty-vt: out of memory');
    this.scratch = new Scratch(base, SCRATCH);
    this.slot = this.ex.ghostty_wasm_alloc_opaque() >>> 0;
    this.version = this.cstr(this.ex.ghostty_version() >>> 0);
    this.features = this.readFeatures();
    this.leaks = opts.trackLeaks ? new FinalizationRegistry((what) => opts.log?.(`gty-vt leak: ${what} was not disposed`)) : undefined;
  }

  // ---- memory ------------------------------------------------------------

  private refresh(): void {
    const buf = this.memory.buffer as ArrayBuffer;
    if (buf !== this.cachedBuffer || buf.byteLength !== this.cachedU8.byteLength) {
      this.cachedBuffer = buf;
      this.cachedU8 = new Uint8Array(buf);
      this.cachedDv = new DataView(buf);
    }
  }
  get u8(): Uint8Array {
    this.refresh();
    return this.cachedU8;
  }
  get dv(): DataView {
    this.refresh();
    return this.cachedDv;
  }

  alloc(len: number): number {
    if (len === 0) return 0;
    const p = this.ex.ghostty_wasm_alloc(len) >>> 0;
    if (!p) throw new VtError(E.GhosttyResult.OUT_OF_MEMORY, 'ghostty_wasm_alloc');
    return p;
  }
  free(ptr: number, len: number): void {
    if (ptr) this.ex.ghostty_wasm_free(ptr, len);
  }
  /** Frees a buffer returned by an allocating API (`*_alloc`). */
  freeLib(ptr: number, len: number): void {
    if (ptr) this.ex.ghostty_free(0, ptr, len);
  }

  /** Copies bytes into a fresh allocation. Caller frees with `free(ptr, len)`. */
  copyIn(bytes: Uint8Array): number {
    const p = this.alloc(bytes.length);
    if (p) this.u8.set(bytes, p);
    return p;
  }
  copyOut(ptr: number, len: number): Uint8Array {
    return this.u8.slice(ptr, ptr + len);
  }
  text(ptr: number, len: number): string {
    return len ? dec.decode(this.u8.subarray(ptr, ptr + len)) : '';
  }
  cstr(ptr: number): string {
    const u8 = this.u8;
    let end = ptr;
    while (u8[end]) end++;
    return dec.decode(u8.subarray(ptr, end));
  }
  /** Reads a GhosttyString at `p`. */
  gstr(p: number): string {
    const dv = this.dv;
    return this.text(dv.getUint32(p, true), dv.getUint32(p + 4, true));
  }
  gbytes(p: number): Uint8Array {
    const dv = this.dv;
    return this.copyOut(dv.getUint32(p, true), dv.getUint32(p + 4, true));
  }
  rgb(p: number): Rgb {
    const u8 = this.u8;
    return (u8[p] << 16) | (u8[p + 1] << 8) | u8[p + 2];
  }
  setRgb(p: number, c: Rgb): void {
    const u8 = this.u8;
    u8[p] = (c >> 16) & 0xff;
    u8[p + 1] = (c >> 8) & 0xff;
    u8[p + 2] = c & 0xff;
  }

  /** Runs `fn` with a scratch mark that is released afterwards, even on throw. */
  withScratch<T>(fn: (take: (len: number, align?: number) => number) => T): T {
    const m = this.scratch.mark();
    try {
      return fn((len, align) => this.scratch.take(this, len, align));
    } finally {
      this.scratch.release(m);
    }
  }

  /** Writes a sized struct header (its `size` field) into zeroed memory at `p`. */
  sized(p: number, size: number): number {
    this.dv.setUint32(p, size, true);
    return p;
  }

  /** A GhosttyString in scratch that points at a scratch copy of `s`. */
  scratchString(take: (len: number, align?: number) => number, s: string | Uint8Array): number {
    const bytes = typeof s === 'string' ? enc.encode(s) : s;
    const sp = take(8, 4);
    const data = bytes.length ? take(bytes.length, 1) : 0;
    if (data) this.u8.set(bytes, data);
    const dv = this.dv;
    dv.setUint32(sp, data, true);
    dv.setUint32(sp + 4, bytes.length, true);
    return sp;
  }

  // ---- results and handles ----------------------------------------------

  check(r: number, op: string): void {
    if (r === OK) return;
    if (r === E.GhosttyResult.UNSUPPORTED) throw new VtUnsupportedError(op);
    throw new VtError(r, op);
  }

  /** Calls a constructor that writes a handle to an out-slot and returns it. */
  construct(op: string, call: (slot: number) => number): number {
    const r = call(this.slot);
    const handle = this.ex.ghostty_wasm_take_opaque(this.slot) >>> 0;
    this.check(r, op);
    if (!handle) throw new VtError(E.GhosttyResult.OUT_OF_MEMORY, op);
    return handle;
  }

  // ---- callbacks ---------------------------------------------------------

  /**
   * Installs `fn` in the function table under `key` (once per key) and
   * returns its table index, the value C sees as a function pointer.
   */
  callback(key: string, sig: Signature, fn: (...args: number[]) => number | void): number {
    const existing = this.thunks.get(key);
    if (existing !== undefined) return existing;
    const mod = new WebAssembly.Module(thunkModuleBytes(sig) as BufferSource);
    const inst = new WebAssembly.Instance(mod, { e: { f: fn } });
    const index = this.table.grow(1);
    this.table.set(index, inst.exports.f as unknown as () => void);
    this.thunks.set(key, index);
    return index;
  }

  /** Calls a C function pointer (a table index) found in library memory. */
  callPtr(index: number, ...args: number[]): number {
    const f = this.table.get(index) as unknown as Fn | null;
    if (!f) throw new Error(`gty-vt: null function pointer ${index}`);
    return f(...args);
  }

  // ---- build info ----------------------------------------------------------

  buildBool(key: keyof typeof E.GhosttyBuildInfo): boolean {
    return this.withScratch((take) => {
      const out = take(4);
      const r = this.ex.ghostty_build_info(E.GhosttyBuildInfo[key], out);
      return r === OK && this.u8[out] !== 0;
    });
  }

  private readFeatures(): Features {
    const optimize = this.withScratch((take) => {
      const out = take(4);
      const r = this.ex.ghostty_build_info(E.GhosttyBuildInfo.OPTIMIZE, out);
      const names = ['debug', 'release-safe', 'release-small', 'release-fast'];
      return r === OK ? names[this.dv.getInt32(out, true)] ?? 'unknown' : 'unknown';
    });
    return {
      simd: this.buildBool('SIMD'),
      kittyGraphics: this.buildBool('KITTY_GRAPHICS'),
      snapshot: this.buildBool('FEATURE_SNAPSHOT'),
      formatter: this.buildBool('FEATURE_FORMATTER'),
      selection: this.buildBool('FEATURE_SELECTION'),
      search: this.buildBool('FEATURE_SEARCH'),
      renderState: this.buildBool('FEATURE_RENDER_STATE'),
      inputEncode: this.buildBool('FEATURE_INPUT_ENCODE'),
      optimize,
    };
  }
}

/** 0xRRGGBB. */
export type Rgb = number;

export function rgbHex(c: Rgb): string {
  return `#${c.toString(16).padStart(6, '0')}`;
}

export function parseHex(s: string): Rgb | undefined {
  const m = /^#?([0-9a-f]{6})$/i.exec(s.trim());
  return m ? parseInt(m[1], 16) : undefined;
}

export { enc as utf8Encoder, dec as utf8Decoder };
