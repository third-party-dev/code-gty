// Client for the gty-sidecar process. Free of `vscode` imports so the
// conformance tests can drive a real sidecar with it.

import { ChildProcess, spawn } from 'node:child_process';
import {
  decodeJson,
  encodeAck,
  encodeFrame,
  encodeJson,
  ExitMsg,
  Frame,
  FrameDecoder,
  HelloMsg,
  Kind,
  MAX_FRAME,
  ProcessInfoMsg,
  PROTOCOL_VERSION,
  SpawnRequest,
} from './protocol';

export interface SessionListener {
  onSpawned?(pid: number | null): void;
  onOutput(data: Uint8Array): void;
  onReplay(data: Uint8Array, truncated: boolean): void;
  onExit(exit: ExitMsg): void;
  onError(message: string): void;
  onProcessInfo?(info: ProcessInfoMsg): void;
}

/** A decoded image: zlib-compressed RGBA frames. */
export interface DecodedImage {
  width: number;
  height: number;
  frames: { delayMs: number; zrgba: Uint8Array }[];
}

export interface DecodeRequest {
  kind: 'file' | 'sixel';
  data: Uint8Array;
  /** Sixel: pixels that are not drawn stay transparent. */
  transparent?: boolean;
  /** Sixel: colour of pixels that are not drawn (0xRRGGBB). */
  background?: number;
}

export interface SidecarOptions {
  log?: (line: string) => void;
  /** Called once if the process dies or the stream breaks. */
  onDied?: (reason: string) => void;
}

const encoder = new TextEncoder();

export class SidecarClient {
  private proc: ChildProcess | undefined;
  private readonly decoder = new FrameDecoder();
  private readonly listeners = new Map<number, SessionListener>();
  private nextId = 1;
  private dead = false;
  private hello: Promise<HelloMsg>;
  private resolveHello!: (h: HelloMsg) => void;
  private rejectHello!: (e: Error) => void;
  private stderrTail = '';
  private nextDecode = 1;
  private readonly decodes = new Map<number, { resolve: (d: DecodedImage | undefined) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly binary: string,
    private readonly options: SidecarOptions = {},
  ) {
    this.hello = new Promise((resolve, reject) => {
      this.resolveHello = resolve;
      this.rejectHello = reject;
    });
    // Avoid an unhandled rejection if nobody awaits start().
    this.hello.catch(() => undefined);
  }

