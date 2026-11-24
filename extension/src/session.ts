// One terminal tab: a webview panel bound to a sidecar session.

import * as vscode from 'vscode';
import { openLink } from './links';
import { interpretOsc, OscScanner } from './osc';
import { ExitMsg, ProcessInfoMsg } from './protocol';
import { isMultiline } from './shared/paste';
import { HostToWebview, parseWebviewMessage, PersistedState, WebviewToHost } from './shared/messages';
import type { SessionListener, SidecarClient } from './sidecar';
import { LaunchPlan, webviewConfig } from './terminalConfig';

export interface SessionHost {
  readonly extensionUri: vscode.Uri;
  readonly log: vscode.LogOutputChannel;
  sidecar(): Promise<SidecarClient>;
  planLaunch(cwd: string | undefined, opts: CreateOptions): LaunchPlan;
  renderHtml(webview: vscode.Webview): string;
  onSessionFocused(s: TerminalSession): void;
  onSessionClosed(s: TerminalSession): void;
  reopen(s: TerminalSession): void;
}

export interface CreateOptions {
  name?: string;
  cwd?: string;
  env?: Record<string, string | null>;
  shellPath?: string;
  shellArgs?: string[];
}

const encoder = new TextEncoder();

export class TerminalSession implements SessionListener {
  private sidecarClient: SidecarClient | undefined;
  private sessionId = 0;
  private spawned = false;
  private spawning = false;
  private webviewReady = false;
  /** Output is dropped between an attach request and its replay. */
  private awaitingReplay = false;
  private exited = false;
  private killedByUser = false;
  private readonly scanner = new OscScanner();
  private sequenceTitle: string | undefined;
  private processName: string | undefined;
  private busy: boolean | undefined;
  private shellPid: number | undefined;
  private pendingResize: { cols: number; rows: number } | undefined;
  private disposables: vscode.Disposable[] = [];
  private recentOutputResolver: ((text: string) => void) | undefined;
  private pidWaiters: ((pid: number | undefined) => void)[] = [];
  private processWaiters: (() => void)[] = [];
  cwd: string | undefined;
  renamed: string | undefined;

  constructor(
    private readonly host: SessionHost,
    public panel: vscode.WebviewPanel,
    readonly number: number,
    private readonly options: CreateOptions,
    private readonly restored: boolean,
  ) {
    this.cwd = options.cwd;
    this.renamed = options.name;
    this.bindPanel(panel);
  }

  // ---- panel wiring ------------------------------------------------------

