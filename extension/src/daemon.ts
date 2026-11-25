// Finding, starting and connecting to the sidecar daemon (`--server` mode),
// which keeps terminal sessions alive across window reloads and closes.
// vscode-free, so the conformance tests drive it directly.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { encodeFrame, Kind, PROTOCOL_VERSION } from './protocol';

export interface DaemonOptions {
  binary: string;
  /** Directory for the socket, state file and log (private to the user). */
  dir: string;
  /** libghostty-vt module, for keeping detached sessions current. */
  vt?: string;
  log?: (line: string) => void;
  startTimeoutMs?: number;
}

interface DaemonState {
  pid: number;
  protocol: number;
  build: string;
  token: string;
  socket?: string;
  port?: number;
}

/** Per-user directory for the daemon: runtime dir on Linux, temp dir elsewhere, LOCALAPPDATA on Windows. */
export function defaultDaemonDir(): string {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), 'code-gty');
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime && fs.existsSync(runtime)) return path.join(runtime, 'code-gty');
  return path.join(os.tmpdir(), `code-gty-${os.userInfo().uid}`);
}

function readState(dir: string): DaemonState | undefined {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, `daemon-v${PROTOCOL_VERSION}.json`), 'utf8')) as DaemonState;
    return s.protocol === PROTOCOL_VERSION && s.token ? s : undefined;
  } catch {
    return undefined;
  }
}

function connect(state: DaemonState, timeoutMs = 2000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = state.socket ? net.createConnection(state.socket) : net.createConnection(state.port ?? 0, '127.0.0.1');
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('timed out connecting to the sidecar daemon'));
    }, timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.setNoDelay(true);
      // The token proves we are this user: only they can read the state file.
      sock.write(encodeFrame(Kind.AUTH, 0, new TextEncoder().encode(state.token)));
      resolve(sock);
    });
    sock.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** Connects to the running daemon, starting one if there is none. */
export async function connectDaemon(opts: DaemonOptions): Promise<net.Socket> {
  const existing = readState(opts.dir);
  if (existing) {
    try {
      return await connect(existing);
    } catch {
      // Stale state from a daemon that is gone: start a new one.
    }
  }
  fs.mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
  const logFile = path.join(opts.dir, 'sidecar.log');
  const log = fs.openSync(logFile, 'a', 0o600);
  const args = ['--server', opts.dir];
  if (opts.vt) args.push('--vt', opts.vt);
  const child = spawn(opts.binary, args, {
    // Its own session and no pipes to us: it must outlive this window.
    detached: true,
    stdio: ['ignore', 'ignore', log],
    windowsHide: true,
    env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {},
  });
  child.unref();
  fs.closeSync(log);
  opts.log?.(`started sidecar daemon (pid ${child.pid}), log: ${logFile}`);
  const deadline = Date.now() + (opts.startTimeoutMs ?? 10000);
  let lastError: unknown;
  while (Date.now() < deadline) {
    const state = readState(opts.dir);
    if (state && state.pid !== existing?.pid) {
      try {
        return await connect(state);
      } catch (e) {
        lastError = e;
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`the sidecar daemon did not start: ${String(lastError ?? 'no state file')} (see ${logFile})`);
}
