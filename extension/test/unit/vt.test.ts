// gty-vt binding tests: run the real libghostty-vt module under Node.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { thunkModuleBytes, Vt, VtError } from '../../vt/core';
import { KEY_CODES, KeyEncoder, Mods, MouseEncoder, encodeFocus } from '../../vt/input';
import { loadVtSync } from '../../vt/loader';
import { CellFlag, RenderState, rowText, Underline, Wide } from '../../vt/render';
import { Search } from '../../vt/search';
import { format, gridRef, hyperlinkAt, selectAll, selectLine, selectOutput, selectWord, selEnds, SelectionGesture, setSelection } from '../../vt/selection';
import { restoreSnapshot } from '../../vt/snapshot';
import { Modes, Terminal } from '../../vt/terminal';

const WASM = process.env.GTY_VT_WASM ?? join(__dirname, '..', '..', 'media', 'ghostty-vt.wasm');
const bytes = readFileSync(WASM);
const mod = new WebAssembly.Module(bytes);
const load = (): Vt => loadVtSync(mod, { trackLeaks: true });
const ESC = '\x1b';
const ST = `${ESC}\\`;
const latin = (d: Uint8Array) => Buffer.from(d).toString('latin1');

function screenText(t: Terminal): string {
  const rs = new RenderState(t.vt);
  rs.update(t);
  const rows = rs.readRows(rs.colors().palette, false).map(rowText);
  rs.dispose();
  while (rows.length && !rows[rows.length - 1]) rows.pop();
  return rows.join('\n');
}

test('loads, reports version and features', () => {
  const vt = load();
  assert.equal(vt.version, '1.0.2');
  assert.ok(vt.features.renderState && vt.features.snapshot && vt.features.search && vt.features.selection);
});

test('thunk modules are valid WebAssembly', () => {
  for (const sig of [{ params: [] }, { params: ['i32', 'i32', 'i32', 'i32'] }, { params: ['i32', 'f64'], result: 'i32' }] as const) {
    assert.ok(WebAssembly.Module.exports(new WebAssembly.Module(<BufferSource>thunkModuleBytes({ params: [...sig.params], result: 'result' in sig ? sig.result : undefined }))).length === 1);
  }
});

test('memory growth keeps views and handles valid', () => {
  const vt = load();
  const before = vt.memory.buffer.byteLength;
  const t = Terminal.create(vt, { cols: 200, rows: 50, scrollbackBytes: 64 * 1024 * 1024 });
  const line = 'x'.repeat(199) + '\r\n';
  for (let i = 0; i < 20000; i++) t.write(line);
  assert.ok(vt.memory.buffer.byteLength > before, 'memory should have grown');
  t.write('\x1b[2J\x1b[Hafter growth');
  assert.equal(screenText(t).split('\n')[0], 'after growth');
  t.dispose();
});

test('errors map to VtError', () => {
  const vt = load();
  assert.throws(() => Terminal.create(vt, { cols: 0, rows: 24 }), VtError);
});

