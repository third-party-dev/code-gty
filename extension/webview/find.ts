// Find widget: searches the scrollback and screen text.

import type { Terminal } from 'ghostty-web';
import { setViewportTop, viewportTop } from './viewport';

interface Match {
  line: number;
  col: number;
  len: number;
}

export class FindController {
  private readonly input: HTMLInputElement;
  private readonly count: HTMLElement;
  private matches: Match[] = [];
  private index = -1;
  private stale = true;
  private readonly abort = new AbortController();

  constructor(
    private readonly term: Terminal,
    private readonly root: HTMLDivElement,
  ) {
    this.input = root.querySelector('#find-input') as HTMLInputElement;
    this.count = root.querySelector('#find-count') as HTMLElement;
    const signal = this.abort.signal;
    this.input.addEventListener('input', () => this.search(true), { signal });
    this.input.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.step(e.shiftKey ? -1 : 1);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this.close();
        }
        // Keep typing in the box from reaching the workbench or the shell.
        if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
      },
      { signal },
    );
    root.querySelector('#find-next')!.addEventListener('click', () => this.step(1), { signal });
    root.querySelector('#find-prev')!.addEventListener('click', () => this.step(-1), { signal });
    root.querySelector('#find-close')!.addEventListener('click', () => this.close(), { signal });
  }

  open(): void {
    this.root.hidden = false;
    const sel = this.term.hasSelection() ? this.term.getSelection() : '';
    if (sel && !sel.includes('\n')) this.input.value = sel;
    this.input.focus();
    this.input.select();
    if (this.input.value) this.search(true);
  }

  close(): void {
    if (this.root.hidden) return;
    this.root.hidden = true;
    this.term.clearSelection();
    this.term.focus();
  }

  dispose(): void {
    this.root.hidden = true;
    this.abort.abort();
  }

  invalidate(): void {
    this.stale = true;
  }

  private search(resetIndex: boolean): void {
    const query = this.input.value;
    this.matches = [];
    this.stale = false;
    if (!query) {
      this.index = -1;
      this.render();
      return;
    }
    const lower = query.toLowerCase();
    // Smart case, like the editor's find: case-sensitive if the query has capitals.
    const sensitive = query !== lower;
    const buf = this.term.buffer.active;
    for (let y = 0; y < buf.length; y++) {
      const raw = buf.getLine(y)?.translateToString(true) ?? '';
      const text = sensitive ? raw : raw.toLowerCase();
      const q = sensitive ? query : lower;
      for (let at = text.indexOf(q); at >= 0; at = text.indexOf(q, at + Math.max(1, q.length))) {
        this.matches.push({ line: y, col: at, len: q.length });
        if (this.matches.length >= 5000) break;
      }
    }
    if (resetIndex) {
      // Start from the match nearest the bottom of the current view.
      const top = viewportTop(this.term) + this.term.rows;
      let i = this.matches.length - 1;
      while (i > 0 && this.matches[i].line > top) i--;
      this.index = this.matches.length ? i : -1;
    }
    this.show();
  }

  private step(delta: number): void {
    if (this.stale) this.search(false);
    if (!this.matches.length) return;
    this.index = (this.index + delta + this.matches.length) % this.matches.length;
    this.show();
  }

  private show(): void {
    this.render();
    const m = this.matches[this.index];
    if (!m) {
      this.term.clearSelection();
      return;
    }
    const half = Math.floor(this.term.rows / 2);
    setViewportTop(this.term, m.line - half);
    const row = m.line - viewportTop(this.term);
    this.term.select(m.col, row, m.len);
  }

  private render(): void {
    const n = this.matches.length;
    this.count.textContent = this.input.value ? (n ? `${this.index + 1} of ${n}${n >= 5000 ? '+' : ''}` : 'No results') : '';
  }
}
