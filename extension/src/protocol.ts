// Frame codec for the sidecar protocol. Must match sidecar/src/protocol.rs.
//
// Frame: u32 LE length | u8 kind | u32 LE session | payload, where length
// counts kind + session + payload.

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME = 16 * 1024 * 1024;

export const Kind = {
  HELLO: 1,
  SPAWN: 2,
  INPUT: 3,
  RESIZE: 4,
  OUTPUT: 5,
  ACK: 6,
  KILL: 7,
  EXIT: 8,
  ATTACH: 9,
  REPLAY: 10,
  ERROR: 11,
  SPAWNED: 12,
  QUERY_PROCESS: 13,
  PROCESS_INFO: 14,
} as const;

export interface Frame {
  kind: number;
  session: number;
  payload: Uint8Array;
}

export interface SpawnRequest {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  cols: number;
  rows: number;
  /** Pixel size of the text area, for TIOCGWINSZ (image viewers). */
  width?: number;
  height?: number;
  window?: number;
  replayLimit?: number;
}

export interface HelloMsg {
  protocol: number;
  build: string;
  pid: number;
  os: string;
}

export interface ExitMsg {
  code: number | null;
  signal: string | null;
}

export interface ProcessInfoMsg {
  name: string | null;
  busy: boolean | null;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeFrame(kind: number, session: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(9 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 5 + payload.length, true);
  view.setUint8(4, kind);
  view.setUint32(5, session, true);
  out.set(payload, 9);
  return out;
}

export function encodeJson(kind: number, session: number, value: unknown): Uint8Array {
  return encodeFrame(kind, session, encoder.encode(JSON.stringify(value)));
}

export function encodeAck(session: number, bytes: number): Uint8Array {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, bytes >>> 0, true);
  return encodeFrame(Kind.ACK, session, payload);
}

export function decodeJson<T>(frame: Frame): T {
  return JSON.parse(decoder.decode(frame.payload)) as T;
}

/** Incremental decoder: feed arbitrary chunks, get whole frames back. */
export class FrameDecoder {
  private chunks: Uint8Array[] = [];
  private buffered = 0;

  push(chunk: Uint8Array): Frame[] {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    const frames: Frame[] = [];
    for (;;) {
      if (this.buffered < 4) break;
      const head = this.peek(4);
      const len = new DataView(head.buffer, head.byteOffset, 4).getUint32(0, true);
      if (len < 5 || len > MAX_FRAME) {
        throw new Error(`bad frame length ${len}`);
      }
      if (this.buffered < 4 + len) break;
      const body = this.take(4 + len).subarray(4);
      const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
      frames.push({ kind: view.getUint8(0), session: view.getUint32(1, true), payload: body.subarray(5) });
    }
    return frames;
  }

  private peek(n: number): Uint8Array {
    const first = this.chunks[0];
    if (first.length >= n) return first.subarray(0, n);
    return this.concat(n, false);
  }

  private take(n: number): Uint8Array {
    const first = this.chunks[0];
    if (first.length === n) {
      this.chunks.shift();
      this.buffered -= n;
      return first;
    }
    if (first.length > n) {
      this.chunks[0] = first.subarray(n);
      this.buffered -= n;
      // Copy so the returned frame does not pin a large shared chunk.
      return first.slice(0, n);
    }
    return this.concat(n, true);
  }

  private concat(n: number, consume: boolean): Uint8Array {
    const out = new Uint8Array(n);
    let off = 0;
    let i = 0;
    while (off < n) {
      const c = this.chunks[i];
      const need = n - off;
      if (c.length <= need) {
        out.set(c, off);
        off += c.length;
        i++;
      } else {
        out.set(c.subarray(0, need), off);
        off += need;
        if (consume) this.chunks[i] = c.subarray(need);
      }
    }
    if (consume) {
      this.chunks.splice(0, i);
      this.buffered -= n;
    }
    return out;
  }
}
