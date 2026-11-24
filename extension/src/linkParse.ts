// vscode-free link parsing, shared with unit tests.

import { fileURLToPath } from 'node:url';

export interface ParsedFileLink {
  path: string;
  line?: number;
  col?: number;
}

/** Splits "src/a.ts:12:3", "a.py(12,3)", "a.rs:12" and "file:///x" forms. */
export function parseFileLink(text: string): ParsedFileLink {
  let t = text.trim().replace(/^['"(<[]+/, '').replace(/['">\],.;]+$/, '');
  // Drop a closing parenthesis only when it is not part of "(line,col)".
  if (t.endsWith(')') && !/\(\d+(?:,\s*\d+)?\)$/.test(t)) t = t.replace(/\)+$/, '');
  if (t.startsWith('file://')) {
    try {
      t = fileURLToPath(t);
    } catch {
      // fileURLToPath rejects hosts other than localhost on POSIX, but
      // `ls --hyperlink` and others write file://<hostname>/path.
      const m = /^file:\/\/[^/]*(\/.*)$/.exec(t);
      try {
        if (m) t = decodeURIComponent(m[1]);
      } catch {
        /* keep text as is */
      }
    }
  }
  let m = /^(.*?)\((\d+)(?:,\s*(\d+))?\)$/.exec(t);
  if (m) return { path: m[1], line: +m[2], col: m[3] ? +m[3] : undefined };
  m = /^(.*?):(\d+)(?::(\d+))?:?$/.exec(t);
  if (m && m[1] && !/^[A-Za-z]$/.test(m[1])) return { path: m[1], line: +m[2], col: m[3] ? +m[3] : undefined };
  return { path: t };
}
