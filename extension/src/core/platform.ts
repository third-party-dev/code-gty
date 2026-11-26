// What a terminal session needs from the program hosting it. The VS Code
// extension (src/session.ts) and the native app (native/) each implement
// these, so both run the same session code (core/session.ts) and behave the
// same. No `vscode` or Node imports.

import type { HostToWebview, WebviewConfig } from '../shared/messages';
import type { Platform as KeyPlatform } from '../shared/keys';

export interface Disposable {
  dispose(): void;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** A button in a message. */
export interface MessageItem {
  title: string;
}

/** The terminal page (a VS Code webview panel, or a tab in the native window). */
export interface TerminalView {
  readonly active: boolean;
  readonly visible: boolean;
  /** The tab title. */
  title: string;
  post(msg: HostToWebview): void;
  /** Shows the tab and gives it focus. */
  reveal(): void;
  /** Closes the tab. */
  dispose(): void;
  onMessage(fn: (raw: unknown) => void): Disposable;
  /** Called when the view becomes active or inactive, visible or hidden. */
  onViewState(fn: (state: { active: boolean; visible: boolean }) => void): Disposable;
  onDispose(fn: () => void): Disposable;
}

/** The shell to start, its environment and directory. */
export interface LaunchPlan {
  shell: { command: string; args: string[] };
  env: Record<string, string>;
  cwd: string;
  shellIntegration: boolean;
}

export interface Platform {
  /** The OS the shells run on. */
  readonly os: KeyPlatform;
  /** A `codeGty.*` setting. */
  setting<T>(key: string, fallback: T): T;
  /** A `terminal.integrated.*` setting (the native app has its own equivalents). */
  terminalSetting<T>(key: string, fallback: T): T;
  /** Everything the terminal page needs to draw and handle keys. */
  webviewConfig(): WebviewConfig;
  readonly workspaceName: string | undefined;
  readonly log: Logger;
  readonly clipboard: { readText(): Promise<string>; writeText(text: string): Promise<void> };
  /** Whether the window has OS focus. */
  windowFocused(): boolean;
  colorScheme(): 'light' | 'dark';
  /** Shows a message; resolves with the button chosen, undefined when dismissed. */
  showMessage<T extends MessageItem>(level: 'info' | 'warning', text: string, options: { modal?: boolean }, ...items: T[]): Promise<T | undefined>;
  /** Shows that something is in progress (the status bar in VS Code) until `done`. */
  progress(title: string): { report(message: string): void; done(): void };
  openLink(kind: 'url' | 'file', text: string, cwd: string | undefined): Promise<void>;
}
