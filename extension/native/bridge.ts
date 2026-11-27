// Stands in for VS Code's webview API inside the native app's page, so the
// extension's terminal page (webview/main.ts) runs unchanged: what it posts
// goes to the in-page host, and what the host posts arrives as 'message'
// events, as it would from VS Code. Must be imported before webview/main.ts.

import type { Disposable } from '../src/core/platform';
import type { HostToWebview, PersistedState } from '../src/shared/messages';
import { inBrowser } from './boot';
import { send } from './ipc';

type Listener = (m: unknown) => void;
const listeners = new Set<Listener>();
/** What the page posted before the host was listening (its 'ready', say). */
const early: unknown[] = [];
/** In a browser, the tab's sessionStorage keeps it across a reload, so the
 *  reloaded page reattaches to its session (as a VS Code reload does). */
const STATE_KEY = 'code-gty-state';
let state: PersistedState | undefined = inBrowser ? readState() : undefined;

function readState(): PersistedState | undefined {
  try {
    return JSON.parse(sessionStorage.getItem(STATE_KEY) ?? 'null') ?? undefined;
  } catch {
    return undefined;
  }
}

/** The state the page saved (before this load, in a browser). */
export function savedState(): PersistedState | undefined {
  return state;
}

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
    if (!inBrowser) return;
    try {
      sessionStorage.setItem(STATE_KEY, JSON.stringify(s));
    } catch {
      // Storage off: a reload starts a new shell.
    }
    // The server ends it if the page goes for good.
    if (s.sessionId) send({ type: 'session', id: s.sessionId });
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