test('effects: replies, title, pwd, clipboard, notifications, prompts', () => {
  const vt = load();
  const replies: string[] = [];
  const events: string[] = [];
  const t = Terminal.create(vt, {
    cols: 80,
    rows: 24,
    xtversion: 'code-gty test',
    answerback: 'hi',
    colors: { foreground: 0xcccccc, background: 0x1e1e1e, cursor: 0xffffff },
    effects: {
      writePty: (d) => replies.push(latin(d)),
      titleChanged: (s) => events.push(`title:${s}`),
      pwdChanged: (s) => events.push(`pwd:${s}`),
      bell: () => events.push('bell'),
      size: () => ({ rows: 24, cols: 80, cellWidth: 9, cellHeight: 18 }),
      colorScheme: () => 'dark',
      clipboardWrite: (r) => (events.push(`clip:${Buffer.from(r.contents[0].data).toString()}`), { result: 'SUCCESS' }),
      clipboardRead: () => ({ result: 'SUCCESS', contents: [{ mime: 'text/plain', data: Buffer.from('pasted') }] }),
      desktopNotification: (a, b) => events.push(`notify:${a}|${b}`),
      progressReport: (s, p) => events.push(`progress:${s}:${p}`),
      programStatus: (r) => events.push(`status:${r.state}:${r.app}:${r.message}`),
      semanticPrompt: (e) => events.push(`prompt:${e.kind}${e.exitCode !== undefined ? ':' + e.exitCode : ''}`),
      unknownSequence: (s) => events.push(`unknown:${s.kind}:${Buffer.from(s.content).toString()}`),
      renderHold: (h) => events.push(`hold:${h}`),
      reset: () => events.push('reset'),
      resizeWindow: (r, c) => events.push(`resize:${r}x${c}`),
    },
    unknownMaxBytes: 1024,
  });
  t.write(`${ESC}]10;?${ST}${ESC}]11;?${ST}${ESC}[>0q${ESC}[c${ESC}[?u${ESC}[?2026$p${ESC}[18t${ESC}[?996n\x05`);
  assert.deepEqual(replies, [
    `${ESC}]10;rgb:cccc/cccc/cccc${ST}`,
    `${ESC}]11;rgb:1e1e/1e1e/1e1e${ST}`,
    `${ESC}P>|code-gty test${ST}`,
    `${ESC}[?62;22c`,
    `${ESC}[?0u`,
    `${ESC}[?2026;2$y`,
    `${ESC}[8;24;80t`,
    `${ESC}[?997;1n`,
    'hi',
  ]);
  replies.length = 0;
  t.write(`${ESC}]0;my title${ST}${ESC}]7;file://host/tmp${ST}\x07`);
  t.write(`${ESC}]52;c;${Buffer.from('copied').toString('base64')}${ST}${ESC}]52;c;?${ST}`);
  t.write(`${ESC}]9;hello${ST}${ESC}]9;4;1;40${ST}${ESC}]7501;state=working:app=cargo:msg=${Buffer.from('building').toString('base64')}${ST}`);
  t.write(`${ESC}]133;A${ST}$ ${ESC}]133;B${ST}ls${ESC}]133;C${ST}\r\nout\r\n${ESC}]133;D;2${ST}`);
  t.write(`${ESC}]7400;custom${ST}${ESC}[?2026h${ESC}[?2026l${ESC}[8;30;100t${ESC}c`);
  assert.deepEqual(replies, [`${ESC}]52;c;${Buffer.from('pasted').toString('base64')}${ST}`]);
  assert.deepEqual(events, [
    'title:my title',
    'pwd:file://host/tmp',
    'bell',
    'clip:copied',
    'notify:|hello',
    'progress:set:40',
    'status:working:cargo:building',
    'prompt:promptStart',
    'prompt:inputStart',
    'prompt:outputStart',
    'prompt:commandEnd:2',
    'unknown:osc:7400;custom',
    'hold:true',
    'hold:false',
    'resize:30x100',
    'progress:remove:-1',
    'status:clear::',
    'reset',
  ]);
  t.dispose();
});

test('write_until stops at OSC boundaries', () => {
  const vt = load();
  const t = Terminal.create(vt, { cols: 80, rows: 24 });
  const data = Buffer.from(`ab${ESC}]52;c;?${ESC}\\cd`);
  const B = 1 << 5; // OSC_START
  const stop = t.writeUntil(data, B);
  assert.ok(stop);
  assert.equal(stop.consumed, 4); // a, b, ESC, ]
  assert.equal(stop.kind, 'osc');
  assert.equal(t.writeUntil(data.subarray(stop.consumed), B), undefined);
  assert.equal(screenText(t), 'abcd');
  t.dispose();
});

