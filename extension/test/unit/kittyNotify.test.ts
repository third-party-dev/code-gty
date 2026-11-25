// Kitty desktop notifications (OSC 99): assembly, options, replies, limits.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { classifyKittyNotification, HostEngine } from '../../src/engine/hostEngine';
import { KittyNotification, KittyNotifications, KittyOutcome, readMetadata } from '../../src/engine/kittyNotify';
import { loadVtSync } from '../../vt/loader';
import { format } from '../../vt/selection';

const ST = '\x1b\\';
const tick = () => new Promise((r) => setImmediate(r));

function setup(showIt = true) {
  const shown: KittyNotification[] = [];
  const replies: string[] = [];
  const answer: ((o: KittyOutcome) => void)[] = [];
  let focused = 0;
  const k = new KittyNotifications({
    show: (n) => {
      if (!showIt) return undefined;
      shown.push(n);
      return new Promise((r) => answer.push(r));
    },
    reply: (d) => replies.push(d),
    focus: () => focused++,
  });
  return { k, shown, replies, answer, focused: () => focused };
}

test('reads metadata as libghostty-vt does', () => {
  const m = readMetadata(' i = a1 :p=body:junk:u=2:u=0:x=bad;value');
  assert.equal(m.get('i'), 'a1');
  assert.equal(m.get('p'), 'body');
  assert.equal(m.get('u'), '2'); // the first valid value wins
  assert.equal(m.has('junk'), false);
});

test('a one-shot notification, with defaults', async () => {
  const t = setup();
  t.k.handle(';Hello', 'st');
  assert.deepEqual(t.shown, [{ title: 'Hello', body: '', buttons: [], urgency: 'normal', occasion: 'always', focus: true }]);
  t.answer[0]({ kind: 'activated' });
  await tick();
  assert.equal(t.focused(), 1);
  assert.deepEqual(t.replies, [], 'no id, nothing to report');
});

test('chunks are assembled by id, with base64 and options from any chunk', () => {
  const t = setup();
  t.k.handle('i=n1:d=0:u=2;Build', 'st');
  t.k.handle('i=other:d=0;unrelated', 'st');
  t.k.handle(`i=n1:d=0:e=1;${Buffer.from(' finished ✓').toString('base64')}`, 'st');
  t.k.handle('i=n1:p=body:d=0:o=unfocused;3 warnings', 'st');
  t.k.handle('i=n1:p=buttons:a=-focus,report;Open\u2028Ignore', 'st');
  assert.deepEqual(t.shown, [{ title: 'Build finished ✓', body: '3 warnings', buttons: ['Open', 'Ignore'], urgency: 'critical', occasion: 'unfocused', focus: false }]);
});

test('activation, button and close reports go back with the id', async () => {
  const t = setup();
  t.k.handle('i=job-7:a=report:c=1;Done', 'bel');
  t.answer[0]({ kind: 'activated' });
  await tick();
  assert.deepEqual(t.replies, [`\x1b]99;i=job-7;${ST}`, `\x1b]99;i=job-7:p=close;${ST}`]);

  t.replies.length = 0;
  t.k.handle('i=q:p=buttons:d=0;Yes\u2028No', 'st');
  t.k.handle('i=q;Proceed?', 'st');
  t.answer[1]({ kind: 'button', index: 2 });
  await tick();
  assert.deepEqual(t.replies, [`\x1b]99;i=q;2${ST}`], 'button reports need no a=report; no close report without c=1');

  t.replies.length = 0;
  t.k.handle('i=d:c=1;Dismiss me', 'st');
  t.answer[2]({ kind: 'closed' });
  await tick();
  assert.deepEqual(t.replies, [`\x1b]99;i=d:p=close;${ST}`]);
  assert.equal(t.focused(), 2, 'activating it and pressing a button focus the terminal; dismissing does not');
});

test('the program closing a notification stops its reports', async () => {
  const t = setup();
  t.k.handle('i=x:a=report:c=1;Hi', 'st');
  t.k.handle('i=x:p=close;', 'st');
  t.answer[0]({ kind: 'activated' });
  await tick();
  assert.deepEqual(t.replies, []);
});

