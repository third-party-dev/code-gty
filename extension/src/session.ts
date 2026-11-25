// One terminal tab: a webview panel bound to a sidecar session, with the
// authoritative libghostty-vt engine in between.
//
//   sidecar --output--> HostEngine --same bytes, in order--> webview mirror
//                          |  replies, paste --> sidecar
//                          +- effects --> VS Code (title, cwd, clipboard,
//                                         notifications, progress, status)
//
// Flow control: the sidecar stops after a window of unacknowledged bytes.
// Bytes forwarded to a webview are acknowledged when the webview has parsed
// them; with no webview to draw them, the host acknowledges them itself and
// the next webview starts from a snapshot of the host engine.

import * as vscode from 'vscode';
import { Vt } from '../vt/core';
import { loadVtSync } from '../vt/loader';
import type { ProgramStatusReport, ProgressState, SemanticPromptEvent, UnknownSequence } from '../vt/terminal';
import { Modes } from '../vt/terminal';
import { EngineOptions, HostEngine } from './engine/hostEngine';
import { parseFileUri } from './fileUri';
import { openLink } from './links';
import { ExitMsg, ProcessInfoMsg } from './protocol';
import { isMultiline } from './shared/paste';
import { HostToWebview, parseWebviewMessage, PersistedState, WebviewToHost } from './shared/messages';
import type { SessionListener, SidecarClient } from './sidecar';
import { LaunchPlan, webviewConfig } from './terminalConfig';

export interface SessionHost {
  readonly extensionUri: vscode.Uri;
  readonly extensionVersion: string;
  readonly log: vscode.LogOutputChannel;
  sidecar(): Promise<SidecarClient>;
  vtModule(): WebAssembly.Module;
  planLaunch(cwd: string | undefined, opts: CreateOptions): LaunchPlan;
  renderHtml(webview: vscode.Webview): string;
  onSessionFocused(s: TerminalSession): void;
  onSessionClosed(s: TerminalSession): void;
  onSequence(s: TerminalSession, seq: UnknownSequence): void;
  onStatusChanged(s: TerminalSession): void;
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

function gty(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('codeGty');
}

/** Strips characters that can disguise text shown outside the terminal. */
function sanitize(s: string, max = 200): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, max);
}

