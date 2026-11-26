// The native app as the session's platform: settings from the settings file
// (VS Code's keys), the clipboard and links through Rust, messages in the
// window.

import { buildWebviewConfig, SettingsSection } from '../src/core/config';
import type { MessageItem, Platform } from '../src/core/platform';
import type { Boot } from './boot';
import { request, send } from './ipc';
import { showMessage } from './ui';

export function nativePlatform(boot: Boot): Platform {
  const read = (section: SettingsSection, key: string) => boot.settings[`${section}.${key}`];
  const log = (level: 'info' | 'warn' | 'error') => (message: string) => {
    console[level](message);
    send({ type: 'log', level, message });
  };
  return {
    os: boot.os,
    setting: <T>(key: string, fallback: T) => (read('codeGty', key) ?? fallback) as T,
    terminalSetting: <T>(key: string, fallback: T) => (read('terminal.integrated', key) ?? fallback) as T,
    webviewConfig: () => buildWebviewConfig(read, boot.os),
    workspaceName: undefined,
    log: { info: log('info'), warn: log('warn'), error: log('error') },
    clipboard: {
      readText: async () => (await request<string>({ type: 'clipboardRead' })) ?? '',
      writeText: async (text) => send({ type: 'clipboardWrite', text }),
    },
    windowFocused: () => document.hasFocus(),
    colorScheme: () => (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'),
    showMessage: <T extends MessageItem>(level: 'info' | 'warning', text: string, options: { modal?: boolean }, ...items: T[]) => {
      // Not looking at the window: the desktop shows it too.
      if (!options.modal && !document.hasFocus()) send({ type: 'notify', title: 'Ghostty', body: text });
      return showMessage(level, text, !!options.modal, items);
    },
    // The tab title already shows progress; the window has no status bar.
    progress: () => ({ report: () => undefined, done: () => undefined }),
    openLink: async (kind, text) => {
      // Web links only for now: with no editor, a file link has nowhere to open.
      if (kind === 'url' && /^https?:\/\//i.test(text)) send({ type: 'open', url: text });
    },
  };
}
