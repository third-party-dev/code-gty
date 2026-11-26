// The VS Code side of a terminal tab: the shared session (core/session.ts)
// shown in a webview panel, with VS Code providing settings, the clipboard,
// messages and progress.

import * as vscode from 'vscode';
import type { Disposable, MessageItem, Platform, TerminalView } from './core/platform';
import { SessionHost as CoreHost, TerminalSession as CoreSession, CreateOptions } from './core/session';
import { openLink } from './links';
import type { HostToWebview } from './shared/messages';
import { platformName, webviewConfig } from './terminalConfig';

export type { CreateOptions } from './core/session';

export interface SessionHost extends CoreHost {
  readonly extensionUri: vscode.Uri;
  renderHtml(webview: vscode.Webview): string;
}

/** VS Code as the session's platform. */
export function vscodePlatform(log: vscode.LogOutputChannel): Platform {
  return {
    os: platformName(),
    setting: <T>(key: string, fallback: T) => vscode.workspace.getConfiguration('codeGty').get<T>(key, fallback),
    terminalSetting: <T>(key: string, fallback: T) => vscode.workspace.getConfiguration('terminal.integrated').get<T>(key, fallback),
    webviewConfig,
    get workspaceName() {
      return vscode.workspace.name;
    },
    log,
    clipboard: {
      readText: async () => vscode.env.clipboard.readText(),
      writeText: async (text) => vscode.env.clipboard.writeText(text),
    },
    windowFocused: () => vscode.window.state.focused,
    colorScheme: () => {
      const k = vscode.window.activeColorTheme.kind;
      return k === vscode.ColorThemeKind.Light || k === vscode.ColorThemeKind.HighContrastLight ? 'light' : 'dark';
    },
    showMessage: <T extends MessageItem>(level: 'info' | 'warning', text: string, options: { modal?: boolean }, ...items: T[]) =>
      Promise.resolve(level === 'warning' ? vscode.window.showWarningMessage(text, options, ...items) : vscode.window.showInformationMessage(text, options, ...items)),
    progress: (title) => {
      let done!: () => void;
      let report: ((m: string) => void) | undefined;
      const finished = new Promise<void>((r) => (done = r));
      void vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, (p) => {
        report = (m) => p.report({ message: m });
        return finished;
      });
      return { report: (m) => report?.(m), done };
    },
    openLink,
  };
}

/** A webview panel as the session's view. */
class PanelView implements TerminalView {
  constructor(readonly panel: vscode.WebviewPanel) {}
  get active(): boolean {
    return this.panel.active;
  }
  get visible(): boolean {
    return this.panel.visible;
  }
  get title(): string {
    return this.panel.title;
  }
  set title(t: string) {
    this.panel.title = t;
  }
  post(msg: HostToWebview): void {
    void this.panel.webview.postMessage(msg);
  }
  reveal(): void {
    this.panel.reveal(undefined, false);
  }
  dispose(): void {
    this.panel.dispose();
  }
  onMessage(fn: (raw: unknown) => void): Disposable {
    return this.panel.webview.onDidReceiveMessage(fn);
  }
  onViewState(fn: (s: { active: boolean; visible: boolean }) => void): Disposable {
    return this.panel.onDidChangeViewState((e) => fn({ active: e.webviewPanel.active, visible: e.webviewPanel.visible }));
  }
  onDispose(fn: () => void): Disposable {
    return this.panel.onDidDispose(fn);
  }
}

function panelView(host: SessionHost, panel: vscode.WebviewPanel): PanelView {
  panel.iconPath = {
    light: vscode.Uri.joinPath(host.extensionUri, 'media', 'icon-light.svg'),
    dark: vscode.Uri.joinPath(host.extensionUri, 'media', 'icon-dark.svg'),
  };
  panel.webview.options = {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(host.extensionUri, 'media')],
  };
  panel.webview.html = host.renderHtml(panel.webview);
  return new PanelView(panel);
}

export class TerminalSession extends CoreSession {
  constructor(
    private readonly vsHost: SessionHost,
    panel: vscode.WebviewPanel,
    number: number,
    options: CreateOptions,
    restored: boolean,
  ) {
    super(vsHost, panelView(vsHost, panel), number, options, restored);
  }

  get panel(): vscode.WebviewPanel {
    return (this.view as PanelView).panel;
  }

  /** Shows the session in another panel (a closed tab brought back). */
  bindPanel(panel: vscode.WebviewPanel): void {
    this.bindView(panelView(this.vsHost, panel));
  }
}