export class TerminalSession implements SessionListener {
  private sidecarClient: SidecarClient | undefined;
  private sessionId = 0;
  private spawned = false;
  private spawning = false;
  private webviewReady = false;
  /** The webview's mirror has been attached (snapshot or fresh) and receives output. */
  private attached = false;
  /** Bytes forwarded to the current webview and not acknowledged yet. */
  private inflight = 0;
  private exited = false;
  private killedByUser = false;
  private vt: Vt | undefined;
  private engine: HostEngine | undefined;
  private cols = 80;
  private rows = 24;
  private sequenceTitle: string | undefined;
  private processName: string | undefined;
  private busy: boolean | undefined;
  private shellPid: number | undefined;
  private pendingResize: { cols: number; rows: number } | undefined;
  private disposables: vscode.Disposable[] = [];
  private pidWaiters: ((pid: number | undefined) => void)[] = [];
  private processWaiters: (() => void)[] = [];
  private progress: { state: ProgressState; percent: number; done: () => void; report: (m: string) => void } | undefined;
  /** OSC 7501 records by id. */
  readonly status = new Map<string, ProgramStatusReport & { updated: number }>();
  lastExitCode: number | undefined;
  private sawPrompt = false;
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
    this.detachWebview();
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
          this.clearSeenStatus();
        }
        // Without retainContextWhenHidden a hidden webview is destroyed; its
        // replacement will say 'ready' and get a snapshot.
        if (!e.webviewPanel.visible && !gty().get<boolean>('retainContextWhenHidden', true)) {
          this.webviewReady = false;
          this.detachWebview();
        }
      }),
      panel.onDidDispose(() => this.onPanelDisposed()),
    );
  }

  get title(): string {
    const base = this.renamed || this.sequenceTitle || (this.busy && this.processName) || `Ghostty ${this.number}`;
    const p = this.progress;
    if (!p || p.state === 'remove') return base;
    const badge = p.state === 'error' ? '✕' : p.state === 'pause' ? '⏸' : p.percent >= 0 ? `${p.percent}%` : '…';
    return `[${badge}] ${base}`;
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

  /** Whether the shell is at a prompt (needs shell integration). */
  get atPrompt(): boolean {
    return this.engine?.cursorAtPrompt ?? false;
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
    const e = this.engine;
    if (!e) return;
    e.setClipboardPolicy(this.clipboardPolicy());
    e.setScrollback(webviewConfig().scrollback);
    e.setImages(gty().get<boolean>('images', true));
    e.setReplyStrings(this.xtversion(), gty().get<string>('answerback', ''));
  }

  /** Acknowledges what the webview will never acknowledge, and stops forwarding to it. */
  private detachWebview(): void {
    if (this.inflight && this.spawned) this.sidecarClient?.ack(this.sessionId, this.inflight);
    this.inflight = 0;
    this.attached = false;
  }

  /** Starts the webview's mirror: from a snapshot when the host engine already has state. */
  private attachWebview(): void {
    this.detachWebview();
    const e = this.engine;
    let snapshot: Uint8Array | undefined;
    if (e) {
      try {
        snapshot = e.snapshot();
      } catch (err) {
        this.host.log.error(`Snapshot failed: ${(err as Error).message}`);
      }
    }
    this.post({ type: 'attach', snapshot, cols: this.cols, rows: this.rows });
    this.attached = true;
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
        // A webview recreated for a running session starts from a snapshot.
        if (this.engine) this.attachWebview();
        if (this.panel.active) this.post({ type: 'focus' });
        break;
      }
      case 'resize':
        this.engine?.setMetrics({ cellWidth: msg.cellWidth, cellHeight: msg.cellHeight });
        this.metrics = { cellWidth: msg.cellWidth, cellHeight: msg.cellHeight };
        await this.onResize(msg.cols, msg.rows);
        break;
      case 'input':
        if (this.exited) {
          // Like the built-in terminal: a key press after exit closes the tab.
          this.panel.dispose();
          return;
        }
        if (this.spawned) this.sidecarClient?.input(this.sessionId, msg.binary ? Uint8Array.from(msg.data, (c) => c.charCodeAt(0) & 0xff) : msg.data);
        break;
      case 'ack': {
        const n = Math.min(msg.bytes, this.inflight);
        this.inflight -= n;
        if (n && this.spawned) this.sidecarClient?.ack(this.sessionId, n);
        break;
      }
      case 'copy':
        await vscode.env.clipboard.writeText(msg.text);
        break;
      case 'paste':
        await this.paste(msg.text ?? (await vscode.env.clipboard.readText()));
        break;
      case 'openLink':
        await openLink(msg.kind, msg.text, this.cwd);
        break;
      case 'bell':
        break;
      case 'focusChanged':
        if (msg.focused) {
          this.host.onSessionFocused(this);
          this.clearSeenStatus();
        }
        break;
      case 'theme':
        this.theme = { foreground: msg.foreground, background: msg.background, cursor: msg.cursor, palette: msg.palette };
        this.engine?.setColors(this.theme);
        break;
      case 'clear':
        this.engine?.clear();
        break;
      case 'reattach':
        if (this.engine) this.attachWebview();
        break;
      case 'log':
        this.host.log[msg.level](`[webview ${this.number}] ${msg.message}`);
        break;
    }
  }

  private metrics = { cellWidth: 9, cellHeight: 18 };

  /** The text area in pixels, as programs read it from the PTY (TIOCGWINSZ). */
  private pixels(cols = this.cols, rows = this.rows): { width: number; height: number } {
    const px = (n: number) => Math.min(0xffff, Math.max(0, Math.round(n)));
    return { width: px(cols * this.metrics.cellWidth), height: px(rows * this.metrics.cellHeight) };
  }
  private theme: EngineOptions['colors'] | undefined;

  private async onResize(cols: number, rows: number): Promise<void> {
    if (this.spawned && this.engine) {
      if (cols === this.cols && rows === this.rows) {
        // Only the cell size changed: same grid, new pixels for the engine
        // (size reports, image placement) and the PTY (TIOCGWINSZ).
        this.engine.resize(cols, rows, this.metrics);
        const p = this.pixels();
        this.sidecarClient?.resize(this.sessionId, cols, rows, p.width, p.height);
        return;
      }
      this.cols = cols;
      this.rows = rows;
      // Same point in the stream for the host engine, the PTY and the mirror.
      this.engine.resize(cols, rows, this.metrics);
      const p = this.pixels();
      this.sidecarClient?.resize(this.sessionId, cols, rows, p.width, p.height);
      this.post({ type: 'resized', cols, rows });
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

  private xtversion(): string {
    return `code-gty ${this.host.extensionVersion} (libghostty-vt ${this.vt?.version ?? '?'})`;
  }

  private clipboardPolicy(): EngineOptions['clipboard'] {
    const v = gty().get<string>('osc52', 'write');
    return v === 'off' || v === 'readWrite' ? v : 'write';
  }

  private createEngine(cols: number, rows: number): HostEngine {
    const cfg = webviewConfig();
    this.vt = loadVtSync(this.host.vtModule(), { log: (l) => this.host.log.info(`[vt ${this.number}] ${l}`) });
    const opts: EngineOptions = {
      cols,
      rows,
      scrollbackLines: cfg.scrollback,
      colors: this.theme ?? {},
      cursorStyle: cfg.cursorStyle,
      cursorBlink: cfg.cursorBlink,
      xtversion: this.xtversion(),
      answerback: gty().get<string>('answerback', ''),
      clipboard: this.clipboardPolicy(),
      images: cfg.images,
    };
    const engine = new HostEngine(this.vt, opts, {
      writePty: (d) => {
        if (this.spawned && !this.exited) this.sidecarClient?.input(this.sessionId, d);
      },
      forward: (d, fromPty) => this.forward(d, fromPty),
      title: (t) => {
        this.sequenceTitle = sanitize(t).trim() || undefined;
        this.updateTitle();
      },
      pwd: (p) => {
        const cwd = parseFileUri(p) ?? (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) ? p : undefined);
        if (cwd) {
          this.cwd = cwd;
          this.persist();
        }
      },
      clipboardWrite: (text) => void vscode.env.clipboard.writeText(text),
      clipboardRead: async () => vscode.env.clipboard.readText(),
      notification: (title, body) => this.notify(title, body),
      progress: (state, pct) => this.onProgress(state, pct),
      programStatus: (r) => this.onProgramStatus(r),
      semanticPrompt: (ev) => this.onSemanticPrompt(ev),
      reset: () => {
        this.sequenceTitle = undefined;
        this.status.clear();
        this.host.onStatusChanged(this);
        this.updateTitle();
      },
      unknownSequence: (seq) => this.host.onSequence(this, seq),
      colorScheme: () => (vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light || vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight ? 'light' : 'dark'),
      error: (e) => this.host.log.error(`[engine ${this.number}] ${(e as Error).stack ?? e}`),
    });
    this.host.log.info(`Session ${this.number}: libghostty-vt ${this.vt.version}, features ${JSON.stringify(this.vt.features)}`);
    return engine;
  }

  private async spawn(cols: number, rows: number): Promise<void> {
    let client: SidecarClient;
    let plan: LaunchPlan;
    try {
      client = await this.host.sidecar();
      plan = this.host.planLaunch(this.cwd, this.options);
      this.engine = this.createEngine(cols, rows);
    } catch (e) {
      this.failed(`Could not start the terminal: ${(e as Error).message}`);
      return;
    }
    this.cols = cols;
    this.rows = rows;
    this.engine.setMetrics(this.metrics);
    this.engine.resize(cols, rows, this.metrics);
    this.sidecarClient = client;
    this.sessionId = client.allocateId();
    this.cwd = plan.cwd;
    const cfg = gty();
    this.host.log.info(`Session ${this.sessionId}: ${plan.shell.command} ${JSON.stringify(plan.shell.args)} in ${plan.cwd} (shell integration ${plan.shellIntegration ? 'on' : 'off'})`);
    if (this.webviewReady) this.attachWebview();
    if (this.restored) this.notice('Session restarted after reload');
    client.spawnSession(
      this.sessionId,
      {
        command: plan.shell.command,
        args: plan.shell.args,
        env: plan.env,
        cwd: plan.cwd,
        cols,
        rows,
        ...this.pixels(cols, rows),
        window: cfg.get<number>('flowControlWindow', 262144),
        replayLimit: cfg.get<number>('replayBufferSize', 2 * 1024 * 1024),
      },
      this,
    );
    this.spawned = true;
    this.persist();
    if (this.pendingResize) {
      const r = this.pendingResize;
      this.pendingResize = undefined;
      await this.onResize(r.cols, r.rows);
    }
  }

  private failed(message: string): void {
    this.exited = true;
    this.host.log.error(message);
    this.post({ type: 'exit', message });
    this.resolvePid();
  }

  /** A dim line written into the stream of both engines. */
  private notice(text: string): void {
    this.engine?.inject(`\x1b[2m──── ${text} ────\x1b[0m\r\n`);
  }

  // ---- sidecar -> host ---------------------------------------------------

  onSpawned(pid: number | null): void {
    this.shellPid = pid ?? undefined;
    this.resolvePid();
  }

  onOutput(data: Uint8Array): void {
    if (this.engine) this.engine.push(data);
    else this.sidecarClient?.ack(this.sessionId, data.length);
  }

  onReplay(data: Uint8Array): void {
    // The host engine keeps the state now; the sidecar's raw replay is only a
    // fallback if the engine is lost, which this version never asks for.
    void data;
  }

  private forward(data: Uint8Array, fromPty: boolean): void {
    const canDraw = this.webviewReady && this.attached && (this.panel.visible || gty().get<boolean>('retainContextWhenHidden', true));
    if (!canDraw) {
      // Nobody can draw it now: acknowledge it ourselves so the program runs
      // on. The next webview starts from a snapshot that includes it.
      if (fromPty && this.spawned) this.sidecarClient?.ack(this.sessionId, data.length);
      if (this.attached && !this.panel.visible) this.detachWebview();
      return;
    }
    if (fromPty) this.inflight += data.length;
    void this.panel.webview.postMessage({ type: 'output', data, ack: fromPty } satisfies HostToWebview);
  }

  onExit(exit: ExitMsg): void {
    if (this.exited) return;
    this.exited = true;
    this.resolvePid();
    this.endProgress();
    if (exit.code === 0 && !this.killedByUser) {
      this.panel.dispose();
      return;
    }
    const why = exit.signal ? `was terminated by signal ${exit.signal}` : exit.code === null ? 'stopped' : `exited with code ${exit.code}`;
    const message = `The terminal process ${why}. Press any key to close the tab.`;
    if (this.engine) this.engine.inject(`\r\n\x1b[2m${message}\x1b[0m\r\n`);
    this.post({ type: 'exit', message });
  }

  onError(message: string): void {
    this.host.log.error(`Session ${this.sessionId}: ${message}`);
    if (!this.spawned || /stopped/.test(message)) this.notice(message);
  }

  onProcessInfo(info: ProcessInfoMsg): void {
    this.processName = info.name ?? undefined;
    if (info.busy !== null) this.busy = info.busy;
    this.updateTitle();
    for (const w of this.processWaiters.splice(0)) w();
  }

  // ---- effects -----------------------------------------------------------

  private onSemanticPrompt(ev: SemanticPromptEvent): void {
    if (ev.kind === 'outputStart' && process.platform === 'win32') this.busy = true;
    if (ev.kind === 'commandEnd') {
      this.lastExitCode = ev.exitCode;
      if (process.platform === 'win32') this.busy = false;
    }
    if (ev.kind === 'promptStart') {
      this.sawPrompt = true;
      if (process.platform === 'win32') this.busy = false;
      // A new prompt ends whatever a program said it was doing (OSC 7501 rules).
      let changed = false;
      for (const [id, r] of this.status) {
        if (r.state === 'working' || r.state === 'blocked' || r.state === 'idle') {
          this.status.delete(id);
          changed = true;
        }
      }
      if (changed) this.host.onStatusChanged(this);
    }
  }

  private wantsNotification(): boolean {
    const mode = gty().get<string>('notifications', 'unfocused');
    if (mode === 'off') return false;
    if (mode === 'always') return true;
    return !(this.panel.active && vscode.window.state.focused);
  }

  private notify(title: string, body: string): void {
    if (!this.wantsNotification()) return;
    const text = [sanitize(title), sanitize(body, 500)].filter(Boolean).join(': ');
    if (!text) return;
    void vscode.window.showInformationMessage(`${this.title}: ${text}`, 'Show Terminal').then((c) => {
      if (c) this.panel.reveal(undefined, false);
    });
  }

  private onProgress(state: ProgressState, percent: number): void {
    if (!gty().get<boolean>('progress', true)) return;
    if (state === 'remove') {
      this.endProgress();
      return;
    }
    const message = state === 'error' ? 'failed' : state === 'pause' ? 'paused' : percent >= 0 ? `${percent}%` : '';
    if (!this.progress) {
      let done!: () => void;
      let report!: (m: string) => void;
      const finished = new Promise<void>((r) => (done = r));
      void vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: this.title }, (p) => {
        report = (m) => p.report({ message: m });
        return finished;
      });
      this.progress = { state, percent, done, report: (m) => report?.(m) };
    }
    this.progress.state = state;
    this.progress.percent = percent;
    this.progress.report(message);
    this.updateTitle();
  }

  private endProgress(): void {
    if (!this.progress) return;
    this.progress.done();
    this.progress = undefined;
    this.updateTitle();
  }

  private onProgramStatus(r: ProgramStatusReport): void {
    if (r.state === 'clear') {
      for (const id of [...this.status.keys()]) if (!r.id || id === r.id || id.startsWith(`${r.id}/`)) this.status.delete(id);
    } else {
      this.status.set(r.id, { ...r, app: sanitize(r.app, 64), title: sanitize(r.title), message: sanitize(r.message, 300), updated: Date.now() });
      // Keep at most 256 records: drop the stalest.
      if (this.status.size > 256) {
        const oldest = [...this.status.entries()].sort((a, b) => a[1].updated - b[1].updated)[0];
        this.status.delete(oldest[0]);
      }
      if ((r.state === 'blocked' || r.state === 'done' || r.state === 'error') && this.wantsNotification()) {
        const what = r.state === 'blocked' ? 'needs you' : r.state === 'done' ? 'finished' : 'failed';
        this.notify(`${r.app || 'A program'} ${what}`, r.message);
      }
    }
    this.host.onStatusChanged(this);
  }

  /** `done` and `error` records are kept until the user has seen the terminal. */
  private clearSeenStatus(): void {
    let changed = false;
    for (const [id, r] of this.status) {
      if (r.state === 'done' || r.state === 'error') {
        this.status.delete(id);
        changed = true;
      }
    }
    if (changed) this.host.onStatusChanged(this);
  }

  /** Called when VS Code's colour theme changes: programs that asked (mode 2031) get a report. */
  colorSchemeChanged(dark: boolean): void {
    const e = this.engine;
    if (!e || !this.spawned || this.exited) return;
    if (e.term.getMode(Modes.REPORT_COLOR_SCHEME)) this.sidecarClient?.input(this.sessionId, `\x1b[?997;${dark ? 1 : 2}n`);
  }

  // ---- actions -----------------------------------------------------------

  /** Pastes through the host engine, which applies bracketed paste and Kitty paste events. */
  async paste(text: string): Promise<void> {
    const e = this.engine;
    if (!text || !e || !this.spawned || this.exited) return;
    const warn = vscode.workspace.getConfiguration('terminal.integrated').get<string | boolean>('enableMultiLinePasteWarning', 'auto');
    const confirm = async () => {
      const lines = text.split(/\r?\n/).length;
      const choice = await vscode.window.showWarningMessage(
        lines > 1 ? `Paste ${lines} lines into the terminal?` : 'The text could run commands in the terminal. Paste it?',
        { modal: true },
        'Paste',
      );
      return choice === 'Paste';
    };
    if (warn === 'never' || warn === false) {
      e.paste(text, true);
    } else if ((warn === 'always' || warn === true) && isMultiline(text)) {
      if (await confirm()) e.paste(text, true);
    } else if (e.paste(text, false) === 'rejected') {
      // 'auto': the engine refuses text that could inject commands given the
      // program's paste mode, e.g. a newline without bracketed paste.
      if (await confirm()) e.paste(text, true);
    }
    this.post({ type: 'focus' });
  }

  sendText(text: string, addNewLine = true): void {
    if (!this.spawned || this.exited) return;
    this.sidecarClient?.input(this.sessionId, encoder.encode(addNewLine ? `${text}\r` : text));
  }

  clear(): void {
    this.engine?.clear();
  }

  /** Recent output as plain text, from the host engine. */
  recentOutput(lines = 500): Promise<string> {
    return Promise.resolve(this.engine?.text(lines) ?? '');
  }

  screenText(): string {
    return this.engine?.screenText() ?? '';
  }

  lastCommandOutput(): string | undefined {
    return this.engine?.lastCommandOutput();
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
    this.endProgress();
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

  private disposeEngine(): void {
    this.engine?.dispose();
    this.engine = undefined;
  }

  private async onPanelDisposed(): Promise<void> {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.webviewReady = false;
    this.detachWebview();
    if (!this.exited && this.spawned) {
      // A webview tab cannot veto its own closing, so confirm afterwards and
      // offer to bring the tab back with its session intact.
      await this.refreshProcess();
      const confirm = vscode.workspace.getConfiguration('terminal.integrated').get<string>('confirmOnKill', 'editor');
      const ask = confirm === 'always' || confirm === 'editor';
      // When the sidecar cannot tell, shell integration can: the engine knows
      // whether the cursor sits at a prompt.
      const running = this.busy === true || (this.busy === undefined && this.sawPrompt && !(this.engine?.cursorAtPrompt ?? true));
      if (ask && running) {
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
    this.disposeEngine();
    this.status.clear();
    // Close first: the status bar update looks at the remaining panels.
    this.host.onSessionClosed(this);
    this.host.onStatusChanged(this);
  }
}
