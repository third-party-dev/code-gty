// Sixel and iTerm2 images: recognition, sizing, Kitty commands, and the host
// engine's handling of the stream around them.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { HostEngine } from '../../src/engine/hostEngine';
import { classifyDcs, classifyImageOsc, itermPlacement, kittyCommands, parseItermArgs } from '../../src/engine/imageBridge';
import type { DecodeRequest, DecodedImage } from '../../src/sidecar';
import { KittyImages } from '../../vt/kitty';
import { loadVtSync } from '../../vt/loader';
import { RenderState } from '../../vt/render';

const mod = new WebAssembly.Module(readFileSync(process.env.GTY_VT_WASM ?? join(__dirname, '..', '..', 'media', 'ghostty-vt.wasm')));
const b = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'));
const s = (d: Uint8Array) => Buffer.from(d).toString('latin1');

function solid(w: number, h: number, frames = 1): DecodedImage {
  const rgba = Buffer.alloc(w * h * 4, 0xff);
  return { width: w, height: h, frames: Array.from({ length: frames }, () => ({ delayMs: 50, zrgba: new Uint8Array(deflateSync(rgba)) })) };
}

test('recognises sixel and iTerm2 sequences from their first bytes', () => {
  assert.equal(classifyDcs(b('0;0;0q"1;1')), 'sixel');
  assert.equal(classifyDcs(b('q#1')), 'sixel');
  assert.equal(classifyDcs(b('0;1')), 'incomplete');
  assert.equal(classifyDcs(b('$qm')), 'other'); // DECRQSS
  assert.equal(classifyDcs(b('+q544e')), 'other'); // XTGETTCAP
  assert.equal(classifyImageOsc(b('1337;File=inline=1:AAAA')), 'image');
  assert.equal(classifyImageOsc(b('1337;FilePart=AA')), 'image');
  assert.equal(classifyImageOsc(b('1337;Fi')), 'incomplete');
  assert.equal(classifyImageOsc(b('1337;CurrentDir=/tmp')), 'other');
  assert.equal(classifyImageOsc(b('0;title')), 'other');
});

test('iTerm2 sizes: cells, pixels, percent, auto, aspect ratio', () => {
  const g = { cols: 80, rows: 24, cellWidth: 10, cellHeight: 20 };
  const p = (args: string, w = 200, h = 100) => itermPlacement(parseItermArgs(`inline=1;${args}`), w, h, g);
  assert.deepEqual(p(''), {}, 'native size');
  assert.deepEqual(p('', 2000, 100), { cols: 80 }, 'never wider than the terminal');
  assert.deepEqual(p('width=12'), { cols: 12 });
  assert.deepEqual(p('width=55px'), { cols: 6 });
  assert.deepEqual(p('width=50%'), { cols: 40 });
  assert.deepEqual(p('height=3'), { rows: 3 });
  assert.deepEqual(p('width=10;height=10'), { cols: 10 }, 'fits the box keeping the ratio');
  assert.deepEqual(p('width=10;height=10;preserveAspectRatio=0'), { cols: 10, rows: 10 });
  assert.equal(parseItermArgs('width=3').inline, false);
});

test('Kitty commands are chunked, compressed RGBA, with animation frames', () => {
  const big = solid(100, 100);
  big.frames[0].zrgba = new Uint8Array(9000).fill(7); // forces three chunks
  const cmds = kittyCommands(big, 5, { cols: 4, moveCursor: true });
  const parts = cmds.split('\x1b\\').filter(Boolean);
  assert.equal(parts.length, 3);
  assert.match(parts[0], /^\x1b_Ga=T,f=32,o=z,s=100,v=100,i=5,q=2,C=0,c=4,m=1;/);
  assert.match(parts[1], /^\x1b_Gm=1;/);
  assert.match(parts[2], /^\x1b_Gm=0;/);
  const anim = kittyCommands(solid(2, 2, 3), 6, { moveCursor: false });
  assert.equal((anim.match(/a=f,/g) ?? []).length, 2);
  assert.match(anim, /a=a,i=6,s=3,v=1/);
  assert.match(anim, /C=1/);
});

