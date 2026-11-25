// The sidecar daemon: sessions outlive the window that started them, keep
// their screen current while detached, and can be claimed by another window.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { HostEngine } from '../../src/engine/hostEngine';
import { encodeFrame, FrameDecoder, Kind } from '../../src/protocol';
import { Claimed, SessionListener, SidecarClient } from '../../src/sidecar';
import { loadVtSync } from '../../vt/loader';
import { format } from '../../vt/selection';
import { restoreSnapshot } from '../../vt/snapshot';

const BIN =
  process.env.GTY_SIDECAR ??
  [join(__dirname, '../../../sidecar/target/debug/gty-sidecar'), join(__dirname, '../../../sidecar/target/release/gty-sidecar')].find(existsSync);
const WASM = process.env.GTY_VT_WASM ?? join(__dirname, '..', '..', 'media', 'ghostty-vt.wasm');
const mod = new WebAssembly.Module(readFileSync(WASM));
const ENV = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: tmpdir(), TERM: 'xterm-256color', LANG: 'C.UTF-8', PS1: '$ ' };
const dir = mkdtempSync(join(tmpdir(), 'gty-daemon-'));
const clients: SidecarClient[] = [];
after(async () => {
  // End the daemon: kill every session, then it exits when idle (or we leave it to the OS).
  const c = await window();
  for (const s of await c.list()) c.kill(s.id);
  for (const x of clients) x.dispose();
});

async function window(): Promise<SidecarClient> {
  const c = SidecarClient.forDaemon({ binary: BIN!, dir, vt: WASM });
  clients.push(c);
  await c.start();
  return c;
}

async function until(cond: () => boolean, ms = 10000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}

/** A window's view of a session: a host engine fed its output, as the extension does. */
function attach(c: SidecarClient, id: number, from?: Claimed) {
  const vt = loadVtSync(mod);
  let consumed = 0;
  const opts = { cols: 60, rows: 12, scrollbackLines: 1000, colors: {}, cursorStyle: 'block' as const, cursorBlink: false, xtversion: 'x', answerback: '', clipboard: 'write' as const };
  const e = new HostEngine(vt, from ? { ...opts, restore: from.data } : opts, {
    writePty: (d) => c.input(id, d),
    forward: (d, fromPty) => {
      if (fromPty) {
        consumed += d.length;
        c.ack(id, d.length);
      }
    },
  });
  const state = { exited: false, detached: '' };
  const listener: SessionListener = {
    onOutput: (d) => e.push(d),
    onReplay: () => undefined,
    onExit: () => (state.exited = true),
    onError: () => undefined,
    onDetached: (r) => (state.detached = r),
  };
  return { e, listener, state, checkpoint: () => c.checkpoint(id, consumed, { title: 'test', scrollback: 1000 }, e.snapshot()) };
}

test('a session survives its window, stays current while detached, and is claimed exactly', { skip: !BIN ? 'needs the sidecar' : false }, async () => {
  // Window 1 starts a shell.
  const w1 = await window();
  const id = w1.allocateId();
  const v1 = attach(w1, id);
  w1.spawnSession(id, { command: '/bin/sh', args: ['-i'], env: ENV, cwd: tmpdir(), cols: 60, rows: 12, window: 1 << 20, replayLimit: 1 << 20 }, v1.listener);
  w1.input(id, 'X=fortytwo; echo before-reload\n');
  await until(() => /before-reload\n/.test(format(v1.e.term)), 10000, 'first output');
  v1.checkpoint();
  // Output after the checkpoint, then the window goes away (a reload) while
  // the shell keeps writing.
  w1.input(id, 'echo after-checkpoint; sleep 0.7; echo while-detached\n');
  await until(() => /after-checkpoint\n/.test(format(v1.e.term)), 10000, 'output after checkpoint');
  w1.dispose();
  await new Promise((r) => setTimeout(r, 1500));

  // Window 2 finds the session detached and claims it.
  const w2 = await window();
  const listed = (await w2.list()).find((s) => s.id === id);
  assert.ok(listed, 'listed');
  assert.equal(listed.attached, false);
  assert.equal(listed.exited, false);
  assert.equal(listed.meta?.title, 'test');
  // The engine is built from the claim's snapshot, so output that arrives
  // first goes through this.
  const ref: { v?: ReturnType<typeof attach> } = {};
  const deferred: SessionListener = {
    onOutput: (d) => ref.v!.listener.onOutput(d),
    onReplay: () => undefined,
    onExit: () => ref.v!.listener.onExit({ code: 0, signal: null }),
    onError: () => undefined,
    onDetached: (r) => ref.v!.listener.onDetached!(r),
  };
  const claimed = await w2.claim(id, deferred);
  assert.ok(claimed);
  assert.equal(claimed.exact, true);
  const v2 = (ref.v = attach(w2, id, claimed));
  const screen = format(v2.e.term);
  assert.match(screen, /before-reload[\s\S]*after-checkpoint[\s\S]*while-detached/, screen);
  // The same shell: its variable is still set.
  w2.input(id, 'echo X is $X\n');
  await until(() => /X is fortytwo/.test(format(v2.e.term)), 10000, 'same shell');

  // Window 3 takes it over; window 2 is told.
  const w3 = await window();
  const taken = await w3.claim(id, { onOutput: () => undefined, onReplay: () => undefined, onExit: () => undefined, onError: () => undefined });
  assert.ok(taken?.exact);
  assert.match(format(restoreSnapshot(loadVtSync(mod), taken!.data, {})), /X is fortytwo/);
  await until(() => v2.state.detached === 'claimed', 5000, 'detached notice');
  assert.equal((await w3.list()).find((s) => s.id === id)?.mine, true);

  // Killing it removes it.
  w3.kill(id);
  await until(() => true, 10);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await w3.list()).some((s) => s.id === id), false);
});

test('claiming a session that does not exist fails cleanly', { skip: !BIN ? 'needs the sidecar' : false }, async () => {
  const w = await window();
  assert.equal(await w.claim(123456789, { onOutput: () => undefined, onReplay: () => undefined, onExit: () => undefined, onError: () => undefined }), undefined);
});

test('a connection without the token is refused', { skip: !BIN ? 'needs the sidecar' : false }, async () => {
  await window(); // make sure the daemon runs
  const state = JSON.parse(readFileSync(join(dir, 'daemon-v2.json'), 'utf8')) as { socket: string };
  const got = await new Promise<number>((resolve) => {
    const sock = net.createConnection(state.socket);
    const dec = new FrameDecoder();
    let frames = 0;
    sock.on('connect', () => sock.write(encodeFrame(Kind.AUTH, 0, new TextEncoder().encode('wrong'))));
    sock.on('data', (d) => (frames += dec.push(new Uint8Array(d)).length));
    sock.on('close', () => resolve(frames));
    setTimeout(() => sock.destroy(), 3000);
  });
  assert.equal(got, 0, 'no hello for a wrong token');
});
