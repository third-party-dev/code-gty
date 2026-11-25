// Kitty desktop notifications (OSC 99), shown as VS Code notifications.
// https://sw.kovidgoyal.net/kitty/desktop-notifications/
//
// libghostty-vt parses OSC 99 but does not act on it; the host engine hands
// complete sequences here. vscode-free: the session supplies `show`.
//
// Replies go into the program's input, so they only ever carry identifiers
// from the spec's safe set (letters, digits, - _ + .) and button numbers:
// output from an untrusted program (a `cat`ed file) cannot type anything
// else through them.

/** A notification ready to show. */
export interface KittyNotification {
  title: string;
  body: string;
  buttons: string[];
  urgency: 'low' | 'normal' | 'critical';
  occasion: 'always' | 'unfocused' | 'invisible';
  /** Bring the terminal forward when activated. */
  focus: boolean;
}

/** What the user did: activated it (clicked it, or Show Terminal), pressed button n (1-based), or closed it. */
export type KittyOutcome = { kind: 'activated' } | { kind: 'button'; index: number } | { kind: 'closed' };

export interface KittyNotifyHost {
  /** Shows it; resolves when the user acts on it or it goes away. Undefined when not shown at all. */
  show(n: KittyNotification): Promise<KittyOutcome> | undefined;
  /** Writes a reply to the program. */
  reply(data: string): void;
  /** Brings the terminal forward. */
  focus(): void;
}

const ID = /^[A-Za-z0-9\-_+.]+$/;
/** Values the spec allows in metadata (libghostty-vt's set: identifiers plus a few symbols). */
const VALUE = /^[A-Za-z0-9\-_+./,(){}[\]*&^%$#@!`~=?]*$/;
/** Notifications being assembled from chunks, per terminal. */
const MAX_PENDING = 16;
/**
 * At most this many shown per RATE_WINDOW_MS, per terminal; more are dropped.
 * (A cap on open ones would not do: a VS Code message left in the
 * notification centre never settles.)
 */
const RATE_LIMIT = 8;
const RATE_WINDOW_MS = 10000;
/** Open notifications remembered for reports and `p=alive`; the oldest is forgotten first. */
const MAX_TRACKED = 64;
const MAX_TEXT = 8 * 1024;
const MAX_BUTTONS = 8;

/** The `key=value` fields of OSC 99 metadata, as libghostty-vt reads them: first valid value wins. */
export function readMetadata(metadata: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const field of metadata.split(':')) {
    const eq = field.indexOf('=');
    if (eq < 0) continue;
    const key = field.slice(0, eq).trim();
    const value = field.slice(eq + 1).trim();
    if (!VALUE.test(value) || out.has(key)) continue;
    out.set(key, value);
  }
  return out;
}

interface Pending {
  title: string;
  body: string;
  buttons: string;
  urgency: KittyNotification['urgency'];
  occasion: KittyNotification['occasion'];
  focus: boolean;
  report: boolean;
  closeReport: boolean;
}

export class KittyNotifications {
  private readonly pending = new Map<string, Pending>();
  /** Shown and not yet closed (id → whether to report closing). */
  private readonly open = new Map<string, { closeReport: boolean }>();
  private recent: number[] = [];

  constructor(private readonly host: KittyNotifyHost) {}

