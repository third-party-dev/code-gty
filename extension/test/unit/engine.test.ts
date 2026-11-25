// Host engine: effects, ordering and the asynchronous clipboard prefetch.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { classifyConEmu, classifyOsc, EngineHost, EngineOptions, HostEngine, oscEnd } from '../../src/engine/hostEngine';
import { loadVtSync } from '../../vt/loader';
import { format } from '../../vt/selection';
import { restoreSnapshot } from '../../vt/snapshot';

const mod = new WebAssembly.Module(readFileSync(process.env.GTY_VT_WASM ?? join(__dirname, '..', '..', 'media', 'ghostty-vt.wasm')));
const ESC = '\x1b';
const ST = `${ESC}\\`;
const b = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'));
const s = (d: Uint8Array) => Buffer.from(d).toString('latin1');

const OPTS: EngineOptions = {
  cols: 40,
  rows: 10,
  scrollbackLines: 1000,
  colors: { foreground: 0xcccccc, background: 0x1e1e1e },
  cursorStyle: 'block',
  cursorBlink: false,
  xtversion: 'code-gty 0.0.0 (libghostty-vt 1.0.2)',
  answerback: '',
  clipboard: 'readWrite',
};

function engine(overrides: Partial<EngineHost> = {}, opts: Partial<EngineOptions> = {}) {
  const pty: string[] = [];
  const forwarded: string[] = [];
  const events: string[] = [];
  let release: ((text: string | undefined) => void) | undefined;
  const host: EngineHost = {
    writePty: (d) => pty.push(s(d)),
    forward: (d) => forwarded.push(s(d)),
    title: (t) => events.push(`title:${t}`),
    clipboardWrite: (t) => events.push(`copy:${t}`),
    clipboardRead: () => new Promise((resolve) => (release = resolve)),
    ...overrides,
  };
  const e = new HostEngine(loadVtSync(mod), { ...OPTS, ...opts }, host);
  return { e, pty, forwarded, events, release: (t: string | undefined) => release!(t) };
}

test('classifies OSC bodies', () => {
  assert.equal(classifyOsc(b(`52;c;?${ST}`)), 'clipboardRead');
  assert.equal(classifyOsc(b('52;c;?\x07rest')), 'clipboardRead');
  assert.equal(classifyOsc(b('52;c;aGk=\x07')), 'other');
  assert.equal(classifyOsc(b('52;c')), 'incomplete');
  assert.equal(classifyOsc(b('5')), 'incomplete');
  assert.equal(classifyOsc(b('0;title')), 'other');
  assert.equal(classifyOsc(b(`5522;type=read:mime=dGV4dC9wbGFpbg==${ST}`)), 'clipboardRead');
  assert.equal(oscEnd(b(`0;x${ST}y`)), 5);
  assert.equal(oscEnd(b('0;x')), 0);
});

test('forwards processed bytes in order and answers queries', () => {
  const { e, pty, forwarded, events } = engine();
  e.push(b(`hello ${ESC}]0;T${ST}${ESC}[>0q world`));
  assert.equal(forwarded.join(''), `hello ${ESC}]0;T${ST}${ESC}[>0q world`);
  assert.deepEqual(pty, [`${ESC}P>|code-gty 0.0.0 (libghostty-vt 1.0.2)${ST}`]);
  assert.deepEqual(events, ['title:T']);
  e.dispose();
});

test('OSC 52 read waits for the clipboard, split across chunks', async () => {
  const { e, pty, forwarded, release } = engine();
  e.push(b(`before ${ESC}]5`));
  e.push(b('2;c'));
  // Undecidable yet: held back, not forwarded.
  assert.equal(forwarded.join(''), `before ${ESC}]`);
  e.push(b(`;?${ST}after`));
  assert.equal(e.heldBytes, `52;c;?${ST}after`.length);
  e.push(b(' more'));
  release('clip text');
  await new Promise((r) => setImmediate(r));
  assert.equal(forwarded.join(''), `before ${ESC}]52;c;?${ST}after more`);
  assert.deepEqual(pty, [`${ESC}]52;c;${Buffer.from('clip text').toString('base64')}${ST}`]);
  assert.equal(e.heldBytes, 0);
  e.dispose();
});

test('OSC 52 read is denied without readWrite, with no delay', () => {
  const { e, pty, forwarded } = engine({}, { clipboard: 'write' });
  e.push(b(`${ESC}]52;c;?${ST}x`));
  assert.equal(forwarded.join(''), `${ESC}]52;c;?${ST}x`);
  assert.deepEqual(pty, [`${ESC}]52;c;${ST}`]);
  e.dispose();
});