test('render state: styles, colours, wide cells, graphemes, cursor', () => {
  const vt = load();
  const t = Terminal.create(vt, { cols: 20, rows: 4, colors: { foreground: 0xcccccc, background: 0x000000 } });
  t.write(`${ESC}[1;31mR${ESC}[0m${ESC}[4:3;58;2;255;0;0mU${ESC}[0m${ESC}[48;2;1;2;3m ${ESC}[0m日é👍${ESC}[9mS${ESC}[0m`);
  t.write(`\r\n${ESC}]8;;https://example.com${ST}link${ESC}]8;;${ST}`);
  const rs = new RenderState(vt);
  rs.update(t);
  assert.equal(rs.dirty, 'full');
  const colors = rs.colors();
  assert.equal(colors.foreground, 0xcccccc);
  const [r0, r1] = rs.readRows(colors.palette, false);
  const c = r0.cells;
  assert.equal(c[0].text, 'R');
  assert.ok(c[0].flags & CellFlag.Bold);
  assert.equal(c[0].fg, colors.palette[1]);
  assert.equal(c[1].underline, Underline.Curly);
  assert.equal(c[1].underlineColor, 0xff0000);
  assert.equal(c[2].bg, 0x010203);
  assert.equal(c[3].text, '日');
  assert.equal(c[3].wide, Wide.Wide);
  assert.equal(c[4].wide, Wide.SpacerTail);
  assert.equal(c[5].text, 'é');
  assert.equal(c[6].text, '👍');
  assert.ok(c[8].flags & CellFlag.Strikethrough);
  assert.ok(r1.cells[0].flags & CellFlag.Hyperlink);
  assert.equal(hyperlinkAt(t, { x: 1, y: 1 }), 'https://example.com');
  const cur = rs.cursor();
  assert.equal(cur.x, 4);
  assert.equal(cur.y, 1);
  rs.clean();
  rs.update(t);
  assert.equal(rs.dirty, 'clean');
  t.write('!');
  rs.update(t);
  assert.equal(rs.dirty, 'partial');
  assert.deepEqual(rs.readRows(colors.palette, true).map((r) => r.y), [1]);
  rs.dispose();
  t.dispose();
});

test('key encoder: legacy, application cursor keys, kitty protocol', () => {
  const vt = load();
  const t = Terminal.create(vt, { cols: 80, rows: 24 });
  const k = new KeyEncoder(vt);
  k.sync(t);
  const key = (code: string, mods = 0, text?: string, unshifted?: number) =>
    latin(k.encode({ action: 'press', key: KEY_CODES.get(code)!, mods, text, unshifted }));
  assert.equal(key('KeyA', 0, 'a', 0x61), 'a');
  assert.equal(key('KeyC', Mods.CTRL, 'c', 0x63), '\x03');
  assert.equal(key('ArrowUp'), `${ESC}[A`);
  assert.equal(key('Enter'), '\r');
  assert.equal(key('KeyB', Mods.ALT, 'b', 0x62), `${ESC}b`);
  t.write(`${ESC}[?1h`);
  k.sync(t);
  assert.equal(key('ArrowUp'), `${ESC}OA`);
  t.write(`${ESC}[>1u`); // kitty: disambiguate
  k.sync(t);
  assert.equal(key('Escape'), `${ESC}[27u`);
  assert.equal(key('KeyC', Mods.CTRL, 'c', 0x63), `${ESC}[99;5u`);
  k.sync(t, false);
  assert.equal(key('Escape'), ESC);
  k.dispose();
  t.dispose();
});

test('mouse and focus encoders follow modes', () => {
  const vt = load();
  const t = Terminal.create(vt, { cols: 80, rows: 24 });
  const m = new MouseEncoder(vt);
  m.setGeometry({ screenWidth: 800, screenHeight: 480, cellWidth: 10, cellHeight: 20 });
  m.sync(t);
  assert.equal(m.encode({ action: 'press', button: 1, mods: 0, x: 55, y: 45 }).length, 0);
  t.write(`${ESC}[?1000h${ESC}[?1006h`);
  m.sync(t);
  assert.equal(latin(m.encode({ action: 'press', button: 1, mods: 0, x: 55, y: 45 })), `${ESC}[<0;6;3M`);
  assert.equal(latin(m.encode({ action: 'release', button: 1, mods: 0, x: 55, y: 45 })), `${ESC}[<0;6;3m`);
  assert.equal(latin(encodeFocus(vt, true)), `${ESC}[I`);
  assert.equal(t.getMode(Modes.FOCUS_EVENT), false);
  m.dispose();
  t.dispose();
});

