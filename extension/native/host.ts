// The native app's page host: the extension's TerminalSession (core/), run
// in the page with the native platform, a window view and the sidecar
// daemon over the app's WebSocket bridge. The same code as in VS Code; only
// what is around it differs.

import type { LaunchPlan } from '../src/core/platform';
import { CreateOptions, SessionHost, TerminalSession } from '../src/core/session';
import { SidecarClient } from '../src/core/sidecarClient';
import { boot } from './boot';
import { onClose, send } from './ipc';
import { planLaunch } from './launch';
import { nativePlatform } from './platform';
import { WindowView } from './view';
import { wsConnector } from './ws';

class NativeHost implements SessionHost {
  readonly platform = nativePlatform(boot);
  readonly extensionVersion = boot.version;
  readonly log = this.platform.log;
  shuttingDown = false;
  private client: SidecarClient | undefined;
  private sessions = new Set<TerminalSession>();

  constructor(private readonly module: WebAssembly.Module) {}

  async sidecar(): Promise<SidecarClient> {
    if (this.client && !this.client.isDead) return this.client;
    const client = new SidecarClient(wsConnector(boot.ws), {
      log: (line) => this.log.info(line),
      onDied: (reason) => this.log.error(`Sidecar connection lost: ${reason}`),
    });
    const hello = await client.start();
    this.log.info(`Sidecar daemon: pid ${hello.pid}, build ${hello.build}, ${hello.os}`);
    this.client = client;
    return client;
  }

  vtModule(): WebAssembly.Module {
    return this.module;
  }

  planLaunch(cwd: string | undefined, opts: CreateOptions): LaunchPlan {
    return planLaunch(boot, cwd, opts);
  }

  open(view: WindowView): TerminalSession {
    const s = new TerminalSession(this, view, this.sessions.size + 1, {}, false);
    this.sessions.add(s);
    return s;
  }

  onSessionFocused(): void {}
  onSequence(): void {}
  onStatusChanged(): void {}

  onSessionClosed(s: TerminalSession): void {
    this.sessions.delete(s);
    // One terminal per window: closing it ends the app. Its shell was ended
    // first (or, after "Keep Running", the tab came back instead).
    if (!this.sessions.size) send({ type: 'quit' });
  }

  /** "Keep Running" after closing: the window stays, with the same session. */
  reopen(s: TerminalSession): void {
    s.bindView(s.view);
    s.pushConfig();
  }
}

export async function startApp(): Promise<void> {
  const wasm = document.body.dataset.wasm!;
  const module = await WebAssembly.compileStreaming(fetch(wasm)).catch(async () => WebAssembly.compile(await (await fetch(wasm)).arrayBuffer()));
  const host = new NativeHost(module);
  const view = new WindowView();
  host.open(view);
  // Closing the window closes its tab, with the same confirmation as in VS Code.
  onClose(() => view.dispose());
}
