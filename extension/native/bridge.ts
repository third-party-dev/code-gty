// Stands in for VS Code's webview API inside the native app's page, so the
// extension's terminal page (webview/main.ts) runs unchanged: what it posts
// goes to the in-page host, and what the host posts arrives as 'message'
// events, as it would from VS Code. Must be imported before webview/main.ts.

import type { Disposable } from '../src/core/platform';
import type { HostToWebview, PersistedState } from '../src/shared/messages';

type Listener = (m: unknown) => void;
const listeners = new Set<Listener>();
/** What the page posted before the host was listening (its 'ready', say). */
const early: unknown[] = [];
let state: PersistedState | undefined;

(globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
  postMessage(m: unknown) {
    // Asynchronous, like VS Code's.
    queueMicrotask(() => {
      if (!listeners.size) early.push(m);
      for (const l of listeners) l(m);
    });
  },
  getState: () => state,
  setState: (s: PersistedState) => {
    state = s;
  },
});

/** Messages from the page, to the host. */
export function onPageMessage(fn: Listener): Disposable {
  listeners.add(fn);
  for (const m of early.splice(0)) fn(m);
  return { dispose: () => listeners.delete(fn) };
}

/** A message from the host, to the page. */
export function postToPage(msg: HostToWebview): void {
  window.dispatchEvent(new MessageEvent('message', { data: msg }));
}
