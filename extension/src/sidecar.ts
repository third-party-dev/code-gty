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
    this.options.onDied?.(detail);
  }
}
