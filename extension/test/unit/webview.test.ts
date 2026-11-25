import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultPassThrough, KeyMatcher, keyName, parseKey } from '../../src/shared/keys';
import { parseWebviewMessage } from '../../src/shared/messages';
import { isMultiline } from '../../src/shared/paste';
import { findFileLinks } from '../../term/fileLinks';
import { contrast, ensureContrast } from '../../term/renderer';
import { normalizeColor, readTheme, themePalette } from '../../term/theme';

const ev = (code: string, mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>> = {}, key = '') => ({
  code,
  key,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

test('key specs', () => {
  assert.deepEqual(parseKey('ctrl+shift+p'), { ctrl: true, shift: true, alt: false, meta: false, key: 'p' });
  assert.deepEqual(parseKey('cmd++'), { ctrl: false, shift: false, alt: false, meta: true, key: '+' });
  assert.equal(parseKey('hyper+x'), undefined);
  assert.equal(keyName('Backquote', '`'), '`');
  assert.equal(keyName('KeyP', 'π'), 'p');
});

test('pass-through matcher', () => {
  const m = new KeyMatcher(defaultPassThrough('linux', false));
  assert.ok(m.test(ev('KeyP', { ctrlKey: true })));
  assert.ok(m.test(ev('KeyP', { ctrlKey: true, shiftKey: true })));
  assert.ok(m.test(ev('Backquote', { ctrlKey: true })));
  assert.ok(!m.test(ev('KeyC', { ctrlKey: true })), 'Ctrl+C must reach the shell');
  assert.ok(!m.test(ev('KeyR', { ctrlKey: true })), 'Ctrl+R must reach the shell');
  // Keys VS Code's own terminal gives the shell (not in its commandsToSkipShell).
  for (const [code, mods, why] of [
    ['KeyB', { ctrlKey: true }, 'tmux prefix'],
    ['KeyE', { ctrlKey: true }, 'end of line'],
    ['KeyW', { ctrlKey: true }, 'delete word'],
    ['KeyN', { ctrlKey: true }, 'next history'],
    ['Digit0', { ctrlKey: true }, 'focusSideBar is not skipped'],
    ['Comma', { ctrlKey: true }, 'settings is not skipped'],
    ['KeyE', { ctrlKey: true, shiftKey: true }, 'explorer is not skipped'],
    ['F5', {}, 'debug start is contextual'],
    ['F10', {}, 'htop and mc use F10'],
  ] as const) {
    assert.ok(!m.test(ev(code, mods)), `${code} ${JSON.stringify(mods)} must reach the shell (${why})`);
  }
  assert.ok(m.test(ev('Tab', { ctrlKey: true })));
  assert.ok(m.test(ev('PageDown', { ctrlKey: true })));
  assert.ok(m.test(ev('F6')));
  const send = new KeyMatcher(defaultPassThrough('linux', true));
  assert.ok(!send.test(ev('KeyP', { ctrlKey: true })));
  assert.ok(send.test(ev('F1')));
});

test('webview message validation', () => {
  assert.deepEqual(parseWebviewMessage({ type: 'resize', cols: 80, rows: 24, cellWidth: 9, cellHeight: 18 }), { type: 'resize', cols: 80, rows: 24, cellWidth: 9, cellHeight: 18 });
  assert.equal(parseWebviewMessage({ type: 'resize', cols: 80, rows: 24 }), undefined);
  assert.equal(parseWebviewMessage({ type: 'resize', cols: 0, rows: 24, cellWidth: 9, cellHeight: 18 }), undefined);
  assert.equal(parseWebviewMessage({ type: 'resize', cols: 1.5, rows: 24, cellWidth: 9, cellHeight: 18 }), undefined);
  assert.deepEqual(parseWebviewMessage({ type: 'input', data: '\x9b', binary: true }), { type: 'input', data: '\x9b', binary: true });
  assert.deepEqual(parseWebviewMessage({ type: 'theme', foreground: 1, background: 2, cursor: 3, palette: Array(16).fill(0) }), {
    type: 'theme',
    foreground: 1,
    background: 2,
    cursor: 3,
    palette: Array(16).fill(0),
  });
  assert.equal(parseWebviewMessage({ type: 'theme', foreground: 1, background: 2, cursor: 3, palette: [1] }), undefined);
  assert.equal(parseWebviewMessage({ type: 'input', data: 5 }), undefined);
  assert.equal(parseWebviewMessage({ type: 'evil' }), undefined);
  assert.equal(parseWebviewMessage(null), undefined);
  assert.deepEqual(parseWebviewMessage({ type: 'paste', bracketed: 'yes' }), { type: 'paste' });
  assert.deepEqual(parseWebviewMessage({ type: 'paste', text: 'x' }), { type: 'paste', text: 'x' });
  assert.equal(parseWebviewMessage({ type: 'openLink', kind: 'javascript', text: 'x' }), undefined);
});

test('paste preparation', () => {
  assert.ok(isMultiline('a\nb'));
  assert.ok(!isMultiline('one line\n'));
});

test('file link detection', () => {
  const texts = (s: string) => findFileLinks(s).map((l) => l.text);
  assert.deepEqual(texts('error at src/main.rs:10:5: oops'), ['src/main.rs:10:5']);
  assert.deepEqual(texts('see ./build.sh and /etc/hosts.'), ['./build.sh', '/etc/hosts']);
  assert.deepEqual(texts('visit https://example.com/a/b.html now'), []);
  assert.deepEqual(texts('and/or plain words'), []);
  assert.deepEqual(texts('main.py:42 failed'), ['main.py:42']);
  const [l] = findFileLinks('x lib/a.ts y');
  assert.equal(l.start, 2);
  assert.equal(l.end, 10);
});

test('colour normalisation', () => {
  assert.equal(normalizeColor('#abc'), '#aabbcc');
  assert.equal(normalizeColor('#112233'), '#112233');
  assert.equal(normalizeColor('#ffffff80', '#000000'), '#808080');
  assert.equal(normalizeColor('rgba(255, 0, 0, 0.5)', '#000000'), '#800000');
  assert.equal(normalizeColor('blue'), undefined);
});

test('theme palette and minimum contrast', () => {
  const css = { getPropertyValue: (n: string) => ({ '--vscode-terminal-background': '#1e1e1e', '--vscode-terminal-ansiRed': '#ff0000' })[n] ?? '' };
  const t = readTheme(css, { blue: '#0000ff' });
  const pal = themePalette(t);
  assert.equal(pal.length, 16);
  assert.equal(pal[1], 0xff0000);
  assert.equal(pal[4], 0x0000ff);
  // Dark grey on black is raised to 4.5:1.
  const fg = ensureContrast(0x333333, 0x000000, 4.5);
  assert.ok(contrast(fg, 0x000000) >= 4.5);
  assert.equal(ensureContrast(0xffffff, 0x000000, 4.5), 0xffffff);
});