test('queries: capabilities and live notifications, with the query terminator', () => {
  const t = setup();
  t.k.handle('i=caps:p=?;', 'bel');
  assert.equal(t.replies[0], '\x1b]99;i=caps:p=?;a=focus,report:o=always,unfocused,invisible:u=0,1,2:p=title,body,buttons,?,alive:c=1\x07');
  t.k.handle('i=a1;one', 'st');
  t.k.handle('i=a2;two', 'st');
  t.k.handle('i=probe:p=alive;', 'st');
  assert.equal(t.replies[1], `\x1b]99;i=probe:p=alive;a1,a2${ST}`);
});

test('replies never carry anything but a safe id', async () => {
  const t = setup();
  // An id with characters outside the spec's set is treated as no id.
  for (const bad of ['a b', 'x\r\nrm -rf ~', 'é', '$(id)', 'a;b']) {
    t.k.handle(`i=${bad}:a=report:c=1;Hi`, 'st');
    t.k.handle(`i=${bad}:p=?;`, 'st');
  }
  for (const a of t.answer) a({ kind: 'activated' });
  await tick();
  for (const r of t.replies) assert.match(r, /^\x1b\]99;i=0:p=\?;[a-z0-9=,:?]+\x1b\\$/, JSON.stringify(r));
});

test('limits: pending chunks and notifications on screen', () => {
  const t = setup();
  for (let i = 0; i < 40; i++) t.k.handle(`i=p${i}:d=0;part`, 'st');
  t.k.handle('i=p0;end', 'st'); // evicted long ago: shown as just "end"
  assert.equal(t.shown[0].title, 'end');
  for (let i = 0; i < 20; i++) t.k.handle(`;n${i}`, 'st');
  assert.equal(t.shown.length, 8, 'at most 8 in 10 s, even if none is ever answered');
  t.k.handle(`;${'x'.repeat(100000)}`, 'st');
  assert.equal(t.shown.length, 8);
});

test('nothing is shown for empty, icon-only or not-shown notifications', () => {
  const t = setup(false);
  t.k.handle('i=1;Hi', 'st');
  t.k.handle('i=2:a=report;Hi', 'st');
  assert.deepEqual(t.replies, []);
  const u = setup();
  u.k.handle(';', 'st');
  u.k.handle('p=icon;AAAA', 'st');
  u.k.handle('p=nonsense;Hi', 'st');
  u.k.handle('no semicolon', 'st');
  assert.equal(u.shown.length, 0);
});

test('classifies OSC 99 bodies', () => {
  const b = (x: string) => new Uint8Array(Buffer.from(x, 'utf8'));
  assert.deepEqual(classifyKittyNotification(b(`99;i=1;Hi ✓${ST}`)), { body: 'i=1;Hi ✓', terminator: 'st' });
  assert.deepEqual(classifyKittyNotification(b('99;;x\x07')), { body: ';x', terminator: 'bel' });
  assert.equal(classifyKittyNotification(b('99;;x')), 'incomplete');
  assert.equal(classifyKittyNotification(b('9')), 'incomplete');
  assert.equal(classifyKittyNotification(b('9;x\x07')), 'other');
  assert.equal(classifyKittyNotification(b('99;;x\x18')), 'other');
});

test('the host engine shows OSC 99 split across output chunks, and replies through the PTY', async () => {
  const mod = new WebAssembly.Module(readFileSync(process.env.GTY_VT_WASM ?? join(__dirname, '..', '..', 'media', 'ghostty-vt.wasm')));
  const pty: string[] = [];
  const shown: KittyNotification[] = [];
  let answer!: (o: KittyOutcome) => void;
  const e = new HostEngine(
    loadVtSync(mod),
    { cols: 40, rows: 5, scrollbackLines: 100, colors: {}, cursorStyle: 'block', cursorBlink: false, xtversion: 'x', answerback: '', clipboard: 'write' },
    {
      writePty: (d) => pty.push(Buffer.from(d).toString('latin1')),
      forward: () => undefined,
      showNotification: (n) => {
        shown.push(n);
        return new Promise((r) => (answer = r));
      },
    },
  );
  const enc = (x: string) => new Uint8Array(Buffer.from(x, 'utf8'));
  e.push(enc('a\x1b]9'));
  e.push(enc('9;i=t:a=report;Te'));
  e.push(enc(`sts passed${ST}b`));
  assert.equal(shown[0]?.title, 'Tests passed');
  assert.match(format(e.term), /^ab/);
  answer({ kind: 'activated' });
  await tick();
  assert.deepEqual(pty, [`\x1b]99;i=t;${ST}`]);
});
