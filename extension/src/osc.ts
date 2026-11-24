// Stateful scanner that pulls OSC sequences out of a PTY byte stream that
// may be split at any point. The bytes themselves still go to the webview
// unchanged; this only observes them.

const ESC = 0x1b;
const BEL = 0x07;
const OSC_START = 0x5d; // ]
const ST_END = 0x5c; // \
const CAN = 0x18;
const SUB = 0x1a;

/** OSC 52 payloads can be large; anything longer than this is dropped. */
const MAX_OSC = 1024 * 1024;

const enum State {
  Ground,
  Esc,
  Osc,
  OscEsc,
}

export class OscScanner {
  private state = State.Ground;
  private buf: number[] = [];
  private overflow = false;
  private readonly decoder = new TextDecoder();

  /** Returns the payloads (text between `ESC ]` and the terminator) found. */
  push(data: Uint8Array): string[] {
    const found: string[] = [];
    for (let i = 0; i < data.length; i++) {
      const b = data[i];
      switch (this.state) {
        case State.Ground: {
          // Fast skip to the next ESC.
          const next = data.indexOf(ESC, i);
          if (next < 0) {
            i = data.length;
            break;
          }
          i = next;
          this.state = State.Esc;
          break;
        }
        case State.Esc:
          if (b === OSC_START) {
            this.state = State.Osc;
            this.buf = [];
            this.overflow = false;
          } else {
            this.state = b === ESC ? State.Esc : State.Ground;
          }
          break;
        case State.Osc:
          if (b === BEL) {
            this.finish(found);
          } else if (b === ESC) {
            this.state = State.OscEsc;
          } else if (b === CAN || b === SUB) {
            this.state = State.Ground;
          } else if (this.buf.length < MAX_OSC) {
            this.buf.push(b);
          } else {
            this.overflow = true;
          }
          break;
        case State.OscEsc:
          if (b === ST_END) {
            this.finish(found);
          } else {
            // ESC inside an OSC aborts it and may start a new sequence.
            this.state = State.Esc;
            i--;
          }
          break;
      }
    }
    return found;
  }

  private finish(found: string[]): void {
    if (!this.overflow) found.push(this.decoder.decode(new Uint8Array(this.buf)));
    this.buf = [];
    this.state = State.Ground;
  }
}

export type OscEvent =
  | { type: 'title'; title: string }
  | { type: 'cwd'; cwd: string }
  | { type: 'clipboard'; op: 'write'; text: string }
  | { type: 'clipboard'; op: 'read' }
  | { type: 'commandFinished'; exitCode: number | undefined }
  | { type: 'promptStart' }
  | { type: 'commandStart' };

/** Interprets the OSC payloads that matter to the host. */
export function interpretOsc(payload: string): OscEvent | undefined {
  const semi = payload.indexOf(';');
  const code = semi < 0 ? payload : payload.slice(0, semi);
  const rest = semi < 0 ? '' : payload.slice(semi + 1);
  switch (code) {
    case '0':
    case '2':
      return { type: 'title', title: rest };
    case '7': {
      const cwd = parseFileUri(rest);
      return cwd ? { type: 'cwd', cwd } : undefined;
    }
    case '52': {
      // 52;<targets>;<base64 | ?>
      const semi2 = rest.indexOf(';');
      if (semi2 < 0) return undefined;
      const data = rest.slice(semi2 + 1);
      if (data === '?') return { type: 'clipboard', op: 'read' };
      try {
        return { type: 'clipboard', op: 'write', text: Buffer.from(data, 'base64').toString('utf8') };
      } catch {
        return undefined;
      }
    }
    case '133': {
      const parts = rest.split(';');
      if (parts[0] === 'A') return { type: 'promptStart' };
      if (parts[0] === 'C') return { type: 'commandStart' };
      if (parts[0] === 'D') {
        const n = parts[1] === undefined || parts[1] === '' ? undefined : Number(parts[1]);
        return { type: 'commandFinished', exitCode: Number.isFinite(n) ? n : undefined };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** `file://host/path` -> local path (percent-decoded). Windows drive paths lose the leading slash. */
export function parseFileUri(uri: string): string | undefined {
  if (!uri.startsWith('file://')) {
    // Some shells send a bare path.
    return uri.startsWith('/') ? uri : undefined;
  }
  const afterScheme = uri.slice('file://'.length);
  const slash = afterScheme.indexOf('/');
  if (slash < 0) return undefined;
  let path: string;
  try {
    path = decodeURIComponent(afterScheme.slice(slash));
  } catch {
    return undefined;
  }
  if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
  return path;
}
