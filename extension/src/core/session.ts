// One terminal tab: a view (a VS Code webview panel, or a tab of the native
// app) bound to a sidecar session, with the authoritative libghostty-vt
// engine in between. Shared by both hosts; what differs between them is
// behind `Platform` and `TerminalView` (./platform.ts).
//
//   sidecar --output--> HostEngine --same bytes, in order--> page mirror
//                          |  replies, paste --> sidecar
//                          +- effects --> the platform (title, cwd, clipboard,
//                                         notifications, progress, status)
//
// Flow control: the sidecar stops after a window of unacknowledged bytes.
// Bytes forwarded to a webview are acknowledged when the webview has parsed
// them; with no webview to draw them, the host acknowledges them itself and
// the next webview starts from a snapshot of the host engine.

import { Vt } from '../../vt/core';
import { loadVtSync } from '../../vt/loader';
import type { ProgramStatusReport, ProgressState, SemanticPromptEvent, UnknownSequence } from '../../vt/terminal';
import { Modes } from '../../vt/terminal';
import { EngineOptions, HostEngine } from '../engine/hostEngine';
import type { KittyNotification, KittyOutcome } from '../engine/kittyNotify';
import { parseFileUri } from '../fileUri';
import { ExitMsg, ProcessInfoMsg } from '../protocol';
import { isMultiline } from '../shared/paste';
import { HostToWebview, parseWebviewMessage, PersistedState, WebviewToHost } from '../shared/messages';
import type { Disposable, LaunchPlan, Logger, MessageItem, Platform, TerminalView } from './platform';
import type { SessionListener, SidecarClient } from './sidecarClient';

export interface SessionHost {
  readonly platform: Platform;
  /** Reported in XTVERSION. */
  readonly extensionVersion: string;
  readonly log: Logger;
  sidecar(): Promise<SidecarClient>;
  vtModule(): WebAssembly.Module;
  planLaunch(cwd: string | undefined, opts: CreateOptions): LaunchPlan;
  onSessionFocused(s: TerminalSession): void;
  onSessionClosed(s: TerminalSession): void;
  onSequence(s: TerminalSession, seq: UnknownSequence): void;
  onStatusChanged(s: TerminalSession): void;
  reopen(s: TerminalSession): void;
  /** VS Code is closing or reloading the window: sessions must be left running. */
  readonly shuttingDown: boolean;
}

export interface CreateOptions {
  name?: string;
  cwd?: string;
  env?: Record<string, string | null>;
  shellPath?: string;
  shellArgs?: string[];
  /** Reattach to this sidecar session (a restored or moved tab) instead of starting a shell. */
  claim?: number;
}

