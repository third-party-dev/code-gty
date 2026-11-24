// OSC 8 hyperlinks. ghostty-web 0.4 marks linked cells (getHyperlinkId() is 1
// for every linked cell, whatever the URI) but cannot return a link's URI:
// wasmTerm.getHyperlinkUri is a stub that returns null, so its own OSC 8 link
// provider never produces a link.
//
// This records each link as output is written: the cursor position and URI
// when the link opens, the end position and link text when it closes. The
// link provider in main.ts takes runs of linked cells from the buffer and
// looks them up here: first by position, then (if the screen has since
// reflowed or scrolled) by text. A run with no match gets no link, never a
// wrong one.

import type { Terminal } from 'ghostty-web';

const PREFIX = [0x1b, 0x5d, 0x38, 0x3b]; // ESC ] 8 ;
const MAX_LINKS = 10000;

export interface Segment {
  bytes: Uint8Array;
  /** URI of the OSC 8 sequence that ends this segment ('' closes a link). */
  linkAfter?: string;
}

export interface CellRun {
  start: number;
  end: number; // exclusive
}

interface Pos {
  line: number;
  x: number;
}

export interface LinkRecord {
  uri: string;
  start: Pos;
  end: Pos; // exclusive
  text: string;
}

function indexOfSeq(data: Uint8Array, seq: number[], from: number): number {
  outer: for (let i = data.indexOf(seq[0], from); i >= 0 && i <= data.length - seq.length; i = data.indexOf(seq[0], i + 1)) {
    for (let j = 1; j < seq.length; j++) if (data[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
}

/** Splits output so each complete OSC 8 sequence ends a segment. */
export function splitHyperlinks(data: Uint8Array): Segment[] {
  const out: Segment[] = [];
  let from = 0;
  for (;;) {
    const at = indexOfSeq(data, PREFIX, from);
    if (at < 0) break;
    let end = -1;
    let bodyEnd = -1;
    for (let i = at + PREFIX.length; i < data.length; i++) {
      if (data[i] === 0x07) {
        bodyEnd = i;
        end = i + 1;
        break;
      }
      if (data[i] === 0x1b && data[i + 1] === 0x5c) {
        bodyEnd = i;
        end = i + 2;
        break;
      }
    }
    if (end < 0) break;
    // OSC 8 ; params ; URI
    const body = new TextDecoder().decode(data.subarray(at + PREFIX.length, bodyEnd));
    const semi = body.indexOf(';');
    out.push({ bytes: data.subarray(from, end), linkAfter: semi < 0 ? '' : body.slice(semi + 1) });
    from = end;
  }
  out.push({ bytes: data.subarray(from) });
  return out;
}

/** Runs of consecutive linked cells (non-zero hyperlink id). */
export function cellRuns(linked: boolean[]): CellRun[] {
  const runs: CellRun[] = [];
  for (let x = 0; x < linked.length; x++) {
    if (!linked[x]) continue;
    const last = runs[runs.length - 1];
    if (last && last.end === x) last.end = x + 1;
    else runs.push({ start: x, end: x + 1 });
  }
  return runs;
}

const before = (a: Pos, b: Pos) => a.line < b.line || (a.line === b.line && a.x < b.x);
const covers = (r: LinkRecord, p: Pos) => !before(p, r.start) && before(p, r.end);

/** Finds the link for a run of linked cells: by position, else by text. */
export function findLink(records: readonly LinkRecord[], line: number, run: CellRun, runText: string): LinkRecord | undefined {
  for (let i = records.length - 1; i >= 0; i--) if (covers(records[i], { line, x: run.start })) return records[i];
  const text = runText.trim();
  if (!text) return undefined;
  for (let i = records.length - 1; i >= 0; i--) if (records[i].text.includes(text)) return records[i];
  return undefined;
}

function cursor(t: Terminal): Pos {
  const buf = t.buffer.active;
  const pos = { line: t.getScrollbackLength() + buf.cursorY, x: buf.cursorX };
  // A cursor past the last column wraps before the next character.
  if (pos.x >= t.cols) return { line: pos.line + 1, x: 0 };
  return pos;
}

function textBetween(t: Terminal, start: Pos, end: Pos): string {
  let text = '';
  for (let line = start.line; line <= end.line; line++) {
    const l = t.buffer.active.getLine(line);
    if (!l) continue;
    const from = line === start.line ? start.x : 0;
    const to = line === end.line ? end.x : l.length;
    text += l.translateToString(false, from, to);
  }
  return text;
}

export class Hyperlinks {
  private records: LinkRecord[] = [];
  private open?: { uri: string; start: Pos };

  clear(): void {
    this.records = [];
    this.open = undefined;
  }

  get all(): readonly LinkRecord[] {
    return this.records;
  }

  /** Call after writing a segment that ended with OSC 8 (`uri` '' closes). */
  record(t: Terminal, uri: string): void {
    const at = cursor(t);
    if (this.open && before(this.open.start, at)) {
      const { uri: openUri, start } = this.open;
      this.records.push({ uri: openUri, start, end: at, text: textBetween(t, start, at) });
      if (this.records.length > MAX_LINKS) this.records.splice(0, this.records.length - MAX_LINKS);
    }
    this.open = uri ? { uri, start: at } : undefined;
  }

  find(t: Terminal, line: number, run: CellRun): LinkRecord | undefined {
    const runText = t.buffer.active.getLine(line)?.translateToString(false, run.start, run.end) ?? '';
    return findLink(this.records, line, run, runText);
  }
}