test('OSC 52 write reaches the clipboard unless off', () => {
  const on = engine();
  on.e.push(b(`${ESC}]52;c;${Buffer.from('hi').toString('base64')}${ST}`));
  assert.deepEqual(on.events, ['copy:hi']);
  const off = engine({}, { clipboard: 'off' });
  off.e.push(b(`${ESC}]52;c;${Buffer.from('hi').toString('base64')}${ST}`));
  assert.deepEqual(off.events, []);
  // DA1 advertises clipboard support only when allowed.
  on.e.push(b(`${ESC}[c`));
  off.e.push(b(`${ESC}[c`));
  assert.deepEqual(on.pty, [`${ESC}[?62;22;52c`]);
  assert.deepEqual(off.pty, [`${ESC}[?62;22c`]);
});

test('a mirror restored from a snapshot matches, then follows forwarded output', () => {
  const { e, forwarded } = engine();
  for (let i = 0; i < 30; i++) e.push(b(`line ${i}\r\n`));
  e.push(b(`${ESC}[1;32mgreen${ESC}[`));
  const mirror = restoreSnapshot(loadVtSync(mod), e.snapshot(), {});
  forwarded.length = 0;
  e.push(b('0mplain'));
  for (const f of forwarded) mirror.write(b(f));
  assert.equal(format(mirror), format(e.term));
  mirror.dispose();
  e.dispose();
});

test('paste rejects unsafe text unless allowed', () => {
  const { e, pty } = engine();
  assert.equal(e.paste('ls\n', false), 'rejected');
  assert.deepEqual(pty, []);
  assert.equal(e.paste('ls\n', true), 'pasted');
  assert.deepEqual(pty, ['ls\r']);
  e.dispose();
});

test('last command output and text', () => {
  const { e } = engine();
  e.push(b(`${ESC}]133;A${ST}$ ${ESC}]133;B${ST}echo hi${ESC}]133;C${ST}\r\nhi\r\nthere\r\n${ESC}]133;D;0${ST}${ESC}]133;A${ST}$ `));
  assert.equal(e.lastCommandOutput(), 'hi\nthere');
  assert.match(e.text(), /echo hi/);
  e.dispose();
});

test('host and mirror stay identical through full-screen output and resizes', () => {
  const vt = loadVtSync(mod);
  const { e, forwarded } = engine();
  const mirror = restoreSnapshot(vt, e.snapshot(), {});
  // Deterministic pseudo-random session in the style of vim, htop, less and tmux.
  let seed = 12345;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  const words = ['hello', '日本語', 'é', '👍', '\t', 'x'.repeat(30), '─│┌┐'];
  const ops = [
    () => `\x1b[${rnd(10) + 1};${rnd(40) + 1}H`,
    () => `\x1b[3${rnd(8)};4${rnd(8)}m${words[rnd(words.length)]}\x1b[0m`,
    () => `\x1b[${rnd(3)}J`,
    () => `\x1b[${rnd(3)}K`,
    () => `\x1b[${rnd(3) + 1}L`,
    () => `\x1b[${rnd(3) + 1}M`,
    () => `\x1b[${rnd(5) + 1};${rnd(5) + 6}r`,
    () => '\x1b[r',
    () => (rnd(2) ? '\x1b[?1049h' : '\x1b[?1049l'),
    () => `\x1b[${rnd(4) + 1}@`,
    () => `\x1b[${rnd(4) + 1}P`,
    () => '\r\n'.repeat(rnd(4)),
    () => `\x1b]8;;https://e.x/${rnd(9)}\x1b\\link\x1b]8;;\x1b\\`,
    () => `\x1b[?2004${rnd(2) ? 'h' : 'l'}`,
  ];
  for (let step = 0; step < 400; step++) {
    let chunk = '';
    for (let k = 0; k < 8; k++) chunk += ops[rnd(ops.length)]();
    forwarded.length = 0;
    e.push(b(chunk));
    for (const f of forwarded) mirror.write(b(f));
    if (step % 37 === 0) {
      const cols = 20 + rnd(80);
      const rows = 5 + rnd(30);
      e.resize(cols, rows, { cellWidth: 9, cellHeight: 18 });
      mirror.resize(cols, rows, 9, 18);
    }
    if (step % 50 === 0) assert.equal(format(mirror, { format: 'vt' }), format(e.term, { format: 'vt' }), `diverged at step ${step}`);
  }
  assert.equal(format(mirror, { format: 'vt' }), format(e.term, { format: 'vt' }));
  assert.equal(mirror.altScreen, e.term.altScreen);
  assert.deepEqual([mirror.cursorX, mirror.cursorY], [e.term.cursorX, e.term.cursorY]);
  mirror.dispose();
  e.dispose();
});

