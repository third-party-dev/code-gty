// Messages between the page and the program showing it (window, clipboard,
// opening links): the app (Rust) through the web view's window.ipc, which
// calls window.__gtyEvent with events and replies; or, in browser mode, a
// WebSocket to the server (/ipc), which also tells it the page is open.
// Requests carry an id.

import { inBrowser } from './boot';

export type ToRust =
  | { type: 'title'; title: string }
  | { type: 'open'; url: string }
  | { type: 'clipboardWrite'; text: string }
  | { type: 'clipboardRead'; id: number }
  | { type: 'notify'; title: string; body: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  /** Ends the app: the session is closed. */
  | { type: 'quit' }
  /** Browser mode: the page's session, ended by the server if the page goes. */
  | { type: 'session'; id: number };

export type FromRust =
  | { type: 'reply'; id: number; value: unknown }
  /** The user asked to close the window. */
  | { type: 'close' };

interface Ipc {
  postMessage(message: string): void;
}

/** Browser mode's socket, and what was sent before it opened. */
let socket: WebSocket | undefined;
const queued: string[] = [];

function browserSocket(): WebSocket {
  if (socket) return socket;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ipc`);
  ws.onopen = () => {
    for (const m of queued.splice(0)) ws.send(m);
  };
  ws.onmessage = (ev) => receive(JSON.parse(String(ev.data)) as FromRust);
  ws.onclose = () => console.warn('code-gty: the connection to the terminal server closed');
  socket = ws;
  return ws;
}

export function send(m: ToRust): void {
  const text = JSON.stringify(m);
  if (!inBrowser) {
    (globalThis as unknown as { ipc: Ipc }).ipc.postMessage(text);
    return;
  }
  const ws = browserSocket();
  if (ws.readyState === WebSocket.OPEN) ws.send(text);
  else queued.push(text);
}

/** Browser mode: opens the socket now (it marks the page as open). */
export function connect(): void {
  if (inBrowser) browserSocket();
}

let nextId = 1;
const waiting = new Map<number, (v: unknown) => void>();
const closeHandlers: (() => void)[] = [];

export function request<T>(m: { type: 'clipboardRead' }, timeoutMs = 5000): Promise<T | undefined> {
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      resolve(undefined);
    }, timeoutMs);
    waiting.set(id, (v) => {
      clearTimeout(timer);
      resolve(v as T);
    });
    send({ ...m, id });
  });
}

export function onClose(fn: () => void): void {
  closeHandlers.push(fn);
}

function receive(e: FromRust): void {
  if (e.type === 'reply') {
    const w = waiting.get(e.id);
    waiting.delete(e.id);
    w?.(e.value);
  } else if (e.type === 'close') {
    for (const fn of closeHandlers) fn();
  }
}

(globalThis as unknown as { __gtyEvent: (e: FromRust) => void }).__gtyEvent = receive;
