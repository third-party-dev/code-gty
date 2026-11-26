// Node transports for the sidecar client: the gty-sidecar process as a
// child over stdin/stdout, or the daemon (sessions that survive window
// reloads) over its socket. The protocol itself is in core/sidecarClient.ts,
// shared with the native app. Free of `vscode` imports so the conformance
// tests can drive a real sidecar with it.

import { ChildProcess, spawn } from 'node:child_process';
import { Connector, SidecarClient as CoreClient, SidecarOptions, Transport, TransportEvents } from './core/sidecarClient';
import { connectDaemon, DaemonOptions } from './daemon';

export type { Claimed, DecodedImage, DecodeRequest, SessionInfo, SessionListener, SidecarOptions } from './core/sidecarClient';

const asBytes = (chunk: Buffer) => new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);

/** The sidecar as a child process: its sessions end with this client. */
function stdioConnector(binary: string): Connector & { proc?: ChildProcess } {
  const connector: Connector & { proc?: ChildProcess } = {
    persistent: false,
    connect(events: TransportEvents): Transport {
      const proc = spawn(binary, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // The sidecar needs no environment of its own (each spawn carries a full
        // one), except what Windows needs to load system DLLs.
        env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {},
      });
      connector.proc = proc;
      proc.stdout!.on('data', (chunk: Buffer) => events.data(asBytes(chunk)));
      proc.stderr!.setEncoding('utf8');
      proc.stderr!.on('data', (text: string) => events.log?.(text));
      proc.on('error', (err) => events.closed(`failed to start sidecar: ${err.message}`));
      proc.on('exit', (code, signal) => events.closed(`sidecar exited (code ${code}, signal ${signal})`));
      proc.stdin!.on('error', () => undefined);
      return {
        send: (bytes) => {
          if (proc.stdin?.writable) proc.stdin.write(bytes);
        },
        close: () => {
          // Closing stdin is the shutdown signal; the sidecar hangs up its shells.
          proc.stdin?.end();
          setTimeout(() => {
            if (proc.exitCode === null && proc.signalCode === null) proc.kill();
          }, 3000).unref();
        },
        destroy: () => proc.kill(),
      };
    },
  };
  return connector;
}

/** The sidecar daemon over its socket: sessions outlive this client. */
function daemonConnector(opts: DaemonOptions): Connector {
  return {
    persistent: true,
    async connect(events: TransportEvents): Promise<Transport> {
      const sock = await connectDaemon(opts);
      sock.on('data', (chunk: Buffer) => events.data(asBytes(chunk)));
      sock.on('error', (e) => events.closed(`sidecar connection: ${e.message}`));
      sock.on('close', () => events.closed('sidecar connection closed'));
      return {
        send: (bytes) => {
          if (sock.writable) sock.write(bytes);
        },
        close: () => sock.end(),
        destroy: () => sock.destroy(),
      };
    },
  };
}

export class SidecarClient extends CoreClient {
  private readonly stdio: { proc?: ChildProcess };

  /** The sidecar as a child of this process. */
  constructor(binary: string, options: SidecarOptions = {}) {
    const connector = stdioConnector(binary);
    super(connector, options);
    this.stdio = connector;
  }

  /** A client of the sidecar daemon, whose sessions outlive this window. */
  static forDaemon(opts: DaemonOptions & SidecarOptions): CoreClient {
    return new CoreClient(daemonConnector(opts), opts);
  }

  /** The child's pid (not in daemon mode). */
  get pid(): number | undefined {
    return this.stdio.proc?.pid;
  }
}