test('grapheme clustering (mode 2027) is on by default, as in Ghostty, and survives a reset', () => {
  const { e } = engine();
  const width = (s: string) => {
    e.push(b('\r'));
    e.push(new TextEncoder().encode(s));
    return e.term.cursorX;
  };
  assert.equal(width('❤️'), 2, 'heart + VS16');
  assert.equal(width('\u{1F1EC}\u{1F1E7}'), 2, 'flag');
  assert.equal(width('\u{1F468}‍\u{1F469}‍\u{1F467}'), 2, 'ZWJ family');
  e.push(b('\x1bc'));
  assert.equal(width('❤️'), 2, 'after RIS');
  // The mirror, restored from a snapshot, keeps the same default for a later RIS.
  e.push(b('\x1b[?2027l'));
  const mirror = restoreSnapshot(loadVtSync(mod), e.snapshot(), { modeDefaults: { [0x7eb]: true } });
  assert.equal(width('❤️'), 1, 'a program may turn it off');
  mirror.write(b('\x1bc'));
  e.push(b('\x1bc'));
  assert.equal(width('❤️'), 2);
  mirror.dispose();
  e.dispose();
});

test('Kitty text sizing (OSC 66) falls back to printing its text at normal size', () => {
  const { e, forwarded } = engine();
  e.push(b('a\x1b]6'));
  e.push(b('6;s=2;Big '));
  e.push(b('text\x1b\\|'));
  // Control characters in the text are dropped, not executed.
  e.push(b('\x1b]66;w=1;A\x08B\x07|end'));
  assert.equal(format(e.term), 'aBig text|AB|end');
  // The mirror sees the same thing: the cancelled introducer, then the text.
  const mirror = restoreSnapshot(loadVtSync(mod), new HostEngine(loadVtSync(mod), OPTS, { writePty: () => undefined, forward: () => undefined }).snapshot(), {});
  for (const f of forwarded) mirror.write(b(f));
  assert.equal(format(mirror), format(e.term));
  mirror.dispose();
  e.dispose();
});

test('classifies ConEmu OSC 9 commands as libghostty-vt parses them', () => {
  const kind = (body: string) => {
    const c = classifyConEmu(b(body));
    return typeof c === 'object' ? c.kind : c;
  };
  assert.deepEqual(classifyConEmu(b('9;3;build \xc3\xa9\x07')), { kind: 'tabTitle', title: 'build é' });
  assert.deepEqual(classifyConEmu(b(`9;3;${ST}`)), { kind: 'tabTitle', title: undefined });
  assert.deepEqual(classifyConEmu(b('9;2;hello\x07')), { kind: 'messageBox', text: 'hello' });
  for (const body of ['9;1;500', '9;5', '9;6;Tab(1)', '9;7;calc', '9;8;PATH', '9;10', '9;10;2', '9;11;note']) assert.equal(kind(`${body}\x07`), 'dropped', body);
  // Forms libghostty-vt handles itself, or reads as a notification.
  for (const body of ['9;hello', '9;1', '9;12', '9;4;1;50', '9;9;/tmp', '9;2', '9;3', '9;10;', '9;10;7', '9;6', '0;title', '99;x', '7;file:///']) assert.equal(kind(`${body}\x07`), 'other', body);
  assert.equal(kind('9;3;abc'), 'incomplete');
  assert.equal(kind('9'), 'incomplete');
  assert.equal(kind(''), 'incomplete');
  // Aborted by another ESC (even after a literal backslash) or cancelled: nothing happens.
  assert.equal(kind('9;3;a\\\x1b['), 'other');
  assert.equal(kind('9;3;a\x18'), 'other');
});

test('ConEmu tab title and message box reach the host; dropped commands go to unknownSequence', () => {
  const events: string[] = [];
  const { e, forwarded } = engine({
    tabTitle: (t) => events.push(`tab:${t ?? '<reset>'}`),
    messageBox: (t) => events.push(`box:${t}`),
    notification: (t, body) => events.push(`note:${t}|${body}`),
    unknownSequence: (q) => events.push(`unknown:${s(q.content)}`),
    pwd: (p) => events.push(`pwd:${p}`),
  });
  // Split across chunks, between the introducer and the body.
  e.push(b(`a${ESC}]9;3;`));
  e.push(b(`tab one${ST}b${ESC}]9;2;hi\x07${ESC}]9;7;rm -rf /\x07${ESC}]9;just a note\x07${ESC}]9;3;\x07c`));
  e.push(b(`${ESC}]9;9;/srv/app\x07`));
  assert.deepEqual(events, ['tab:tab one', 'box:hi', 'unknown:9;7;rm -rf /', 'note:|just a note', 'tab:<reset>', 'pwd:/srv/app']);
  // Every byte still reaches the mirror, in order.
  assert.equal(forwarded.join(''), `a${ESC}]9;3;tab one${ST}b${ESC}]9;2;hi\x07${ESC}]9;7;rm -rf /\x07${ESC}]9;just a note\x07${ESC}]9;3;\x07c${ESC}]9;9;/srv/app\x07`);
  assert.match(format(e.term), /^abc/);
});
