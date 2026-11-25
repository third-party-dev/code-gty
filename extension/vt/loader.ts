// Instantiates libghostty-vt from bytes or a compiled module, in Node or a
// browser. Supports the official wasm32-freestanding release (no imports) and
// a wasm32-wasi build (needed for Kitty graphics), for which it provides the
// few WASI calls the library makes: clock, random and stderr for logs.

import { BINDINGS_VERSION, LoadOptions, Vt } from './core';
import { installPngDecoder } from './kitty';

export class VtVersionError extends Error {}

const WASI_ESUCCESS = 0;
const WASI_EBADF = 8;
const WASI_ENOSYS = 52;

type MemoryRef = { memory?: WebAssembly.Memory };

function randomFill(bytes: Uint8Array): void {
  // getRandomValues takes at most 64 KiB at a time.
  for (let off = 0; off < bytes.length; off += 65536) {
    globalThis.crypto.getRandomValues(bytes.subarray(off, Math.min(bytes.length, off + 65536)));
  }
}

function wasiImports(ref: MemoryRef, log: (line: string) => void): Record<string, (...a: never[]) => number | bigint | void> {
  const mem = () => ref.memory!;
  const dv = () => new DataView(mem().buffer);
  const dec = new TextDecoder();
  let pending = '';
  const imports: Record<string, (...a: never[]) => number | bigint | void> = {
    clock_time_get(_id: number, _precision: bigint, out: number) {
      // Nanoseconds. The library only needs a monotonic-ish clock for
      // Kitty graphics animation and image timestamps.
      const now = typeof performance !== 'undefined' ? performance.timeOrigin + performance.now() : Date.now();
      dv().setBigUint64(out, BigInt(Math.round(now * 1e6)), true);
      return WASI_ESUCCESS;
    },
    clock_res_get(_id: number, out: number) {
      dv().setBigUint64(out, 1000n, true);
      return WASI_ESUCCESS;
    },
    random_get(ptr: number, len: number) {
      randomFill(new Uint8Array(mem().buffer, ptr, len));
      return WASI_ESUCCESS;
    },
    fd_write(fd: number, iovs: number, iovsLen: number, nwritten: number) {
      if (fd !== 1 && fd !== 2) return WASI_EBADF;
      const view = dv();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const p = view.getUint32(iovs + i * 8, true);
        const n = view.getUint32(iovs + i * 8 + 4, true);
        pending += dec.decode(new Uint8Array(mem().buffer, p, n), { stream: true });
        total += n;
      }
      let nl: number;
      while ((nl = pending.indexOf('\n')) >= 0) {
        log(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
      }
      view.setUint32(nwritten, total, true);
      return WASI_ESUCCESS;
    },
    environ_sizes_get(count: number, size: number) {
      dv().setUint32(count, 0, true);
      dv().setUint32(size, 0, true);
      return WASI_ESUCCESS;
    },
    environ_get() {
      return WASI_ESUCCESS;
    },
    args_sizes_get(count: number, size: number) {
      dv().setUint32(count, 0, true);
      dv().setUint32(size, 0, true);
      return WASI_ESUCCESS;
    },
    args_get() {
      return WASI_ESUCCESS;
    },
    sched_yield() {
      return WASI_ESUCCESS;
    },
    proc_exit(code: number) {
      throw new Error(`libghostty-vt called proc_exit(${code})`);
    },
  };
  return imports;
}

function buildImports(module: WebAssembly.Module, ref: MemoryRef, log: (line: string) => void): WebAssembly.Imports {
  const imports: Record<string, Record<string, WebAssembly.ImportValue>> = {};
  const wasi = wasiImports(ref, log);
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.kind !== 'function') throw new Error(`libghostty-vt imports unsupported ${imp.kind} ${imp.module}.${imp.name}`);
    const table = (imports[imp.module] ??= {});
    if (imp.module === 'wasi_snapshot_preview1' && wasi[imp.name]) {
      table[imp.name] = wasi[imp.name] as WebAssembly.ImportValue;
    } else {
      // Any other filesystem or socket call: the library only reaches these
      // for features we never enable (Kitty file media), so refuse them.
      table[imp.name] = (() => WASI_ENOSYS) as WebAssembly.ImportValue;
    }
  }
  return imports;
}

export interface VtLoadOptions extends LoadOptions {
  /** Refuse a module whose version differs from the bindings (default true). */
  strictVersion?: boolean;
}

/** Compiles (if needed) and instantiates the module, then checks its version. */
export async function loadVt(source: BufferSource | WebAssembly.Module, opts: VtLoadOptions = {}): Promise<Vt> {
  const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
  const r: MemoryRef = {};
  const instance = await WebAssembly.instantiate(module, buildImports(module, r, opts.log ?? (() => undefined)));
  return finish(instance, opts, r);
}

/** Synchronous variant for Node (the host and tests). */
export function loadVtSync(source: BufferSource | WebAssembly.Module, opts: VtLoadOptions = {}): Vt {
  const module = source instanceof WebAssembly.Module ? source : new WebAssembly.Module(source);
  const r: MemoryRef = {};
  const instance = new WebAssembly.Instance(module, buildImports(module, r, opts.log ?? (() => undefined)));
  return finish(instance, opts, r);
}

function finish(instance: WebAssembly.Instance, opts: VtLoadOptions, r: MemoryRef): Vt {
  const ex = instance.exports as Record<string, unknown>;
  r.memory = ex.memory as WebAssembly.Memory;
  // WASI reactors initialise their runtime here; freestanding builds have none.
  if (typeof ex._initialize === 'function') (ex._initialize as () => void)();
  const vt = new Vt(instance, opts);
  if (opts.strictVersion !== false && vt.version !== BINDINGS_VERSION) {
    throw new VtVersionError(`libghostty-vt ${vt.version} does not match the bindings (${BINDINGS_VERSION}); regenerate vt/layout.generated.ts`);
  }
  // Kitty images in PNG format need a decoder; both engines get the same one.
  installPngDecoder(vt, opts.log);
  return vt;
}