test('paste: bracketed, unsafe rejection, CR conversion', () => {
  const vt = load();
  const out: string[] = [];
  const t = Terminal.create(vt, { cols: 80, rows: 24, effects: { writePty: (d) => out.push(latin(d)) } });
  assert.equal(t.paste('echo hi\n'), 'rejected');
  assert.equal(t.paste('a\nb', { allowUnsafe: true }), 'pasted');
  assert.equal(out.join(''), 'a\rb');
  out.length = 0;
  t.write(`${ESC}[?2004h`);
  assert.equal(t.paste('x\ny'), 'pasted');
  assert.equal(out.join(''), `${ESC}[200~x\ny${ESC}[201~`);
  t.dispose();
});

test('selection, formatter and gestures', () => {
  const vt = load();
  const t = Terminal.create(vt, { cols: 40, rows: 6 });
  t.write(`${ESC}]133;A${ST}$ ${ESC}]133;B${ST}git status${ESC}]133;C${ST}\r\nOn branch main\r\nclean\r\n`);
  const word = selectWord(t, 'active', { x: 6, y: 0 })!;
  assert.equal(format(t, { selection: word }), 'status');
  assert.equal(format(t, { selection: selectLine(t, 'active', { x: 3, y: 0 })! }), 'git status');
  assert.equal(format(t, { selection: selectOutput(t, 'active', { x: 0, y: 1 })! }), 'On branch main\nclean');
  assert.match(format(t, { selection: selectAll(t)! }), /git status[\s\S]*clean/);
  assert.deepEqual(selEnds(t, word, 'viewport'), { start: { x: 6, y: 0 }, end: { x: 11, y: 0 }, rectangle: false });
  setSelection(t, word);
  const rs = new RenderState(vt);
  rs.update(t);
  assert.deepEqual(rs.readRows(rs.colors().palette, false)[0].selection, [6, 11]);
  rs.dispose();
  // Double click selects a word.
  const g = new SelectionGesture(vt, t);
  const ref = gridRef(t, 'viewport', { x: 3, y: 1 })!;
  g.press({ ref, x: 35, y: 30, timeMs: 1000 });
  g.release(ref);
  const dbl = g.press({ ref, x: 35, y: 30, timeMs: 1100 });
  assert.ok(dbl);
  assert.equal(format(t, { selection: dbl }), 'branch');
  g.dispose();
  assert.match(format(t, { format: 'html' }), /<div/);
  t.dispose();
});

test('search finds matches in scrollback and steps through them', () => {
  const vt = load();
  const t = Terminal.create(vt, { cols: 40, rows: 5, scrollbackLines: 1000 });
  for (let i = 0; i < 50; i++) t.write(`line ${i}${i % 10 === 0 ? ' ERROR' : ''}\r\n`);
  const s = new Search(vt, t);
  s.setNeedle('error');
  while (!s.step(50));
  assert.equal(s.total, 5);
  assert.ok(s.next());
  assert.equal(s.selectedIndex, 0);
  assert.equal(format(t, { selection: s.selectedMatch! }), 'ERROR');
  s.dispose();
  t.dispose();
});

