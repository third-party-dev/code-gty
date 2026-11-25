// Owns the sidecar process, the list of terminal tabs and the commands.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { UnknownSequence } from '../vt/terminal';
import { EnvPatch } from './env';
import { CreateOptions, SessionHost, TerminalSession } from './session';
import { SidecarClient } from './sidecar';
import { locateSidecar } from './sidecarBinary';
import { affectsWebview, LaunchPlan, planLaunch } from './terminalConfig';
import { renderTerminalHtml } from './html';
import { PersistedState } from './shared/messages';

export const VIEW_TYPE = 'codeGty.terminal';

export class TerminalManager implements SessionHost, vscode.WebviewPanelSerializer<PersistedState> {
  private client: SidecarClient | undefined;
  private starting: Promise<SidecarClient> | undefined;
  private readonly sessions = new Set<TerminalSession>();
  private active: TerminalSession | undefined;
  private readonly contributed = new Map<string, EnvPatch>();
  private readonly openEmitter = new vscode.EventEmitter<TerminalSession>();
  private readonly closeEmitter = new vscode.EventEmitter<TerminalSession>();
  readonly onDidOpen = this.openEmitter.event;
  readonly onDidClose = this.closeEmitter.event;
  private readonly sequenceEmitter = new vscode.EventEmitter<{ session: TerminalSession; sequence: UnknownSequence }>();
  /** OSC and APC sequences libghostty-vt does not implement, for other extensions. */
  readonly onDidReceiveSequence = this.sequenceEmitter.event;
  readonly extensionUri: vscode.Uri;
  readonly extensionVersion: string;
  private module: WebAssembly.Module | undefined;
  private readonly statusItem: vscode.StatusBarItem;

  constructor(
    private readonly context: vscode.ExtensionContext,
    readonly log: vscode.LogOutputChannel,
  ) {
    this.extensionUri = context.extensionUri;
    this.extensionVersion = String((context.extension?.packageJSON as { version?: string } | undefined)?.version ?? '0.0.0');
    this.statusItem = vscode.window.createStatusBarItem('codeGty.programStatus', vscode.StatusBarAlignment.Left, 50);
    this.statusItem.name = 'Ghostty Program Status';
    this.statusItem.command = 'codeGty.focus';
    context.subscriptions.push(
      this.openEmitter,
      this.closeEmitter,
      this.sequenceEmitter,
      this.statusItem,
      vscode.window.onDidChangeActiveColorTheme((t) => {
        const dark = t.kind === vscode.ColorThemeKind.Dark || t.kind === vscode.ColorThemeKind.HighContrast;
        for (const s of this.sessions) s.colorSchemeChanged(dark);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (affectsWebview(e)) for (const s of this.sessions) s.pushConfig();
      }),
      { dispose: () => this.dispose() },
    );
  }

  // ---- SessionHost -------------------------------------------------------

