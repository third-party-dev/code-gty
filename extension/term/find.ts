// Find widget on libghostty-vt's incremental search. Matches cover the
// screen and scrollback of both screens and stay correct across output,
// resize, screen switches and scrollback pruning.

import { Search } from '../vt/search';
import { selEnds, Sel } from '../vt/selection';
import type { Terminal } from '../vt/terminal';
import type { Highlight } from './renderer';

export interface FindHost {
  readonly mirror: Terminal | undefined;
  /** Redraw soon (matches or viewport changed). */
  refresh(): void;
  focusTerminal(): void;
  selectionText(): string;
  cols(): number;
  rows(): number;
}

export class FindController {
  private readonly input: HTMLInputElement;
  private readonly count: HTMLElement;
  private search: Search | undefined;
  private searchTerm: Terminal | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly abort = new AbortController();
  private selected = false;

  constructor(
    private readonly host: FindHost,
    private readonly root: HTMLElement,
  ) {
    this.input = root.querySelector('#find-input') as HTMLInputElement;
    this.count = root.querySelector('#find-count') as HTMLElement;
    const signal = this.abort.signal;
    this.input.addEventListener('input', () => this.update(), { signal });
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
    root.querySelector('#find-next')?.addEventListener('click', () => this.step(1), { signal });
    root.querySelector('#find-prev')?.addEventListener('click', () => this.step(-1), { signal });
    root.querySelector('#find-close')?.addEventListener('click', () => this.close(), { signal });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(): void {
    this.root.hidden = false;
    const sel = this.host.selectionText();
    if (sel && !sel.includes('\n')) this.input.value = sel;
    this.input.focus();
    this.input.select();
    this.update();
  }

  close(): void {
    if (this.root.hidden) return;
    this.root.hidden = true;
    this.search?.setNeedle('');
    this.selected = false;
    this.host.refresh();
    this.host.focusTerminal();
  }

  /** The terminal was replaced (snapshot attach). */
  reset(): void {
    this.search?.dispose();
    this.search = undefined;
    this.searchTerm = undefined;
    if (this.isOpen) this.update();
  }

  private ensure(): Search | undefined {
    const term = this.host.mirror;
    if (!term) return undefined;
    if (this.searchTerm !== term) {
      this.search?.dispose();
      this.search = new Search(term.vt, term);
      this.searchTerm = term;
    }
    return this.search;
  }

  private update(): void {
    const s = this.ensure();
    if (!s) return;
    s.setNeedle(this.input.value);
    this.selected = false;
    this.pump();
  }

  /** Called after output: keep matches in step with the terminal. */
  onOutput(): void {
    if (!this.isOpen || !this.input.value) return;
    this.pump();
  }

  private pump(): void {
    if (this.timer) return;
    const run = () => {
      this.timer = undefined;
      const s = this.search;
      if (!s || !this.isOpen) return;
      s.feed();
      const done = s.step(6);
      this.render();
      this.host.refresh();
      if (!done) this.timer = setTimeout(run, 0);
    };
    this.timer = setTimeout(run, 0);
  }

  private step(delta: number): void {
    const s = this.ensure();
    if (!s || !this.input.value) return;
    s.feed();
    s.step(20);
    // Index 0 is the newest match; "next" moves toward older content like the find bar's Up arrow.
    if (delta > 0) s.next();
    else s.prev();
    this.selected = true;
    this.render();
    this.host.refresh();
  }

  private render(): void {
    const s = this.search;
    if (!this.input.value || !s) {
      this.count.textContent = '';
      return;
    }
    const n = s.total;
    const i = this.selected ? s.selectedIndex : undefined;
    this.count.textContent = n ? (i !== undefined ? `${i + 1} of ${n}` : `${n} found`) : 'No results';
  }

  /** Highlight rectangles for the visible rows. */
  highlights(): Highlight[] {
    const s = this.search;
    const term = this.host.mirror;
    if (!s || !term || !this.isOpen || !this.input.value) return [];
    const out: Highlight[] = [];
    const current = this.selected ? s.selectedMatch : undefined;
    const cur = current ? selEnds(term, current, 'viewport') : undefined;
    const cols = this.host.cols();
    const rows = this.host.rows();
    const add = (sel: Sel, isCurrent: boolean) => {
      const e = selEnds(term, sel, 'viewport');
      if (!e) return;
      for (let y = e.start.y; y <= e.end.y && y < rows; y++) {
        out.push({ y, start: y === e.start.y ? e.start.x : 0, end: y === e.end.y ? e.end.x : cols - 1, current: isCurrent });
      }
    };
    for (const m of s.viewportMatches()) {
      const e = selEnds(term, m, 'viewport');
      const isCur = !!cur && !!e && e.start.x === cur.start.x && e.start.y === cur.start.y;
      add(m, isCur);
    }
    return out;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.abort.abort();
    this.search?.dispose();
  }
}