const encoder = new TextEncoder();

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
  /** Set by ConEmu OSC 9;3; wins over the window title (OSC 0/2) until reset. */
  private tabTitle: string | undefined;
  private processName: string | undefined;
  private busy: boolean | undefined;
  private shellPid: number | undefined;
  private pendingResize: { cols: number; rows: number } | undefined;
  private disposables: Disposable[] = [];
  private pidWaiters: ((pid: number | undefined) => void)[] = [];
  private processWaiters: (() => void)[] = [];
  private progress: { state: ProgressState; percent: number; done: () => void; report: (m: string) => void } | undefined;
  /** OSC 7501 records by id. */
  readonly status = new Map<string, ProgramStatusReport & { updated: number }>();
  lastExitCode: number | undefined;
  private sawPrompt = false;
  cwd: string | undefined;
  renamed: string | undefined;

  protected readonly platform: Platform;
  view!: TerminalView;

  constructor(
    private readonly host: SessionHost,
    view: TerminalView,
    readonly number: number,
    private readonly options: CreateOptions,
    private readonly restored: boolean,
  ) {
    this.platform = host.platform;
    this.cwd = options.cwd;
    this.renamed = options.name;
    this.bindView(view);
  }

  // ---- view wiring -------------------------------------------------------

  /** Shows the session in this view (a new tab, or the same tab reopened). */
  bindView(view: TerminalView): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.detachWebview();
    this.view = view;
    this.webviewReady = false;
    this.updateTitle();
    this.disposables.push(
      view.onMessage((m) => void this.onMessage(m)),
      view.onViewState((e) => {
        if (e.active) {
          this.host.onSessionFocused(this);
          this.post({ type: 'focus' });
          this.clearSeenStatus();
        }
        // Without retainContextWhenHidden a hidden webview is destroyed; its
        // replacement will say 'ready' and get a snapshot.
        if (!e.visible && !this.setting('retainContextWhenHidden', true)) {
          this.webviewReady = false;
          this.detachWebview();
        }
      }),
      view.onDispose(() => void this.onPanelDisposed()),
    );
  }

  private setting<T>(key: string, fallback: T): T {
    return this.platform.setting(key, fallback);
  }

  get title(): string {
    const base = this.renamed || this.tabTitle || this.sequenceTitle || (this.busy && this.processName) || `Ghostty ${this.number}`;
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
    this.view.post(msg);
  }

  pushConfig(): void {
    this.post({ type: 'config', config: this.platform.webviewConfig() });
    const e = this.engine;
    if (!e) return;
    e.setClipboardPolicy(this.clipboardPolicy());
    e.setScrollback(this.platform.webviewConfig().scrollback);
    e.setImages(this.setting<boolean>('images', true));
    e.setReplyStrings(this.xtversion(), this.setting<string>('answerback', ''));
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
        this.post({ type: 'init', config: this.platform.webviewConfig(), restored: this.restored && !recreated });
        this.persist();
        // A webview recreated for a running session starts from a snapshot.
        if (this.engine) this.attachWebview();
        if (this.view.active) this.post({ type: 'focus' });
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
          this.view.dispose();
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
        await this.platform.clipboard.writeText(msg.text);
        break;
      case 'paste':
        await this.paste(msg.text ?? (await this.platform.clipboard.readText()));
        break;
      case 'openLink':
        await this.platform.openLink(msg.kind, msg.text, this.cwd);
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
      if (this.options.claim) await this.claimOrSpawn(cols, rows);
      else await this.spawn(cols, rows);
    } finally {
      this.spawning = false;
    }
  }

  /**
   * Reattaches to a session the sidecar daemon kept (after a reload, or from
   * another window). Its state comes back as a snapshot; if the session is
   * gone, a new shell starts instead.
   */
  private async claimOrSpawn(cols: number, rows: number): Promise<void> {
    const id = this.options.claim!;
    this.options.claim = undefined;
    let client: SidecarClient;
    try {
      client = await this.host.sidecar();
    } catch (e) {
      this.failed(`Could not start the terminal: ${(e as Error).message}`);
      return;
    }
    // Frames that follow `claimed` can arrive before the engine exists.
    this.claiming = { output: [] };
    const got = client.persistent ? await client.claim(id, this) : undefined;
    const early = this.claiming;
    this.claiming = undefined;
    if (!got) {
      this.host.log.info(`Session ${id} is gone; starting a new shell`);
      await this.spawn(cols, rows);
      return;
    }
    this.sidecarClient = client;
    this.sessionId = id;
    try {
      this.engine = this.createEngine(got.cols, got.rows, got.exact ? got.data : undefined);
    } catch (e) {
      this.host.log.error(`Session ${id}: snapshot restore failed: ${(e as Error).message}`);
      this.engine = this.createEngine(got.cols, got.rows);
    }
    // Raw recent output (no exact state): written straight into the engine,
    // because the sidecar already counts it as delivered.
    if (!got.exact && got.data.length) this.engine.term.write(got.data);
    for (const d of early.output) this.engine.push(d);
    this.cols = got.cols;
    this.rows = got.rows;
    this.engine.setMetrics(this.metrics);
    this.shellPid = got.pid ?? undefined;
    this.cwd = got.meta?.cwd ?? this.cwd;
    this.renamed = this.renamed ?? got.meta?.name;
    this.sequenceTitle = this.engine.title.trim() || undefined;
    this.spawned = true;
    this.resolvePid();
    this.host.log.info(`Session ${id}: reattached (${got.exact ? 'exact snapshot' : 'recent output only'}${got.exited ? ', exited' : ''})`);
    this.updateTitle();
    if (this.webviewReady) this.attachWebview();
    this.persist();
    // Fit the session to this window.
    const want = this.pendingResize ?? { cols, rows };
    this.pendingResize = undefined;
    if (early.exit) this.onExit(early.exit);
    else if (want.cols !== this.cols || want.rows !== this.rows) await this.onResize(want.cols, want.rows);
  }

  // ---- checkpoints (daemon mode) -------------------------------------------------

  /** PTY bytes the engine has consumed since this window got the session. */
  private consumed = 0;
  private checkpointTimer: ReturnType<typeof setTimeout> | undefined;
  private lastCheckpoint = 0;
  /** Another window has this session now. */
  private movedAway = false;
  private claiming: { output: Uint8Array[]; exit?: ExitMsg } | undefined;

  /**
   * Sends the engine's state to the sidecar after output settles (and at
   * least every 30 s while it does not), so the session can be restored
   * exactly if this window goes away.
   */
  private scheduleCheckpoint(): void {
    if (!this.sidecarClient?.persistent || this.exited) return;
    clearTimeout(this.checkpointTimer);
    const due = Math.max(0, Math.min(1000, this.lastCheckpoint + 30000 - Date.now()));
    this.checkpointTimer = setTimeout(() => this.checkpointNow(), due);
  }

  /** The sidecar session id (stable across reloads in daemon mode). */
  get id(): number {
    return this.sessionId;
  }

  /** Saves the state for the next window (called when this one shuts down). */
  checkpointNow(): void {
    const e = this.engine;
    if (!e || !this.spawned || this.exited || !this.sidecarClient) return;
    if (!e.settled) {
      this.scheduleCheckpoint();
      return;
    }
    try {
      const meta = { title: this.title, cwd: this.cwd, name: this.renamed, scrollback: this.platform.webviewConfig().scrollback, workspace: this.platform.workspaceName };
      this.sidecarClient.checkpoint(this.sessionId, this.consumed, meta, e.snapshot());
      this.lastCheckpoint = Date.now();
    } catch (err) {
      this.host.log.warn(`Session ${this.sessionId}: checkpoint failed: ${(err as Error).message}`);
    }
  }

  /** Another window claimed this session (daemon mode). */
  onDetached(): void {
    if (this.exited) return;
    this.exited = true;
    this.movedAway = true;
    clearTimeout(this.checkpointTimer);
    this.endProgress();
    const message = 'This terminal was opened in another window. Press any key to close the tab.';
    this.engine?.inject(`\r\n\x1b[2m${message}\x1b[0m\r\n`);
    this.post({ type: 'exit', message });
  }

  private xtversion(): string {
    return `code-gty ${this.host.extensionVersion} (libghostty-vt ${this.vt?.version ?? '?'})`;
  }

  private clipboardPolicy(): EngineOptions['clipboard'] {
    const v = this.setting<string>('osc52', 'write');
    return v === 'off' || v === 'readWrite' ? v : 'write';
  }

  private createEngine(cols: number, rows: number, restore?: Uint8Array): HostEngine {
    const cfg = this.platform.webviewConfig();
    this.vt = loadVtSync(this.host.vtModule(), { log: (l) => this.host.log.info(`[vt ${this.number}] ${l}`) });
    const opts: EngineOptions = {
      cols,
      rows,
      scrollbackLines: cfg.scrollback,
      colors: this.theme ?? {},
      cursorStyle: cfg.cursorStyle,
      cursorBlink: cfg.cursorBlink,
      xtversion: this.xtversion(),
      answerback: this.setting<string>('answerback', ''),
      clipboard: this.clipboardPolicy(),
      images: cfg.images,
      restore,
    };
    const engine = new HostEngine(this.vt, opts, {
      writePty: (d) => {
        if (this.spawned && !this.exited) this.sidecarClient?.input(this.sessionId, d);
      },
      forward: (d, fromPty) => this.forward(d, fromPty),
      // Sixel and iTerm2 images: decoded in the sidecar, drawn as Kitty graphics.
      decodeImage: (req) => (this.sidecarClient && !this.exited ? this.sidecarClient.decode(this.sessionId, req) : Promise.resolve(undefined)),
      dropped: (n) => {
        if (this.spawned && n) this.sidecarClient?.ack(this.sessionId, n);
        this.consumed += n;
        this.scheduleCheckpoint();
      },
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
      clipboardWrite: (text) => void this.platform.clipboard.writeText(text),
      clipboardRead: async () => this.platform.clipboard.readText(),
      notification: (title, body) => this.notify(title, body),
      tabTitle: (t) => {
        this.tabTitle = t === undefined ? undefined : sanitize(t).trim() || undefined;
        this.updateTitle();
      },
      messageBox: (text) => this.messageBox(text),
      showNotification: (n) => this.showKittyNotification(n),
      focusTerminal: () => this.view.reveal(),
      progress: (state, pct) => this.onProgress(state, pct),
      programStatus: (r) => this.onProgramStatus(r),
      semanticPrompt: (ev) => this.onSemanticPrompt(ev),
      reset: () => {
        this.sequenceTitle = undefined;
        this.tabTitle = undefined;
        this.status.clear();
        this.host.onStatusChanged(this);
        this.updateTitle();
      },
      unknownSequence: (seq) => this.host.onSequence(this, seq),
      colorScheme: () => this.platform.colorScheme(),
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
        window: this.setting<number>('flowControlWindow', 262144),
        replayLimit: this.setting<number>('replayBufferSize', 2 * 1024 * 1024),
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
    if (this.claiming) this.claiming.output.push(data);
    else if (this.engine) this.engine.push(data);
    else this.sidecarClient?.ack(this.sessionId, data.length);
  }

  onReplay(data: Uint8Array): void {
    // The host engine keeps the state now; the sidecar's raw replay is only a
    // fallback if the engine is lost, which this version never asks for.
    void data;
  }

  private forward(data: Uint8Array, fromPty: boolean): void {
    if (fromPty) {
      this.consumed += data.length;
      this.scheduleCheckpoint();
    }
    const canDraw = this.webviewReady && this.attached && (this.view.visible || this.setting<boolean>('retainContextWhenHidden', true));
    if (!canDraw) {
      // Nobody can draw it now: acknowledge it ourselves so the program runs
      // on. The next webview starts from a snapshot that includes it.
      if (fromPty && this.spawned) this.sidecarClient?.ack(this.sessionId, data.length);
      if (this.attached && !this.view.visible) this.detachWebview();
      return;
    }
    if (fromPty) this.inflight += data.length;
    this.view.post({ type: 'output', data, ack: fromPty });
  }

  onExit(exit: ExitMsg): void {
    if (this.claiming) {
      this.claiming.exit = exit;
      return;
    }
    if (this.exited) return;
    this.exited = true;
    this.resolvePid();
    this.endProgress();
    if (exit.code === 0 && !this.killedByUser) {
      this.view.dispose();
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
    if (ev.kind === 'outputStart' && this.platform.os === 'windows') this.busy = true;
    if (ev.kind === 'commandEnd') {
      this.lastExitCode = ev.exitCode;
      if (this.platform.os === 'windows') this.busy = false;
    }
    if (ev.kind === 'promptStart') {
      this.sawPrompt = true;
      if (this.platform.os === 'windows') this.busy = false;
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
    const mode = this.setting<string>('notifications', 'unfocused');
    if (mode === 'off') return false;
    if (mode === 'always') return true;
    return !(this.view.active && this.platform.windowFocused());
  }

  private notify(title: string, body: string): void {
    if (!this.wantsNotification()) return;
    const text = [sanitize(title), sanitize(body, 500)].filter(Boolean).join(': ');
    if (!text) return;
    void this.platform.showMessage('info', `${this.title}: ${text}`, {}, { title: 'Show Terminal' }).then((c) => {
      if (c) this.view.reveal();
    });
  }

  /**
   * ConEmu's message box, as a VS Code message. Shown even when the tab has
   * focus (the program asked for it explicitly), but not when notifications
   * are off.
   */
  private messageBox(text: string): void {
    if (this.setting<string>('notifications', 'unfocused') === 'off') return;
    const body = sanitize(text, 500);
    if (!body) return;
    void this.platform.showMessage('info', `${this.title}: ${body}`, {}, { title: 'Show Terminal' }).then((c) => {
      if (c) this.view.reveal();
    });
  }

  /**
   * Kitty OSC 99. Shown when both the program's occasion and
   * `codeGty.notifications` allow it. VS Code has no click on the message
   * itself, so Show Terminal stands for activating it.
   */
  private showKittyNotification(n: KittyNotification): Promise<KittyOutcome> | undefined {
    if (!this.wantsNotification()) return undefined;
    const focused = this.view.active && this.platform.windowFocused();
    if (n.occasion === 'unfocused' && focused) return undefined;
    if (n.occasion === 'invisible' && this.view.visible && this.platform.windowFocused()) return undefined;
    const text = [sanitize(n.title), sanitize(n.body, 500)].filter(Boolean).join(': ');
    if (!text) return undefined;
    type Item = MessageItem & { index: number };
    // Program button numbers are 1-based; 0 is Show Terminal.
    const items: Item[] = n.buttons.map((b, i) => ({ title: sanitize(b, 40), index: i + 1 })).filter((b) => b.title);
    items.push({ title: 'Show Terminal', index: 0 });
    const message = `${this.title}: ${text}`;
    return this.platform.showMessage(n.urgency === 'critical' ? 'warning' : 'info', message, {}, ...items).then((choice): KittyOutcome => {
      if (!choice) return { kind: 'closed' };
      return choice.index === 0 ? { kind: 'activated' } : { kind: 'button', index: choice.index };
    });
  }

  private onProgress(state: ProgressState, percent: number): void {
    if (!this.setting<boolean>('progress', true)) return;
    if (state === 'remove') {
      this.endProgress();
      return;
    }
    const message = state === 'error' ? 'failed' : state === 'pause' ? 'paused' : percent >= 0 ? `${percent}%` : '';
    if (!this.progress) {
      const p = this.platform.progress(this.title);
      this.progress = { state, percent, done: () => p.done(), report: (m) => p.report(m) };
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
    const warn = this.platform.terminalSetting<string | boolean>('enableMultiLinePasteWarning', 'auto');
    const confirm = async () => {
      const lines = text.split(/\r?\n/).length;
      const choice = await this.platform.showMessage(
        'warning',
        lines > 1 ? `Paste ${lines} lines into the terminal?` : 'The text could run commands in the terminal. Paste it?',
        { modal: true },
        { title: 'Paste' },
      );
      return choice?.title === 'Paste';
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
    if (!this.spawned || this.exited || this.platform.os === 'windows') return Promise.resolve();
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
    this.view.title = this.title;
  }

  private persist(): void {
    const state: PersistedState = {
      cwd: this.cwd,
      title: this.title,
      renamed: this.renamed,
      // Lets the restored tab reclaim its session after a reload.
      sessionId: this.spawned && this.sidecarClient?.persistent && !this.exited ? this.sessionId : undefined,
    };
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
    clearTimeout(this.checkpointTimer);
    if (this.sidecarClient?.persistent && !this.exited && this.spawned) {
      // A window that is closing or reloading disposes its panels too; its
      // sessions must live on. If this extension host is shutting down, it
      // is gone before the timer fires.
      await new Promise((r) => setTimeout(r, 250));
      if (this.host.shuttingDown) {
        this.checkpointNow();
        this.sidecarClient.forget(this.sessionId);
        this.disposeEngine();
        this.host.onSessionClosed(this);
        return;
      }
    }
    if (!this.exited && this.spawned) {
      // A webview tab cannot veto its own closing, so confirm afterwards and
      // offer to bring the tab back with its session intact.
      await this.refreshProcess();
      const confirm = this.platform.terminalSetting<string>('confirmOnKill', 'editor');
      const ask = confirm === 'always' || confirm === 'editor';
      // When the sidecar cannot tell, shell integration can: the engine knows
      // whether the cursor sits at a prompt.
      const running = this.busy === true || (this.busy === undefined && this.sawPrompt && !(this.engine?.cursorAtPrompt ?? true));
      if (ask && running) {
        const what = this.processName ? `"${this.processName}"` : 'A process';
        const choice = await this.platform.showMessage('warning', `${what} is still running in ${this.title}. Terminate it?`, { modal: true }, { title: 'Terminate' }, { title: 'Keep Running' });
        if (choice?.title !== 'Terminate') {
          this.host.reopen(this);
          return;
        }
      }
      this.kill();
    } else if (this.exited && this.spawned && !this.movedAway && this.sidecarClient?.persistent) {
      // The daemon keeps an exited session's status for the next window;
      // this tab has shown it, so let the daemon drop it.
      this.sidecarClient.kill(this.sessionId);
    }
    this.disposeEngine();
    this.status.clear();
    // Close first: the status bar update looks at the remaining panels.
    this.host.onSessionClosed(this);
    this.host.onStatusChanged(this);
  }
}
