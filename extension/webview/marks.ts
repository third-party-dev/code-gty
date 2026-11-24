// Prompt marks from shell integration (OSC 133;A), recorded at the buffer line
// where each prompt starts, for "scroll to previous/next command".

import type { Terminal } from 'ghostty-web';
import { setViewportTop, viewportTop } from './viewport';

const PREFIX = [0x1b, 0x5d, 0x31, 0x33, 0x33, 0x3b]; // ESC ] 1 3 3 ;

export interface Segment {
  bytes: Uint8Array;
  /** The 133 sub-command (A, B, C, D) that ends this segment, if any. */
  markAfter?: string;
}

export interface Mark {
  line: number;
  exitCode?: number;
}

function indexOfSeq(data: Uint8Array, seq: number[], from: number): number {
  outer: for (let i = data.indexOf(seq[0], from); i >= 0 && i <= data.length - seq.length; i = data.indexOf(seq[0], i + 1)) {
    for (let j = 1; j < seq.length; j++) if (data[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
}

export class PromptMarks {
  private marks: Mark[] = [];

  clear(): void {
    this.marks = [];
  }

  get all(): readonly Mark[] {
    return this.marks;
  }

  /** Splits output so each 133 sequence ends a segment. */
  split(data: Uint8Array): Segment[] {
    const out: Segment[] = [];
    let from = 0;
    for (;;) {
      const at = indexOfSeq(data, PREFIX, from);
      if (at < 0 || at + PREFIX.length >= data.length) break;
      // Find the terminator (BEL or ESC \).
      let end = -1;
      for (let i = at + PREFIX.length; i < data.length; i++) {
        if (data[i] === 0x07) {
          end = i + 1;
          break;
        }
        if (data[i] === 0x1b && data[i + 1] === 0x5c) {
          end = i + 2;
          break;
        }
      }
      if (end < 0) break;
      const body = new TextDecoder().decode(data.subarray(at + PREFIX.length, end)).replace(/[\x07\x1b\\]+$/, '');
      out.push({ bytes: data.subarray(from, end), markAfter: body });
      from = end;
    }
    out.push({ bytes: data.subarray(from) });
    return out;
  }

  record(t: Terminal, body: string): void {
    const [cmd, arg] = body.split(';');
    if (cmd === 'A') {
      const line = t.getScrollbackLength() + t.buffer.active.cursorY;
      if (this.marks.length && this.marks[this.marks.length - 1].line === line) return;
      this.marks.push({ line });
      if (this.marks.length > 10000) this.marks.splice(0, this.marks.length - 10000);
    } else if (cmd === 'D' && this.marks.length) {
      const n = Number(arg);
      if (arg !== undefined && Number.isFinite(n)) this.marks[this.marks.length - 1].exitCode = n;
    }
  }

  scroll(t: Terminal, direction: 'previous' | 'next'): void {
    const top = viewportTop(t);
    if (direction === 'previous') {
      const prev = [...this.marks].reverse().find((m) => m.line < top);
      if (prev) setViewportTop(t, prev.line);
    } else {
      const next = this.marks.find((m) => m.line > top);
      if (next && next.line <= t.getScrollbackLength()) setViewportTop(t, next.line);
      else t.scrollToBottom();
    }
  }
}