  /** One complete OSC 99, without the `99;` prefix and the terminator. */
  handle(body: string, terminator: 'st' | 'bel'): void {
    const semi = body.indexOf(';');
    if (semi < 0) return;
    const meta = readMetadata(body.slice(0, semi));
    let payload = body.slice(semi + 1);
    const rawId = meta.get('i');
    const id = rawId !== undefined && ID.test(rawId) ? rawId : undefined;
    const end = terminator === 'bel' ? '\x07' : '\x1b\\';
    const kind = meta.get('p') ?? 'title';

    if (kind === '?') {
      // What we support. No close (VS Code cannot take a notification back),
      // expiry, icons or sounds, so programs know not to rely on them.
      this.host.reply(`\x1b]99;i=${id ?? '0'}:p=?;a=focus,report:o=always,unfocused,invisible:u=0,1,2:p=title,body,buttons,?,alive:c=1${end}`);
      return;
    }
    if (kind === 'alive') {
      if (id) this.host.reply(`\x1b]99;i=${id}:p=alive;${[...this.open.keys()].join(',')}${end}`);
      return;
    }
    if (kind === 'close') {
      // Cannot be closed from here; forget it so nothing more is reported.
      if (id) this.open.delete(id);
      return;
    }
    if (kind !== 'title' && kind !== 'body' && kind !== 'buttons') return; // icon, unknown

    if (meta.get('e') === '1') {
      try {
        payload = Buffer.from(payload, 'base64').toString('utf8');
      } catch {
        return;
      }
    }
    const key = id ?? '';
    let n = this.pending.get(key);
    if (!n) {
      if (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
      n = { title: '', body: '', buttons: '', urgency: 'normal', occasion: 'always', focus: true, report: false, closeReport: false };
      this.pending.set(key, n);
    }
    // Options can come with any chunk; the last one given wins.
    const u = meta.get('u');
    if (u !== undefined) n.urgency = u === '0' ? 'low' : u === '2' ? 'critical' : 'normal';
    const o = meta.get('o');
    if (o === 'always' || o === 'unfocused' || o === 'invisible') n.occasion = o;
    const a = meta.get('a');
    if (a !== undefined) {
      let focus = true;
      let report = false;
      for (const part of a.split(',')) {
        const p = part.trim();
        const on = !p.startsWith('-');
        const name = on ? p : p.slice(1);
        if (name === 'focus') focus = on;
        else if (name === 'report') report = on;
      }
      n.focus = focus;
      n.report = report;
    }
    if (meta.get('c') === '1') n.closeReport = true;
    else if (meta.get('c') === '0') n.closeReport = false;
    const field = kind as 'title' | 'body' | 'buttons';
    n[field] = (n[field] + payload).slice(0, MAX_TEXT);

    if (meta.get('d') === '0') return; // more to come
    this.pending.delete(key);
    this.display(id, n);
  }

  private display(id: string | undefined, n: Pending): void {
    if (!n.title && !n.body) return;
    const now = Date.now();
    this.recent = this.recent.filter((t) => now - t < RATE_WINDOW_MS);
    if (this.recent.length >= RATE_LIMIT) return;
    const buttons = n.buttons ? n.buttons.split('\u2028').map((b) => b.trim()).filter(Boolean).slice(0, MAX_BUTTONS) : [];
    const shown = this.host.show({ title: n.title, body: n.body, buttons, urgency: n.urgency, occasion: n.occasion, focus: n.focus });
    if (!shown) return;
    this.recent.push(now);
    if (id) {
      this.open.delete(id); // a reused id: the newest one is live
      if (this.open.size >= MAX_TRACKED) this.open.delete(this.open.keys().next().value!);
      this.open.set(id, { closeReport: n.closeReport });
    }
    const entry = id ? this.open.get(id) : undefined;
    void shown.then((outcome) => {
      // Only the notification currently known by this id reports.
      const live = id && entry && this.open.get(id) === entry ? entry : undefined;
      if (live) this.open.delete(id!);
      if (outcome.kind !== 'closed' && n.focus) this.host.focus();
      // Nothing is reported for a notification the program closed itself, or without an id.
      if (!id || !live) return;
      if (outcome.kind === 'button') this.host.reply(`\x1b]99;i=${id};${outcome.index}\x1b\\`);
      else if (outcome.kind === 'activated' && n.report) this.host.reply(`\x1b]99;i=${id};\x1b\\`);
      if (live.closeReport) this.host.reply(`\x1b]99;i=${id}:p=close;\x1b\\`);
    });
  }
}
