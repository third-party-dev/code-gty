// Base64 for code that runs both in Node (the extension host) and in a page
// (the native app): Node's Buffer when there is one (much faster on large
// images), else atob/btoa. Lenient like Buffer: invalid characters are
// skipped, so both hosts decode the same bytes.

interface NodeBuffer {
  from(data: Uint8Array | ArrayBufferLike | string, a?: number | string, b?: number): Uint8Array & { toString(enc: string): string };
}
const NodeBuf = (globalThis as { Buffer?: NodeBuffer }).Buffer;

export function encodeBase64(bytes: Uint8Array): string {
  if (NodeBuf) return NodeBuf.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  return encodeBase64Portable(bytes);
}

/** The page's path (exported for tests). */
export function encodeBase64Portable(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function decodeBase64(text: string): Uint8Array {
  if (NodeBuf) {
    const b = NodeBuf.from(text, 'base64');
    return new Uint8Array(b.buffer, b.byteOffset, b.length).slice();
  }
  return decodeBase64Portable(text);
}

/** The page's path (exported for tests). */
export function decodeBase64Portable(text: string): Uint8Array {
  // Same leniency as Buffer: data ends at the first padding character;
  // anything else outside the alphabet (standard or URL-safe) is skipped.
  const eq = text.indexOf('=');
  const clean = (eq < 0 ? text : text.slice(0, eq)).replace(/[^A-Za-z0-9+/\-_]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const usable = clean.length - (clean.length % 4 === 1 ? 1 : 0);
  const padded = clean.slice(0, usable) + '='.repeat((4 - (usable % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
