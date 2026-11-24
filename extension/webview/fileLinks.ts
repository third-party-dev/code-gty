// Detects file paths such as `src/a.ts:12:3`, `./build.sh` and `/etc/hosts`
// on a buffer line. Web URLs are left to ghostty-web's own URL provider.

export interface FoundLink {
  start: number;
  end: number; // exclusive
  text: string;
}

const URL_RE = /\b(?:https?|ftp|file|mailto|ssh|git):[^\s"'<>`]+/g;
const PATH_RE = /(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|[\\/])?(?:[\w.@+~-]+[\\/])*[\w.@+~-]+(?::\d+(?::\d+)?|\(\d+(?:,\s*\d+)?\))?/g;

export function findFileLinks(line: string): FoundLink[] {
  const urls: [number, number][] = [];
  for (const m of line.matchAll(URL_RE)) urls.push([m.index!, m.index! + m[0].length]);
  const out: FoundLink[] = [];
  for (const m of line.matchAll(PATH_RE)) {
    let text = m[0];
    const start = m.index!;
    // Trailing punctuation is almost never part of a path.
    text = text.replace(/[.,;:]+$/, '');
    if (text.length < 2) continue;
    const end = start + text.length;
    if (urls.some(([a, b]) => start < b && end > a)) continue;
    const hasSep = /[\\/]/.test(text);
    const hasLine = /:\d+(?::\d+)?$|\(\d+(?:,\s*\d+)?\)$/.test(text);
    const hasExt = /\.[A-Za-z][A-Za-z0-9]{0,9}(?::\d+(?::\d+)?|\(\d+(?:,\s*\d+)?\))?$/.test(text);
    if (!hasSep && !(hasLine && hasExt)) continue;
    if (!/[A-Za-z]/.test(text)) continue;
    // "a/b" style words in prose: require an extension or a leading anchor.
    if (hasSep && !hasExt && !hasLine && !/^(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|[\\/])/.test(text)) continue;
    out.push({ start, end, text });
  }
  return out;
}
