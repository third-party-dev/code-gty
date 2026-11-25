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
