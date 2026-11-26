// Messages between the page and the Rust side of the native app (window,
// clipboard, opening links). Rust calls window.__gtyEvent with events and
// replies; requests carry an id.

export type ToRust =
  | { type: 'title'; title: string }
  | { type: 'open'; url: string }
  | { type: 'clipboardWrite'; text: string }
  | { type: 'clipboardRead'; id: number }
  | { type: 'notify'; title: string; body: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  /** Ends the app: the session is closed. */
  | { type: 'quit' };

export type FromRust =
  | { type: 'reply'; id: number; value: unknown }
  /** The user asked to close the window. */
  | { type: 'close' };

interface Ipc {
  postMessage(message: string): void;
}

export function send(m: ToRust): void {
  (globalThis as unknown as { ipc: Ipc }).ipc.postMessage(JSON.stringify(m));
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

(globalThis as unknown as { __gtyEvent: (e: FromRust) => void }).__gtyEvent = (e) => {
  if (e.type === 'reply') {
    const w = waiting.get(e.id);
    waiting.delete(e.id);
    w?.(e.value);
  } else if (e.type === 'close') {
    for (const fn of closeHandlers) fn();
  }
};