test('snapshot restores an identical terminal in another instance', () => {
  const host = load();
  const mirror = load();
  const t = Terminal.create(host, { cols: 30, rows: 5, continuationMaxBytes: 1024, scrollbackLines: 1000 });
  for (let i = 0; i < 40; i++) t.write(`${ESC}[3${i % 8}mrow ${i}${ESC}[0m\r\n`);
  t.write(`${ESC}[?1049h${ESC}[2;3Halt screen${ESC}[?2004h${ESC}[31`); // unfinished SGR
  const m = restoreSnapshot(mirror, t.snapshot(), {});
  assert.equal(screenText(m), screenText(t));
  assert.equal(m.getMode(Modes.BRACKETED_PASTE), true);
  assert.equal(m.altScreen, true);
  // The unfinished SGR completes the same way in both.
  t.write('mX');
  m.write('mX');
  assert.equal(screenText(m), screenText(t));
  t.write(`${ESC}[?1049l`);
  m.write(`${ESC}[?1049l`);
  assert.equal(format(m), format(t));
  assert.equal(m.totalRows, t.totalRows);
  m.dispose();
  t.dispose();
});

test('resize reflows identically in two engines', () => {
  const a = Terminal.create(load(), { cols: 20, rows: 5 });
  const b = Terminal.create(load(), { cols: 20, rows: 5 });
  const text = 'the quick brown fox jumps over the lazy dog '.repeat(4);
  for (const t of [a, b]) {
    t.write(text);
    t.resize(13, 7, 9, 18);
    t.write('\r\nmore');
    t.resize(31, 4, 9, 18);
  }
  assert.equal(format(a), format(b));
  assert.equal(screenText(a), screenText(b));
  a.dispose();
  b.dispose();
});

test('render state: every cell of a styled run gets the style', () => {
  const vt = load();
  const t = Terminal.create(vt, { cols: 20, rows: 2 });
  t.write(`${ESC}[38;2;1;2;3m${ESC}[48;2;4;5;6mabc${ESC}[49mde${ESC}[0mf`);
  const rs = new RenderState(vt);
  rs.update(t);
  const c = rs.readRows(rs.colors().palette, false)[0].cells;
  assert.deepEqual(c.slice(0, 6).map((x) => [x.fg, x.bg]), [[0x010203, 0x040506], [0x010203, 0x040506], [0x010203, 0x040506], [0x010203, undefined], [0x010203, undefined], [undefined, undefined]]);
  rs.dispose();
  t.dispose();
});

test('kitty graphics: PNG images decode and are placed by the render state', async () => {
  const { deflateSync } = await import('node:zlib');
  const { KittyImages } = await import('../../vt/kitty');
  const { decodePng } = await import('../../vt/png');
  const vt = load();
  if (!vt.features.kittyGraphics) return;
  // A 3x2 PNG, palette with transparency, built by hand.
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) {
      c ^= x;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const td = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    td.copy(out, 4);
    out.writeUInt32BE(crc(td), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(3, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8; // depth
  ihdr[9] = 3; // palette
  const plte = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255]);
  const trns = Buffer.from([255, 128]);
  // Each row: filter byte (0 = None), then one palette index per pixel.
  const rows = Buffer.from([0, 0, 1, 2, 0, 2, 1, 0]);
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('tRNS', trns), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  const img = decodePng(png);
  assert.deepEqual([img.width, img.height], [3, 2]);
  assert.deepEqual([...img.rgba.slice(0, 12)], [255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255]);
  const replies: string[] = [];
  const t = Terminal.create(vt, { cols: 40, rows: 10, kittyImageStorageLimit: 1 << 24, effects: { writePty: (d) => replies.push(latin(d)) } });
  t.resize(40, 10, 10, 20);
  t.write(`${ESC}_Ga=T,f=100,i=7,c=2,r=1;${png.toString('base64')}${ST}`);
  assert.deepEqual(replies, [`${ESC}_Gi=7;OK${ST}`]);
  const rs = new RenderState(vt);
  rs.update(t);
  const k = new KittyImages(vt);
  const [p] = k.placements(rs);
  assert.equal(p.imageId, 7);
  assert.deepEqual([p.col, p.row, p.width, p.height], [0, 0, 20, 20]);
  const px = k.pixels(t, 7)!;
  assert.deepEqual([px.width, px.height, ...px.rgba.slice(4, 8)], [3, 2, 0, 255, 0, 128]);
  k.dispose();
  rs.dispose();
  t.dispose();
});
