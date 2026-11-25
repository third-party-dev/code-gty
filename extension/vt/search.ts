// Incremental search over the screen and scrollback of both screens. Results
// stay in sync with the terminal across screen switches, resize and pruning.

import { E, OK, S, Vt, utf8Encoder } from './core';
import type { Sel } from './selection';
import type { Terminal } from './terminal';

const SD = E.GhosttySearchData;
export type SearchStatus = 'running' | 'feed' | 'complete';

export class Search {
  private readonly handle: number;
  private needlePtr = 0;
  private needleLen = 0;
  private disposed = false;

  constructor(
    readonly vt: Vt,
    readonly term: Terminal,
  ) {
    this.handle = vt.construct('search_new', (slot) => vt.ex.ghostty_search_new(0, slot, term.handle));
    // Selecting a match should scroll the viewport to it.
    vt.withScratch((take) => {
      const p = take(4);
      vt.dv.setInt32(p, E.GhosttySearchScroll.IF_NEEDED, true);
      vt.check(vt.ex.ghostty_search_set(this.handle, E.GhosttySearchOption.SELECT_SCROLL, p), 'search select scroll');
    });
  }

  /** Sets the needle; an unchanged needle keeps its results, '' clears. */
  setNeedle(text: string): void {
    const vt = this.vt;
    vt.free(this.needlePtr, this.needleLen);
    const bytes = utf8Encoder.encode(text);
    this.needleLen = bytes.length;
    this.needlePtr = bytes.length ? vt.copyIn(bytes) : 0;
    vt.withScratch((take) => {
      const s = take(8, 4);
      vt.dv.setUint32(s, this.needlePtr, true);
      vt.dv.setUint32(s + 4, this.needleLen, true);
      vt.check(vt.ex.ghostty_search_set(this.handle, E.GhosttySearchOption.NEEDLE, bytes.length ? s : 0), 'search needle');
    });
  }

  /** Bounded progress on already-copied data. */
  tick(): SearchStatus {
    const vt = this.vt;
    return vt.withScratch((take) => {
      const p = take(4);
      vt.check(vt.ex.ghostty_search_tick(this.handle, p), 'search_tick');
      const s = vt.dv.getInt32(p, true);
      return s === E.GhosttySearchStatus.RUNNING ? 'running' : s === E.GhosttySearchStatus.FEED_REQUIRED ? 'feed' : 'complete';
    });
  }

  /** Reads the terminal to pick up new data and changes. */
  feed(): void {
    this.vt.check(this.vt.ex.ghostty_search_feed(this.handle), 'search_feed');
  }

  /** Feeds and ticks, up to a time budget. Returns whether it is caught up. */
  step(budgetMs = 4): boolean {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const s = this.tick();
      if (s === 'complete') return true;
      if (s === 'feed') this.feed();
      if (Date.now() >= deadline) return false;
    }
  }

  next(): boolean {
    return this.vt.ex.ghostty_search_select_next(this.handle) === OK;
  }

  prev(): boolean {
    return this.vt.ex.ghostty_search_select_prev(this.handle) === OK;
  }

  private u32(key: number): number | undefined {
    const vt = this.vt;
    return vt.withScratch((take) => {
      const p = take(4);
      return vt.ex.ghostty_search_get(this.handle, key, p) === OK ? vt.dv.getUint32(p, true) : undefined;
    });
  }

  get total(): number {
    return this.u32(SD.TOTAL_MATCHES) ?? 0;
  }

  /** 0 is the newest match. */
  get selectedIndex(): number | undefined {
    return this.u32(SD.SELECTED_INDEX);
  }

  get selectedMatch(): Sel | undefined {
    const vt = this.vt;
    return vt.withScratch((take) => {
      const p = take(S.GhosttySelection.size);
      return vt.ex.ghostty_search_get(this.handle, SD.SELECTED_MATCH, p) === OK ? vt.copyOut(p, S.GhosttySelection.size) : undefined;
    });
  }

  /** Matches on (or near) the viewport, as selection snapshots. */
  viewportMatches(max = 256): Sel[] {
    const vt = this.vt;
    const size = S.GhosttySelection.size;
    const storage = vt.alloc(max * size);
    try {
      return vt.withScratch((take) => {
        const b = take(S.GhosttySelectionBuffer.size);
        const f = S.GhosttySelectionBuffer.f;
        vt.dv.setUint32(b + f.ptr, storage, true);
        vt.dv.setUint32(b + f.cap, max, true);
        const r = vt.ex.ghostty_search_get(this.handle, SD.VIEWPORT_MATCHES, b);
        if (r !== OK && r !== E.GhosttyResult.OUT_OF_SPACE) return [];
        const n = Math.min(max, vt.dv.getUint32(b + f.len, true));
        const out: Sel[] = [];
        for (let i = 0; i < n; i++) out.push(vt.copyOut(storage + i * size, size));
        return out;
      });
    } finally {
      vt.free(storage, max * size);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.vt.ex.ghostty_search_free(this.handle);
    this.vt.free(this.needlePtr, this.needleLen);
  }
}
