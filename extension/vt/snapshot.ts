// Restoring a terminal from a snapshot taken by another engine instance of the
// same build. The renderable state comes first (`ready`), so the mirror can
// draw and take live output while older scrollback is still being restored.

import { E, NO_VALUE, Vt } from './core';
import { Terminal, TerminalOptions } from './terminal';

export class SnapshotRestore {
  private readonly decoder: number;
  private readonly ptr: number;
  private readonly len: number;
  private done = false;
  private disposed = false;

  constructor(
    readonly vt: Vt,
    bytes: Uint8Array,
  ) {
    // The decoder borrows the bytes until FINISH, so they get their own allocation.
    this.len = Math.max(1, bytes.length);
    this.ptr = vt.alloc(this.len);
    vt.u8.set(bytes, this.ptr);
    this.decoder = vt.construct('snapshot_decoder_new_buf', (slot) => vt.ex.ghostty_snapshot_decoder_new_buf(0, slot, this.ptr, bytes.length));
    vt.withScratch((take) => {
      const b = take(4);
      vt.dv.setUint32(b, 64 * 1024, true);
      vt.check(vt.ex.ghostty_snapshot_decoder_set(this.decoder, E.GhosttySnapshotDecoderOption.MAX_CONTINUATION_BYTES, b), 'snapshot max continuation');
      vt.u8[b] = 1;
      vt.check(vt.ex.ghostty_snapshot_decoder_set(this.decoder, E.GhosttySnapshotDecoderOption.RETAIN_CONTINUATION, b), 'snapshot retain continuation');
      vt.check(vt.ex.ghostty_snapshot_decoder_set(this.decoder, E.GhosttySnapshotDecoderOption.COMPRESS_HISTORY, b), 'snapshot compress history');
    });
  }

  /** Decodes through READY and returns a renderable terminal. */
  ready(opts: Omit<TerminalOptions, 'cols' | 'rows'>): Terminal {
    const vt = this.vt;
    const handle = vt.construct('snapshot_decoder_ready', (slot) => vt.ex.ghostty_snapshot_decoder_ready(this.decoder, slot));
    return Terminal.adopt(vt, handle, opts);
  }

  /** Restores one more history record. Returns false once FINISH is reached. */
  next(): boolean {
    if (this.done) return false;
    const r = this.vt.ex.ghostty_snapshot_decoder_next(this.decoder);
    if (r === NO_VALUE) {
      this.done = true;
      return false;
    }
    this.vt.check(r, 'snapshot_decoder_next');
    return true;
  }

  /** Restores history for up to `budgetMs`. Returns true when finished. */
  step(budgetMs = 8): boolean {
    const deadline = Date.now() + budgetMs;
    while (this.next()) if (Date.now() >= deadline) return false;
    return true;
  }

  get finished(): boolean {
    return this.done;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.vt.ex.ghostty_snapshot_decoder_free(this.decoder);
    this.vt.free(this.ptr, this.len);
  }
}

/** Decodes a whole snapshot in one call. */
export function restoreSnapshot(vt: Vt, bytes: Uint8Array, opts: Omit<TerminalOptions, 'cols' | 'rows'>): Terminal {
  const r = new SnapshotRestore(vt, bytes);
  try {
    const t = r.ready(opts);
    while (r.next());
    return t;
  } finally {
    r.dispose();
  }
}
