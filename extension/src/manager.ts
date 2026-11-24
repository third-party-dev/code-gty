// Owns the sidecar process, the list of terminal tabs and the commands.

import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
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
  readonly extensionUri: vscode.Uri;

  constructor(
    private readonly context: vscode.ExtensionContext,
    readonly log: vscode.LogOutputChannel,
  ) {
    this.extensionUri = context.extensionUri;
    context.subscriptions.push(
      this.openEmitter,
      this.closeEmitter,
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
    for (const s of this.sessions) if (s.panel.active) return s;
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
