import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultPassThrough, KeyMatcher, keyName, parseKey } from '../../src/shared/keys';
import { parseWebviewMessage } from '../../src/shared/messages';
import { isMultiline, preparePaste } from '../../src/shared/paste';
import { findFileLinks } from '../../webview/fileLinks';
import { cellRuns, findLink, splitHyperlinks } from '../../webview/hyperlinks';
import { PromptMarks } from '../../webview/marks';
import { normalizeColor } from '../../webview/theme';

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
  const send = new KeyMatcher(defaultPassThrough('linux', true));
  assert.ok(!send.test(ev('KeyP', { ctrlKey: true })));
  assert.ok(send.test(ev('F1')));
});

test('webview message validation', () => {
  assert.deepEqual(parseWebviewMessage({ type: 'resize', cols: 80, rows: 24 }), { type: 'resize', cols: 80, rows: 24 });
  assert.equal(parseWebviewMessage({ type: 'resize', cols: 0, rows: 24 }), undefined);
  assert.equal(parseWebviewMessage({ type: 'resize', cols: 1.5, rows: 24 }), undefined);
  assert.equal(parseWebviewMessage({ type: 'input', data: 5 }), undefined);
  assert.equal(parseWebviewMessage({ type: 'evil' }), undefined);
  assert.equal(parseWebviewMessage(null), undefined);
  assert.deepEqual(parseWebviewMessage({ type: 'paste', bracketed: 'yes' }), { type: 'paste', bracketed: false });
  assert.equal(parseWebviewMessage({ type: 'openLink', kind: 'javascript', text: 'x' }), undefined);
});

test('paste preparation', () => {
  assert.equal(preparePaste('a\nb\r\nc'), 'a\rb\rc');
  assert.equal(preparePaste('x\x1b[201~rm -rf /\x1b[200~'), 'xrm -rf /');
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

test('prompt mark splitting', () => {
  const m = new PromptMarks();
  const enc = new TextEncoder();
  const segs = m.split(enc.encode('out\x1b]133;D;1\x07\x1b]133;A\x07$ \x1b]133;B\x07'));
  assert.deepEqual(segs.map((s) => s.markAfter), ['D;1', 'A', 'B', undefined]);
  assert.equal(new TextDecoder().decode(segs[0].bytes), 'out\x1b]133;D;1\x07');
  assert.equal(segs[3].bytes.length, 0);
  // An unterminated sequence stays in one piece.
  assert.equal(m.split(enc.encode('a\x1b]133;A')).length, 1);
});

test('splitHyperlinks ends a segment at each OSC 8 sequence', () => {
  const enc = (t: string) => new TextEncoder().encode(t);
  const dec = (b: Uint8Array) => new TextDecoder().decode(b);
  const parts = splitHyperlinks(enc('a\x1b]8;;https://x.example/1\x1b\\link\x1b]8;;\x07b\x1b]8;id=7;file://h/p\x07c\x1b]8;;'));
  assert.deepEqual(
    parts.map((p) => [dec(p.bytes), p.linkAfter]),
    [
      ['a\x1b]8;;https://x.example/1\x1b\\', 'https://x.example/1'],
      ['link\x1b]8;;\x07', ''],
      ['b\x1b]8;id=7;file://h/p\x07', 'file://h/p'],
      // An unterminated sequence stays in the last segment.
      ['c\x1b]8;;', undefined],
    ],
  );
});

test('cellRuns and findLink match linked cells to recorded links', () => {
  assert.deepEqual(cellRuns([false, true, true, false, true]), [{ start: 1, end: 3 }, { start: 4, end: 5 }]);
  const records = [
    { uri: 'https://a', start: { line: 3, x: 2 }, end: { line: 3, x: 5 }, text: 'AAA' },
    { uri: 'https://b', start: { line: 3, x: 6 }, end: { line: 4, x: 2 }, text: 'BBBBBB' },
  ];
  assert.equal(findLink(records, 3, { start: 2, end: 5 }, 'AAA')?.uri, 'https://a');
  assert.equal(findLink(records, 4, { start: 0, end: 2 }, 'BB')?.uri, 'https://b', 'second row of a wrapped link');
  assert.equal(findLink(records, 9, { start: 0, end: 3 }, 'AAA')?.uri, 'https://a', 'moved by reflow: found by text');
  assert.equal(findLink(records, 9, { start: 0, end: 3 }, 'ZZZ'), undefined, 'unknown run: no link');
});
