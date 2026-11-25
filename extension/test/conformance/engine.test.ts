// Engine conformance: the repository's test.py runs in a real PTY under the
// real sidecar, and the host engine (libghostty-vt) answers its queries, the
// way a terminal tab does. Every query must get a reply, Kitty graphics
// included (the shipped module is the wasm32-wasi build).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { HostEngine } from '../../src/engine/hostEngine';
import type { ExitMsg } from '../../src/protocol';
import { SessionListener, SidecarClient } from '../../src/sidecar';
import { loadVtSync } from '../../vt/loader';
import { format } from '../../vt/selection';

const BIN =
  process.env.GTY_SIDECAR ??
  [join(__dirname, '../../../sidecar/target/debug/gty-sidecar'), join(__dirname, '../../../sidecar/target/release/gty-sidecar')].find(existsSync);
const TEST_PY = [join(__dirname, '../../../test.py'), join(__dirname, '../../test.py')].find(existsSync);
const PYTHON = ['/usr/bin/python3', '/usr/local/bin/python3'].find(existsSync);
const mod = new WebAssembly.Module(readFileSync(process.env.GTY_VT_WASM ?? join(__dirname, '..', '..', 'media', 'ghostty-vt.wasm')));
const ENV = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: tmpdir(), TERM: 'xterm-256color', LANG: 'C.UTF-8' };

const clients: SidecarClient[] = [];
after(() => clients.forEach((c) => c.dispose()));

test('test.py: every query is answered by the host engine', { skip: !BIN || !TEST_PY || !PYTHON ? 'needs the sidecar, test.py and python3' : false }, async () => {
  const c = new SidecarClient(BIN!);
  clients.push(c);
  await c.start();
  const id = c.allocateId();
  const copies: string[] = [];
  const engine = new HostEngine(
    loadVtSync(mod),
    {
      cols: 100,
      rows: 40,
      scrollbackLines: 1000,
      colors: { foreground: 0xcccccc, background: 0x1e1e1e, cursor: 0xffffff },
      cursorStyle: 'block',
      cursorBlink: false,
      xtversion: 'code-gty test (libghostty-vt)',
      answerback: '',
      clipboard: 'write',
    },
    {
      writePty: (d) => c.input(id, d),
      forward: (d, fromPty) => {
        if (fromPty) c.ack(id, d.length);
      },
      clipboardWrite: (t) => copies.push(t),
    },
  );
  let exit: ExitMsg | undefined;
  const listener: SessionListener = {
    onOutput: (d) => engine.push(d),
    onReplay: () => undefined,
    onExit: (e) => (exit = e),
    onError: () => undefined,
  };
  c.spawnSession(id, { command: PYTHON!, args: [TEST_PY!], env: ENV, cwd: tmpdir(), cols: 100, rows: 40, window: 1 << 20, replayLimit: 0 }, listener);
  const deadline = Date.now() + 20000;
  while (!exit && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.ok(exit, 'test.py did not finish');
  const text = format(engine.term, { unwrap: true });
  const lines = text.split('\n').filter((l) => / (YES |no reply)/.test(l));
  assert.equal(lines.length, 8, text);
  for (const l of lines) assert.match(l, /YES/, `no reply: ${l}`);
  assert.match(text, /XTVERSION\s+YES.*code-gty test/);
  assert.match(text, /kitty graphics\s+YES.*OK/);
  assert.deepEqual(copies, ['osc52 works']);
  assert.equal(engine.title, 'OSC 0 title test');
  engine.dispose();
});

test('sidecar binary exists for the conformance stage', { skip: process.env.GTY_SIDECAR ? false : 'local run' }, () => {
  assert.equal(spawnSync(BIN!, ['--version']).status, 0);
});

test('sixel and iTerm2 images are decoded by the sidecar and placed', { skip: !BIN ? 'needs the sidecar' : false }, async () => {
  const { writeFileSync } = await import('node:fs');
  const { deflateSync } = await import('node:zlib');
  const { KittyImages } = await import('../../vt/kitty');
  const { RenderState } = await import('../../vt/render');
  // A 2x2 PNG built by hand, sent as an iTerm2 inline image, then a sixel.
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const x of buf) {
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
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]))), chunk('IEND', Buffer.alloc(0))]);
  const file = join(tmpdir(), `gty-images-${process.pid}.bin`);
  writeFileSync(file, `\x1b]1337;File=inline=1;width=2:${png.toString('base64')}\x07\r\n\x1bP0;1;0q"1;1;20;12#1;2;0;0;100#1!20~-!20~\x1b\\done\r\n`);
  const c = new SidecarClient(BIN!);
  clients.push(c);
  await c.start();
  const id = c.allocateId();
  const e = new HostEngine(
    loadVtSync(mod),
    { cols: 60, rows: 20, scrollbackLines: 100, colors: {}, cursorStyle: 'block', cursorBlink: false, xtversion: 'x', answerback: '', clipboard: 'write' },
    {
      writePty: (d) => c.input(id, d),
      forward: (d, fromPty) => fromPty && c.ack(id, d.length),
      decodeImage: (r) => c.decode(id, r),
      dropped: (n) => c.ack(id, n),
    },
  );
  e.resize(60, 20, { cellWidth: 8, cellHeight: 16 });
  let exit: ExitMsg | undefined;
  c.spawnSession(id, { command: '/bin/cat', args: [file], env: ENV, cwd: tmpdir(), cols: 60, rows: 20, window: 4096, replayLimit: 0 }, {
    onOutput: (d) => e.push(d),
    onReplay: () => undefined,
    onExit: (x) => (exit = x),
    onError: () => undefined,
  });
  const deadline = Date.now() + 15000;
  while (!(exit && /done/.test(format(e.term))) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.match(format(e.term), /done/);
  const rs = new RenderState(e.vt);
  rs.update(e.term);
  const ps = new KittyImages(e.vt).placements(rs).map((p) => [p.row, p.width, p.height]);
  assert.deepEqual(ps.sort(), [
    [0, 16, 16],
    [1, 20, 12],
  ]);
  e.dispose();
});
