// API exported to other extensions: `vscode.extensions.getExtension('code-gty.code-gty').exports`.
// It stands in for what `window.terminals` and `environmentVariableCollection`
// cannot provide for a webview terminal.

import * as vscode from 'vscode';
import type { TerminalManager } from './manager';
import type { TerminalSession } from './session';

export interface GtyTerminalOptions {
  name?: string;
  cwd?: string;
  env?: Record<string, string | null>;
  shellPath?: string;
  shellArgs?: string[];
  viewColumn?: vscode.ViewColumn;
  preserveFocus?: boolean;
}

export interface GtyTerminal {
  readonly name: string;
  readonly processId: Thenable<number | undefined>;
  /** Last directory reported by shell integration (OSC 7), if any. */
  readonly cwd: string | undefined;
  /** Exit code of the last command (OSC 133;D), if the shell reported one. */
  readonly lastExitCode: number | undefined;
  /** The visible screen as plain text. */
  readScreen(): string;
  /** Screen and scrollback as plain text (last `lines` lines). */
  readOutput(lines?: number): Thenable<string>;
  /** Output of the most recent command, when shell integration marks commands. */
  lastCommandOutput(): string | undefined;
  sendText(text: string, addNewLine?: boolean): void;
  show(preserveFocus?: boolean): void;
  dispose(): void;
}

export interface CodeGtyApi {
  readonly version: 1;
  readonly terminals: readonly GtyTerminal[];
  readonly activeTerminal: GtyTerminal | undefined;
  readonly onDidOpenTerminal: vscode.Event<GtyTerminal>;
  readonly onDidCloseTerminal: vscode.Event<GtyTerminal>;
  createTerminal(options?: GtyTerminalOptions): GtyTerminal | undefined;
  /** Environment for terminals started from now on; `null` removes a variable. Dispose to withdraw. */
  contributeEnvironment(key: string, variables: Record<string, string | null>): vscode.Disposable;
  /**
   * OSC sequences the terminal does not implement (for example a custom
   * `ESC ] 7400 ; ... ST`), with the OSC number as `id`. `content` is
   * everything after `ESC ]`, raw. APC sequences come with `id` 'apc'.
   */
  readonly onDidReceiveSequence: vscode.Event<{ terminal: GtyTerminal; id: string; content: Uint8Array }>;
}

export function createApi(manager: TerminalManager): CodeGtyApi {
  const wrappers = new WeakMap<TerminalSession, GtyTerminal>();
  const wrap = (s: TerminalSession): GtyTerminal => {
    let w = wrappers.get(s);
    if (!w) {
      w = {
        get name() {
          return s.title;
        },
        get processId() {
          return s.processId();
        },
        get cwd() {
          return s.cwd;
        },
        get lastExitCode() {
          return s.lastExitCode;
        },
        readScreen: () => s.screenText(),
        readOutput: (lines) => s.recentOutput(lines),
        lastCommandOutput: () => s.lastCommandOutput(),
        sendText: (text, addNewLine = true) => s.sendText(text, addNewLine),
        show: (preserveFocus) => s.panel.reveal(undefined, preserveFocus),
        dispose: () => s.panel.dispose(),
      };
      wrappers.set(s, w);
    }
    return w;
  };
  const mapEvent = (e: vscode.Event<TerminalSession>): vscode.Event<GtyTerminal> => (listener, thisArgs, disposables) =>
    e((s) => listener.call(thisArgs, wrap(s)), undefined, disposables);

  return {
    version: 1,
    get terminals() {
      return manager.all.map(wrap);
    },
    get activeTerminal() {
      const s = manager.activeSession;
      return s ? wrap(s) : undefined;
    },
    onDidOpenTerminal: mapEvent(manager.onDidOpen),
    onDidCloseTerminal: mapEvent(manager.onDidClose),
    createTerminal(options = {}) {
      const s = manager.create(options, options.viewColumn ?? vscode.ViewColumn.Active, options.preserveFocus);
      return s ? wrap(s) : undefined;
    },
    contributeEnvironment: (key, variables) => manager.contributeEnvironment(key, variables),
    onDidReceiveSequence: (listener, thisArgs, disposables) =>
      manager.onDidReceiveSequence(
        ({ session, sequence }) => {
          const content = sequence.content;
          let id = 'apc';
          if (sequence.kind === 'osc') {
            const semi = content.indexOf(0x3b);
            id = new TextDecoder().decode(semi < 0 ? content : content.subarray(0, semi));
          }
          listener.call(thisArgs, { terminal: wrap(session), id, content });
        },
        undefined,
        disposables,
      ),
  };
}