  /** Starts the process and resolves with its hello frame. */
  start(timeoutMs = 10000): Promise<HelloMsg> {
    if (this.proc) return this.hello;
    const proc = spawn(this.binary, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // The sidecar needs no environment of its own (each spawn carries a full
      // one), except what Windows needs to load system DLLs.
      env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {},
    });
    this.proc = proc;
    proc.stdout!.on('data', (chunk: Buffer) => this.onData(chunk));
    proc.stderr!.setEncoding('utf8');
    proc.stderr!.on('data', (text: string) => {
      this.stderrTail = (this.stderrTail + text).slice(-4000);
      for (const line of text.split(/\r?\n/)) if (line) this.options.log?.(line);
    });
    proc.on('error', (err) => this.die(`failed to start sidecar: ${err.message}`));
    proc.on('exit', (code, signal) => this.die(`sidecar exited (code ${code}, signal ${signal})`));
    proc.stdin!.on('error', () => undefined);
    const timer = setTimeout(() => this.die('sidecar did not say hello in time'), timeoutMs);
    void this.hello.finally(() => clearTimeout(timer)).catch(() => undefined);
    return this.hello;
  }

  get isDead(): boolean {
    return this.dead;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  allocateId(): number {
    return this.nextId++;
  }

  spawnSession(id: number, req: SpawnRequest, listener: SessionListener): void {
    this.listeners.set(id, listener);
    this.send(encodeJson(Kind.SPAWN, id, req));
  }

  input(id: number, data: string | Uint8Array): void {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    // Keep frames well under the sidecar's limit for huge pastes.
    const max = 1024 * 1024;
    for (let off = 0; off < bytes.length; off += max) {
      this.send(encodeFrame(Kind.INPUT, id, bytes.subarray(off, off + max)));
    }
  }

  /** `width` and `height` are the text area in pixels (0 when unknown), for TIOCGWINSZ. */
  resize(id: number, cols: number, rows: number, width = 0, height = 0): void {
    this.send(encodeJson(Kind.RESIZE, id, { cols, rows, width, height }));
  }

  ack(id: number, bytes: number): void {
    if (bytes > 0) this.send(encodeAck(id, bytes));
  }

  attach(id: number): void {
    this.send(encodeFrame(Kind.ATTACH, id));
  }

  /**
   * Decodes an image in the sidecar (its own thread, with size limits).
   * Resolves undefined on any failure or after `timeoutMs`.
   */
  decode(session: number, req: DecodeRequest, timeoutMs = 15000): Promise<DecodedImage | undefined> {
    if (this.dead || req.data.length + 64 > MAX_FRAME) return Promise.resolve(undefined);
    const id = this.nextDecode++;
    const head = new Uint8Array(10);
    const dv = new DataView(head.buffer);
    dv.setUint32(0, id, true);
    head[4] = req.kind === 'sixel' ? 1 : 0;
    head[5] = req.transparent ? 1 : 0;
    const bg = req.background ?? 0;
    head.set([(bg >> 16) & 255, (bg >> 8) & 255, bg & 255, 255], 6);
    const payload = new Uint8Array(head.length + req.data.length);
    payload.set(head);
    payload.set(req.data, head.length);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.decodes.delete(id);
        resolve(undefined);
      }, timeoutMs);
      this.decodes.set(id, { resolve, timer });
      this.send(encodeFrame(Kind.DECODE, session, payload));
    });
  }

  private onDecoded(p: Uint8Array): void {
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    if (p.length < 5) return;
    const pending = this.decodes.get(dv.getUint32(0, true));
    if (!pending) return;
    this.decodes.delete(dv.getUint32(0, true));
    clearTimeout(pending.timer);
    if (p[4] !== 0 || p.length < 17) {
      this.options.log?.(`image decode failed: ${new TextDecoder().decode(p.subarray(5))}`);
      pending.resolve(undefined);
      return;
    }
    const width = dv.getUint32(5, true);
    const height = dv.getUint32(9, true);
    const n = dv.getUint32(13, true);
    const frames: DecodedImage['frames'] = [];
    let off = 17;
    for (let i = 0; i < n && off + 8 <= p.length; i++) {
      const delayMs = dv.getUint32(off, true);
      const len = dv.getUint32(off + 4, true);
      frames.push({ delayMs, zrgba: p.slice(off + 8, off + 8 + len) });
      off += 8 + len;
    }
    pending.resolve(frames.length ? { width, height, frames } : undefined);
  }

  queryProcess(id: number): void {
    this.send(encodeFrame(Kind.QUERY_PROCESS, id));
  }

  kill(id: number): void {
    this.send(encodeFrame(Kind.KILL, id));
    this.listeners.delete(id);
  }

  dispose(): void {
    if (!this.proc) return;
    this.dead = true;
    // Closing stdin is the shutdown signal; the sidecar hangs up its shells.
    this.proc.stdin?.end();
    const proc = this.proc;
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill();
    }, 3000).unref();
  }

  private send(bytes: Uint8Array): void {
    if (this.dead || !this.proc?.stdin?.writable) return;
    this.proc.stdin.write(bytes);
  }

  private onData(chunk: Buffer): void {
    let frames: Frame[];
    try {
      frames = this.decoder.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    } catch (e) {
      this.die(`protocol error: ${(e as Error).message}`);
      this.proc?.kill();
      return;
    }
    for (const f of frames) this.dispatch(f);
  }

  private dispatch(f: Frame): void {
    if (f.kind === Kind.HELLO) {
      const hello = decodeJson<HelloMsg>(f);
      if (hello.protocol !== PROTOCOL_VERSION) {
        this.rejectHello(new Error(`sidecar speaks protocol ${hello.protocol}, expected ${PROTOCOL_VERSION}`));
        this.dispose();
        return;
      }
      this.resolveHello(hello);
      return;
    }
    if (f.kind === Kind.DECODED) {
      this.onDecoded(f.payload);
      return;
    }
    const l = this.listeners.get(f.session);
    if (!l) {
      if (f.kind === Kind.ERROR) this.options.log?.(`sidecar error (session ${f.session}): ${decodeJson<{ message: string }>(f).message}`);
      return;
    }
    switch (f.kind) {
      case Kind.SPAWNED:
        l.onSpawned?.(decodeJson<{ pid: number | null }>(f).pid);
        break;
      case Kind.OUTPUT:
        l.onOutput(f.payload);
        break;
      case Kind.REPLAY:
        l.onReplay(f.payload.subarray(1), f.payload[0] === 1);
        break;
      case Kind.EXIT:
        l.onExit(decodeJson<ExitMsg>(f));
        break;
      case Kind.ERROR:
        l.onError(decodeJson<{ message: string }>(f).message);
        break;
      case Kind.PROCESS_INFO:
        l.onProcessInfo?.(decodeJson<ProcessInfoMsg>(f));
        break;
      default:
        this.options.log?.(`unexpected frame kind ${f.kind}`);
    }
  }

  private die(reason: string): void {
    if (this.dead && !this.proc) return;
    const wasDead = this.dead;
    this.dead = true;
    const detail = this.stderrTail.trim() ? `${reason}\n${this.stderrTail.trim()}` : reason;
    this.rejectHello(new Error(detail));
    if (wasDead) return;
    for (const [, l] of this.listeners) {
      l.onError(`The terminal backend stopped: ${reason}`);
      l.onExit({ code: null, signal: null });
    }
    this.listeners.clear();
    for (const [, d] of this.decodes) {
      clearTimeout(d.timer);
      d.resolve(undefined);
    }
    this.decodes.clear();
    this.options.onDied?.(detail);
  }
}