  bindPanel(panel: vscode.WebviewPanel): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.panel = panel;
    this.webviewReady = false;
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.host.extensionUri, 'media', 'icon-light.svg'),
      dark: vscode.Uri.joinPath(this.host.extensionUri, 'media', 'icon-dark.svg'),
    };
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.host.extensionUri, 'media')],
    };
    panel.webview.html = this.host.renderHtml(panel.webview);
    this.updateTitle();
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m) => this.onMessage(m)),
      panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.active) {
          this.host.onSessionFocused(this);
          this.post({ type: 'focus' });
        }
      }),
      panel.onDidDispose(() => this.onPanelDisposed()),
    );
  }

  get title(): string {
    return this.renamed || this.sequenceTitle || (this.busy && this.processName) || `Ghostty ${this.number}`;
  }

  get isExited(): boolean {
    return this.exited;
  }

  get isBusy(): boolean {
    return this.busy === true;
  }

  get foregroundName(): string | undefined {
    return this.processName;
  }

  processId(): Promise<number | undefined> {
    if (this.spawned || this.exited) return Promise.resolve(this.shellPid);
    return new Promise((resolve) => this.pidWaiters.push(resolve));
  }

  // ---- host -> webview ---------------------------------------------------

  post(msg: HostToWebview): void {
    if (!this.webviewReady && msg.type !== 'init') return;
    void this.panel.webview.postMessage(msg);
  }

  pushConfig(): void {
    this.post({ type: 'config', config: webviewConfig() });
  }

  // ---- webview -> host ---------------------------------------------------

  private async onMessage(raw: unknown): Promise<void> {
    const msg = parseWebviewMessage(raw);
    if (!msg) {
      this.host.log.warn('Dropped invalid webview message');
      return;
    }
    try {
      await this.handle(msg);
    } catch (e) {
      this.host.log.error(`Error handling ${msg.type}: ${(e as Error).message}`);
    }
  }

  private async handle(msg: WebviewToHost): Promise<void> {
    switch (msg.type) {
      case 'ready': {
        const recreated = this.spawned;
        this.webviewReady = true;
        this.post({ type: 'init', config: webviewConfig(), restored: this.restored && !recreated });
        this.persist();
        if (recreated) this.awaitingReplay = true;
        if (this.panel.active) this.post({ type: 'focus' });
        break;
      }
      case 'resize':
        await this.onResize(msg.cols, msg.rows);
        break;
      case 'input':
        if (this.exited) {
          // Like the built-in terminal: a key press after exit closes the tab.
          this.panel.dispose();
          return;
        }
        if (this.spawned) this.sidecarClient?.input(this.sessionId, msg.data);
        break;
      case 'ack':
        if (this.spawned) this.sidecarClient?.ack(this.sessionId, msg.bytes);
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(msg.text);
        break;
      case 'paste': {
        const text = msg.text ?? (await vscode.env.clipboard.readText());
        await this.paste(text, msg.bracketed);
        break;
      }
      case 'openLink':
        await openLink(msg.kind, msg.text, this.cwd);
        break;
      case 'bell':
        break;
      case 'focusChanged':
        if (msg.focused) this.host.onSessionFocused(this);
        break;
      case 'recentOutput':
        this.recentOutputResolver?.(msg.text);
        this.recentOutputResolver = undefined;
        break;
      case 'reattach':
        // The webview rebuilt its terminal (theme change) and needs the replay.
        if (this.spawned && !this.exited) {
          this.awaitingReplay = true;
          this.sidecarClient?.attach(this.sessionId);
        }
        break;
      case 'log':
        this.host.log[msg.level](`[webview ${this.number}] ${msg.message}`);
        break;
    }
  }

  private async onResize(cols: number, rows: number): Promise<void> {
    if (this.spawned) {
      this.sidecarClient?.resize(this.sessionId, cols, rows);
      if (this.awaitingReplay) this.sidecarClient?.attach(this.sessionId);
      return;
    }
    if (this.exited) return;
    if (this.spawning) {
      this.pendingResize = { cols, rows };
      return;
    }
    this.spawning = true;
    try {
      await this.spawn(cols, rows);
    } finally {
      this.spawning = false;
    }
  }

  private async spawn(cols: number, rows: number): Promise<void> {
    let client: SidecarClient;
    let plan: LaunchPlan;
    try {
      client = await this.host.sidecar();
      plan = this.host.planLaunch(this.cwd, this.options);
    } catch (e) {
      this.failed(`Could not start the terminal: ${(e as Error).message}`);
      return;
    }
    this.sidecarClient = client;
    this.sessionId = client.allocateId();
    this.cwd = plan.cwd;
    const cfg = vscode.workspace.getConfiguration('codeGty');
    this.host.log.info(`Session ${this.sessionId}: ${plan.shell.command} ${JSON.stringify(plan.shell.args)} in ${plan.cwd} (shell integration ${plan.shellIntegration ? 'on' : 'off'})`);
    if (this.restored) this.post({ type: 'notice', text: 'Session restarted after reload' });
    client.spawnSession(
      this.sessionId,
      {
        command: plan.shell.command,
        args: plan.shell.args,
        env: plan.env,
        cwd: plan.cwd,
        cols,
        rows,
        window: cfg.get<number>('flowControlWindow', 262144),
        replayLimit: cfg.get<number>('replayBufferSize', 2 * 1024 * 1024),
      },
      this,
    );
    this.spawned = true;
    this.persist();
    if (this.pendingResize) {
      client.resize(this.sessionId, this.pendingResize.cols, this.pendingResize.rows);
      this.pendingResize = undefined;
    }
  }

  private failed(message: string): void {
    this.exited = true;
    this.host.log.error(message);
    this.post({ type: 'exit', message });
    this.resolvePid();
  }

  // ---- sidecar -> host ---------------------------------------------------

  onSpawned(pid: number | null): void {
    this.shellPid = pid ?? undefined;
    this.resolvePid();
  }

  onOutput(data: Uint8Array): void {
    this.scan(data);
    if (this.awaitingReplay) {
      // Covered by the coming replay; return the credit so the shell runs on.
      this.sidecarClient?.ack(this.sessionId, data.length);
      return;
    }
    this.deliver({ type: 'output', data });
  }

  onReplay(data: Uint8Array, truncated: boolean): void {
    this.awaitingReplay = false;
    this.deliver({ type: 'replay', data, truncated });
  }

  private deliver(msg: { type: 'output' | 'replay'; data: Uint8Array; truncated?: boolean }): void {
    const retain = vscode.workspace.getConfiguration('codeGty').get<boolean>('retainContextWhenHidden', true);
    if (!this.webviewReady || (!retain && !this.panel.visible)) {
      // Nobody can draw it now: ack on the webview's behalf so the shell is
      // not stalled; the replay buffer brings the content back on show.
      this.sidecarClient?.ack(this.sessionId, msg.data.length);
      if (!this.webviewReady || !this.panel.visible) this.awaitingReplay = this.spawned;
      return;
    }
    void this.panel.webview.postMessage(msg);
  }

  onExit(exit: ExitMsg): void {
    if (this.exited) return;
    this.exited = true;
    this.resolvePid();
    if (exit.code === 0 && !this.killedByUser) {
      this.panel.dispose();
      return;
    }
    const why = exit.signal ? `was terminated by signal ${exit.signal}` : exit.code === null ? 'stopped' : `exited with code ${exit.code}`;
    this.post({ type: 'exit', message: `The terminal process ${why}. Press any key to close the tab.` });
  }

  onError(message: string): void {
    this.host.log.error(`Session ${this.sessionId}: ${message}`);
    if (!this.spawned || /stopped/.test(message)) this.post({ type: 'notice', text: message });
  }

  onProcessInfo(info: ProcessInfoMsg): void {
    this.processName = info.name ?? undefined;
    if (info.busy !== null) this.busy = info.busy;
    this.updateTitle();
    for (const w of this.processWaiters.splice(0)) w();
  }

  private scan(data: Uint8Array): void {
    for (const payload of this.scanner.push(data)) {
      const ev = interpretOsc(payload);
      if (!ev) continue;
      switch (ev.type) {
        case 'title':
          this.sequenceTitle = ev.title.trim() || undefined;
          this.updateTitle();
          break;
        case 'cwd':
          this.cwd = ev.cwd;
          this.persist();
          break;
        case 'clipboard':
          void this.osc52(ev);
          break;
        case 'commandStart':
          if (process.platform === 'win32') this.busy = true;
          break;
        case 'commandFinished':
        case 'promptStart':
          if (process.platform === 'win32') this.busy = false;
          break;
      }
    }
  }

  private async osc52(ev: { op: 'write'; text: string } | { op: 'read' }): Promise<void> {
    const mode = vscode.workspace.getConfiguration('codeGty').get<string>('osc52', 'write');
    if (mode === 'off') return;
    if (ev.op === 'write') {
      await vscode.env.clipboard.writeText(ev.text);
    } else if (mode === 'readWrite') {
      const text = await vscode.env.clipboard.readText();
      this.sidecarClient?.input(this.sessionId, `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`);
    }
  }

  // ---- actions -----------------------------------------------------------

  /** `bracketed` is whether the shell has bracketed paste on (unknown -> false). */
  async paste(text: string, bracketed = false): Promise<void> {
    if (!text) return;
    const warn = vscode.workspace.getConfiguration('terminal.integrated').get<string | boolean>('enableMultiLinePasteWarning', 'auto');
    // 'auto' warns only when the shell cannot tell a paste from typing.
    const shouldWarn = warn === 'always' || warn === true || (warn === 'auto' && !bracketed);
    if (shouldWarn && isMultiline(text)) {
      const lines = text.split(/\r?\n/).length;
      const choice = await vscode.window.showWarningMessage(`Paste ${lines} lines into the terminal?`, { modal: true }, 'Paste');
      if (choice !== 'Paste') return;
    }
    this.post({ type: 'paste', text });
  }

  sendText(text: string, addNewLine = true): void {
    if (!this.spawned || this.exited) return;
    this.sidecarClient?.input(this.sessionId, encoder.encode(addNewLine ? `${text}\r` : text));
  }

  recentOutput(): Promise<string> {
    return new Promise((resolve) => {
      this.recentOutputResolver = resolve;
      this.post({ type: 'requestRecentOutput' });
      setTimeout(() => resolve(''), 2000);
    });
  }

  rename(name: string | undefined): void {
    this.renamed = name || undefined;
    this.updateTitle();
    this.persist();
  }

  /** Asks the sidecar for the current foreground process (fresh, not polled). */
  refreshProcess(): Promise<void> {
    if (!this.spawned || this.exited || process.platform === 'win32') return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 500);
      this.processWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
      this.sidecarClient?.queryProcess(this.sessionId);
    });
  }

  kill(): void {
    this.killedByUser = true;
    if (this.spawned && !this.exited) this.sidecarClient?.kill(this.sessionId);
    this.exited = true;
    this.resolvePid();
  }

  private updateTitle(): void {
    this.panel.title = this.title;
  }

  private persist(): void {
    const state: PersistedState = { cwd: this.cwd, title: this.title, renamed: this.renamed };
    this.post({ type: 'persist', state });
  }

  private resolvePid(): void {
    for (const w of this.pidWaiters.splice(0)) w(this.shellPid);
  }

  private async onPanelDisposed(): Promise<void> {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.webviewReady = false;
    if (!this.exited && this.spawned) {
      // A webview tab cannot veto its own closing, so confirm afterwards and
      // offer to bring the tab back with its session intact.
      await this.refreshProcess();
      const confirm = vscode.workspace.getConfiguration('terminal.integrated').get<string>('confirmOnKill', 'editor');
      const ask = confirm === 'always' || confirm === 'editor';
      if (ask && this.busy) {
        const what = this.processName ? `"${this.processName}"` : 'A process';
        const choice = await vscode.window.showWarningMessage(
          `${what} is still running in ${this.title}. Terminate it?`,
          { modal: true },
          'Terminate',
          'Keep Running',
        );
        if (choice !== 'Terminate') {
          this.host.reopen(this);
          return;
        }
      }
      this.kill();
    }
    this.host.onSessionClosed(this);
  }
}
