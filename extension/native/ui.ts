// Messages inside the native window, in place of VS Code's notifications
// and modal dialogs: a toast in the corner, or a dialog over the terminal.

import type { MessageItem } from '../src/core/platform';

let host: HTMLDivElement | undefined;

function toastHost(): HTMLDivElement {
  if (!host) {
    host = document.createElement('div');
    host.className = 'gty-toasts';
    document.body.appendChild(host);
  }
  return host;
}

export function showMessage<T extends MessageItem>(level: 'info' | 'warning', text: string, modal: boolean, items: T[]): Promise<T | undefined> {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = `gty-message gty-${level}${modal ? ' gty-modal' : ''}`;
    box.setAttribute('role', modal ? 'alertdialog' : 'status');
    const p = document.createElement('div');
    p.className = 'gty-message-text';
    p.textContent = text;
    box.appendChild(p);
    const buttons = document.createElement('div');
    buttons.className = 'gty-message-buttons';
    let overlay: HTMLDivElement | undefined;
    const finish = (v: T | undefined) => {
      clearTimeout(timer);
      box.remove();
      overlay?.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    for (const item of items) {
      const b = document.createElement('button');
      b.textContent = item.title;
      b.onclick = () => finish(item);
      buttons.appendChild(b);
    }
    const close = document.createElement('button');
    close.className = 'gty-message-close';
    close.textContent = modal ? 'Cancel' : '×';
    close.title = modal ? 'Cancel' : 'Dismiss';
    close.onclick = () => finish(undefined);
    buttons.appendChild(close);
    box.appendChild(buttons);
    const onKey = (e: KeyboardEvent) => {
      if (modal && e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(undefined);
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (modal) {
      overlay = document.createElement('div');
      overlay.className = 'gty-overlay';
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      document.addEventListener('keydown', onKey, true);
      (buttons.querySelector('button') as HTMLButtonElement | null)?.focus();
    } else {
      toastHost().appendChild(box);
      // Like VS Code: a message without buttons goes away by itself.
      if (!items.length) timer = setTimeout(() => finish(undefined), 10000);
    }
  });
}