  sidecar(): Promise<SidecarClient> {
    if (this.client && !this.client.isDead) return Promise.resolve(this.client);
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const override = vscode.workspace.getConfiguration('codeGty').get<string | null>('sidecarPath');
      const bin = locateSidecar(this.context.extensionPath, override);
      if (!bin.verified) this.log.warn(`Using unverified sidecar at ${bin.path}`);
      const client = new SidecarClient(bin.path, {
        log: (line) => this.log.info(line),
        onDied: (reason) => {
          this.log.error(`Sidecar died: ${reason}`);
          if (this.client === client) this.client = undefined;
        },
      });
      const hello = await client.start();
      this.log.info(`Sidecar started: pid ${hello.pid}, build ${hello.build}, ${hello.os}`);
      this.client = client;
      return client;
    })();
    const clear = () => (this.starting = undefined);
    this.starting.then(clear, clear);
    return this.starting;
  }

  /** The libghostty-vt module, compiled once and instantiated per session. */
  vtModule(): WebAssembly.Module {
    if (!this.module) {
      const file = path.join(this.context.extensionPath, 'media', 'ghostty-vt.wasm');
      this.module = new WebAssembly.Module(fs.readFileSync(file));
    }
    return this.module;
  }

  onSequence(s: TerminalSession, sequence: UnknownSequence): void {
    this.sequenceEmitter.fire({ session: s, sequence });
  }

  /** Shows what the active terminal's program reports (OSC 7501) in the status bar. */
  onStatusChanged(s: TerminalSession): void {
    const active = this.activeSession;
    if (s !== active && active && this.sessions.has(s)) return;
    const records = active ? [...active.status.values()].sort((a, b) => b.updated - a.updated) : [];
    const r = records.find((x) => x.id === '') ?? records[0];
    if (!r) {
      this.statusItem.hide();
      return;
    }
    const icon = { idle: '$(circle-outline)', working: '$(sync~spin)', done: '$(check)', blocked: '$(bell)', error: '$(error)', clear: '' }[r.state];
    const pct = r.progress >= 0 ? ` ${r.progress}%` : '';
    this.statusItem.text = `${icon} ${r.app || active!.title}${pct}${r.message ? `: ${r.message.slice(0, 60)}` : ''}`;
    this.statusItem.tooltip = records.map((x) => `${x.id || x.app || 'program'}: ${x.state}${x.message ? ` — ${x.message}` : ''}`).join('\n');
    this.statusItem.show();
  }

  planLaunch(cwd: string | undefined, opts: CreateOptions): LaunchPlan {
    const env: EnvPatch = {};
    for (const patch of this.contributed.values()) Object.assign(env, patch);
    Object.assign(env, opts.env ?? {});
    return planLaunch(this.context.extensionPath, cwd, { shellPath: opts.shellPath, shellArgs: opts.shellArgs, env });
  }

  renderHtml(webview: vscode.Webview): string {
    const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', f)).toString();
    return renderTerminalHtml({ cspSource: webview.cspSource, nonce: crypto.randomBytes(16).toString('base64'), media });
  }

  onSessionFocused(s: TerminalSession): void {
    this.active = s;
    this.onStatusChanged(s);
  }

  onSessionClosed(s: TerminalSession): void {
    this.sessions.delete(s);
    if (this.active === s) this.active = [...this.sessions].pop();
    this.closeEmitter.fire(s);
  }

  reopen(s: TerminalSession): void {
    const panel = this.createPanel(s.title, vscode.ViewColumn.Active);
    s.bindPanel(panel);
    this.active = s;
  }

  // ---- WebviewPanelSerializer -------------------------------------------

  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: PersistedState | undefined): Promise<void> {
    // Version one: the sidecar lives with the extension host, so a reload
    // brings the tab back with a fresh shell in the same directory.
    if (!vscode.workspace.isTrusted) {
      panel.dispose();
      return;
    }
    const s = new TerminalSession(this, panel, this.nextNumber(), { cwd: state?.cwd, name: state?.renamed }, true);
    this.track(s);
  }

  // ---- public operations ------------------------------------------------

  create(opts: CreateOptions = {}, column: vscode.ViewColumn = vscode.ViewColumn.Active, preserveFocus = false): TerminalSession | undefined {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage('code-gty needs a trusted workspace, because a terminal runs code.', 'Manage Workspace Trust').then((c) => {
        if (c) void vscode.commands.executeCommand('workbench.trust.manage');
      });
      return undefined;
    }
    const number = this.nextNumber();
    const panel = this.createPanel(opts.name ?? `Ghostty ${number}`, column, preserveFocus);
    const s = new TerminalSession(this, panel, number, opts, false);
    this.track(s);
    return s;
  }

  get activeSession(): TerminalSession | undefined {
    for (const s of this.sessions) {
      try {
        if (s.panel.active) return s;
      } catch {
        // A panel that is being disposed throws on access.
      }
    }
    return this.active && this.sessions.has(this.active) ? this.active : undefined;
  }

  get all(): TerminalSession[] {
    return [...this.sessions];
  }

  contributeEnvironment(key: string, patch: EnvPatch): vscode.Disposable {
    this.contributed.set(key, patch);
    return new vscode.Disposable(() => this.contributed.delete(key));
  }

  async restartSidecar(): Promise<void> {
    this.client?.dispose();
    this.client = undefined;
    await this.sidecar();
  }

  private createPanel(title: string, column: vscode.ViewColumn, preserveFocus = false): vscode.WebviewPanel {
    const retain = vscode.workspace.getConfiguration('codeGty').get<boolean>('retainContextWhenHidden', true);
    return vscode.window.createWebviewPanel(VIEW_TYPE, title, { viewColumn: column, preserveFocus }, {
      enableScripts: true,
      retainContextWhenHidden: retain,
      enableFindWidget: false,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    });
  }

  private track(s: TerminalSession): void {
    this.sessions.add(s);
    this.active = s;
    this.openEmitter.fire(s);
  }

  private nextNumber(): number {
    const used = new Set([...this.sessions].map((s) => s.number));
    let n = 1;
    while (used.has(n)) n++;
    return n;
  }

  private dispose(): void {
    for (const s of this.sessions) s.kill();
    this.client?.dispose();
  }
}
