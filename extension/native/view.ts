// The native window as the session's view: one terminal per window for now.

import type { Disposable, TerminalView } from '../src/core/platform';
import type { HostToWebview } from '../src/shared/messages';
import { onPageMessage, postToPage } from './bridge';
import { send } from './ipc';

export class WindowView implements TerminalView {
  private titleText = '';
  private disposeHandlers = new Set<() => void>();

  get active(): boolean {
    return document.hasFocus();
  }
  get visible(): boolean {
    return document.visibilityState === 'visible';
  }
  get title(): string {
    return this.titleText;
  }
  set title(t: string) {
    if (t === this.titleText) return;
    this.titleText = t;
    send({ type: 'title', title: t });
  }
  post(msg: HostToWebview): void {
    postToPage(msg);
  }
  reveal(): void {
    window.focus();
    postToPage({ type: 'focus' });
  }
  /** Closing the window's only tab: the host decides whether the app ends. */
  dispose(): void {
    const handlers = [...this.disposeHandlers];
    this.disposeHandlers.clear();
    for (const fn of handlers) fn();
  }
  onMessage(fn: (raw: unknown) => void): Disposable {
    return onPageMessage(fn);
  }
  onViewState(fn: (s: { active: boolean; visible: boolean }) => void): Disposable {
    const update = () => fn({ active: this.active, visible: this.visible });
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    return {
      dispose: () => {
        window.removeEventListener('focus', update);
        window.removeEventListener('blur', update);
        document.removeEventListener('visibilitychange', update);
      },
    };
  }
  onDispose(fn: () => void): Disposable {
    this.disposeHandlers.add(fn);
    return { dispose: () => this.disposeHandlers.delete(fn) };
  }
}