function engine(decode: (req: DecodeRequest) => Promise<DecodedImage | undefined>) {
  const forwarded: { data: string; fromPty: boolean }[] = [];
  const pty: string[] = [];
  let dropped = 0;
  const reqs: DecodeRequest[] = [];
  const e = new HostEngine(
    loadVtSync(mod),
    { cols: 40, rows: 10, scrollbackLines: 100, colors: { background: 0x102030 }, cursorStyle: 'block', cursorBlink: false, xtversion: 'x', answerback: '', clipboard: 'write' },
    {
      writePty: (d) => pty.push(s(d)),
      forward: (d, fromPty) => forwarded.push({ data: s(d), fromPty }),
      decodeImage: (r) => (reqs.push(r), decode(r)),
      dropped: (n) => (dropped += n),
    },
  );
  e.resize(40, 10, { cellWidth: 10, cellHeight: 20 });
  return { e, forwarded, pty, reqs, dropped: () => dropped };
}

const tick = () => new Promise((r) => setImmediate(r));

test('a sixel image is decoded, placed as Kitty graphics, and nothing overtakes it', async () => {
  let release!: (d: DecodedImage) => void;
  const { e, forwarded, pty, reqs, dropped } = engine(() => new Promise((r) => (release = r)));
  const sixel = '\x1bP0;0;0q"1;1;40;18#1;2;100;0;0#1!40~-!40~-!40~\x1b\\';
  e.push(b(`A${sixel}`));
  e.push(b('after'));
  // Waiting for the decode: the text after the image is held back.
  assert.ok(!forwarded.some((f) => f.data.includes('after')));
  assert.equal(reqs[0].kind, 'sixel');
  assert.equal(s(reqs[0].data), '0;0;0q"1;1;40;18#1;2;100;0;0#1!40~-!40~-!40~');
  assert.equal(reqs[0].background, 0x102030);
  release(solid(40, 18));
  await tick();
  const all = forwarded.map((f) => f.data).join('');
  // Introducer (from the PTY), CAN (ours), the Kitty image, the cursor moved below it, then the text.
  assert.match(all, /^A\x1bP\x18\x1b_Ga=T,f=32,o=z,s=40,v=18,i=\d+,q=2,C=1,m=0;[^\x1b]+\x1b\\\nafter$/);
  // Every PTY byte is either forwarded (and acked by the webview) or dropped (acked by the host).
  const fromPty = forwarded.filter((f) => f.fromPty).reduce((n, f) => n + f.data.length, 0);
  assert.equal(fromPty + dropped(), `A${sixel}after`.length);
  const rs = new RenderState(e.vt);
  rs.update(e.term);
  const [p] = new KittyImages(e.vt).placements(rs);
  assert.deepEqual([p.col, p.row, p.width, p.height], [1, 0, 40, 18]);
  assert.deepEqual(pty, []);
  // DA1 advertises sixel.
  e.push(b('\x1b[c'));
  assert.deepEqual(pty, ['\x1b[?62;4;22;52c']);
  e.dispose();
});

test('iTerm2 images, single and multipart, with a failed decode leaving the stream intact', async () => {
  const { e, forwarded, reqs } = engine(async (r) => (r.data.length === 3 ? solid(30, 30) : undefined));
  const data = Buffer.from([1, 2, 3]).toString('base64');
  e.push(b(`\x1b]1337;File=inline=1;width=2:${data}\x07x`));
  await tick();
  e.push(b(`\x1b]1337;MultipartFile=inline=1\x07\x1b]1337;FilePart=${data.slice(0, 2)}\x07\x1b]1337;FilePart=${data.slice(2)}\x07\x1b]1337;FileEnd\x07y`));
  await tick();
  e.push(b(`\x1b]1337;File=inline=1:${Buffer.from('broken!').toString('base64')}\x07z`));
  await tick();
  e.push(b(`\x1b]1337;File=inline=0:${data}\x07w`)); // a download, not shown
  await tick();
  assert.equal(reqs.length, 3);
  assert.deepEqual([...reqs[1].data], [1, 2, 3]);
  const all = forwarded.map((f) => f.data).join('');
  assert.equal((all.match(/a=T/g) ?? []).length, 2);
  assert.match(all, /c=2,m=0/);
  assert.match(all.replace(/\x1b_G[^\x1b]*\x1b\\/g, '').replace(/\x1b\]\x18/g, ''), /^xyzw$/);
  e.dispose();
});
