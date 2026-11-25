// Drives a real gty-sidecar binary through the same client the extension
// uses. Set GTY_SIDECAR to the binary; defaults to the local debug build.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { ExitMsg, ProcessInfoMsg, SpawnRequest } from '../../src/protocol';
import { SessionListener, SidecarClient } from '../../src/sidecar';

const BIN =
  process.env.GTY_SIDECAR ??
  [join(__dirname, '../../../sidecar/target/debug/gty-sidecar'), join(__dirname, '../../../sidecar/target/release/gty-sidecar')].find(existsSync);
if (!BIN) throw new Error('set GTY_SIDECAR to the sidecar binary');

const ENV = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: tmpdir(), TERM: 'xterm-256color', LANG: 'C.UTF-8' };
const dec = new TextDecoder();

const clients: SidecarClient[] = [];
after(() => clients.forEach((c) => c.dispose()));

async function client(): Promise<SidecarClient> {
  const c = new SidecarClient(BIN!);
  clients.push(c);
  await c.start();
  return c;
}

class Recorder implements SessionListener {
  out = '';
  bytes = 0;
  replays: { data: string; truncated: boolean }[] = [];
  exit: ExitMsg | undefined;
  errors: string[] = [];
  pid: number | null | undefined;
  infos: ProcessInfoMsg[] = [];
  constructor(
    private readonly c?: SidecarClient,
    private readonly id?: number,
    private readonly autoAck = true,
  ) {}
  onSpawned(pid: number | null) {
    this.pid = pid;
  }
  onOutput(d: Uint8Array) {
    this.bytes += d.length;
    this.out += dec.decode(d, { stream: true });
    if (this.autoAck && this.c && this.id) this.c.ack(this.id, d.length);
  }
  onReplay(d: Uint8Array, truncated: boolean) {
    this.replays.push({ data: dec.decode(d), truncated });
    if (this.c && this.id) this.c.ack(this.id, d.length);
  }
  onExit(e: ExitMsg) {
    this.exit = e;
  }
  onError(m: string) {
    this.errors.push(m);
  }
  onProcessInfo(i: ProcessInfoMsg) {
    this.infos.push(i);
  }
}

async function until(cond: () => boolean, ms = 5000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function run(c: SidecarClient, command: string, args: string[], extra: Partial<SpawnRequest> = {}, autoAck = true) {
  const id = c.allocateId();
  const rec = new Recorder(c, id, autoAck);
  c.spawnSession(id, { command, args, env: ENV, cwd: tmpdir(), cols: 80, rows: 24, ...extra }, rec);
  return { id, rec };
}

test('hello carries protocol and build', async () => {
  const c = new SidecarClient(BIN);
  clients.push(c);
  const hello = await c.start();
  assert.equal(hello.protocol, 1);
  assert.ok(hello.build.length > 0);
  assert.equal(typeof hello.pid, 'number');
});

test('output and exit code', async () => {
  const c = await client();
  const { rec } = run(c, '/bin/sh', ['-c', 'printf hello; exit 3']);
  await until(() => !!rec.exit, 5000, 'exit');
  assert.equal(rec.out, 'hello');
  assert.deepEqual(rec.exit, { code: 3, signal: null });
  assert.ok(typeof rec.pid === 'number');
});

test('exit by signal is reported', async () => {
  const c = await client();
  const { rec } = run(c, '/bin/sh', ['-c', 'kill -KILL $$']);
  await until(() => !!rec.exit);
  assert.equal(rec.exit!.code, null);
  assert.ok(rec.exit!.signal, 'signal name expected');
});

test('environment and cwd are exactly what the host sent', async () => {
  const c = await client();
  const { rec } = run(c, '/bin/sh', ['-c', 'echo "[$GTY_X][$HOME]"; pwd; env | wc -l'], { env: { ...ENV, GTY_X: 'yes' }, cwd: '/' });
  await until(() => !!rec.exit);
  assert.match(rec.out, /\[yes\]\[/);
  assert.match(rec.out, /\r\n\/\r\n/);
  // Only our handful of variables (plus what sh itself adds).
  const n = Number(rec.out.trim().split(/\s+/).pop());
  assert.ok(n < 12, `unexpected inherited env (${n} vars)`);
});

test('input reaches the PTY', async () => {
  const c = await client();
  const { id, rec } = run(c, '/bin/sh', ['-c', 'read line; echo "got:$line"']);
  c.input(id, 'abc\r');
  await until(() => !!rec.exit);
  assert.match(rec.out, /got:abc/);
});

test('resize changes the PTY size', async () => {
  const c = await client();
  const { id, rec } = run(c, '/bin/sh', ['-c', 'stty size; read x; stty size'], { cols: 100, rows: 30 });
  await until(() => rec.out.includes('30 100'), 5000, 'initial size');
  c.resize(id, 50, 20);
  await new Promise((r) => setTimeout(r, 50));
  c.input(id, '\r');
  await until(() => !!rec.exit);
  assert.match(rec.out, /20 50/);
});

test('the PTY reports the text area in pixels (TIOCGWINSZ), as image viewers need', { skip: existsSync('/usr/bin/python3') ? false : 'needs python3' }, async () => {
  const c = await client();
  const winsz = "import fcntl,termios,struct; print('px', *struct.unpack('HHHH', fcntl.ioctl(0, termios.TIOCGWINSZ, bytes(8))))";
  const { id, rec } = run(c, '/bin/sh', ['-c', `python3 -c "${winsz}"; read x; python3 -c "${winsz}"`], { cols: 100, rows: 30, width: 900, height: 540 });
  await until(() => rec.out.includes('px 30 100 900 540'), 5000, 'initial pixel size');
  c.resize(id, 50, 20, 450, 360);
  await new Promise((r) => setTimeout(r, 50));
  c.input(id, '\r');
  await until(() => !!rec.exit);
  assert.match(rec.out, /px 20 50 450 360/);
});

test('flow control pauses output until acked', async () => {
  const c = await client();
  const window = 8192;
  const total = 2_000_000;
  const { id, rec } = run(c, '/bin/sh', ['-c', `head -c ${total} /dev/zero | tr '\\0' x`], { window }, false);
  await until(() => rec.bytes > 0, 5000, 'first output');
  await new Promise((r) => setTimeout(r, 300));
  const stalled = rec.bytes;
  // At most one read chunk beyond the window may be in flight.
  assert.ok(stalled <= window + 64 * 1024, `received ${stalled} bytes without acking`);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(rec.bytes, stalled, 'output continued without acks');
  // Ack as we go and the rest arrives.
  const timer = setInterval(() => c.ack(id, 1 << 20), 5);
  try {
    await until(() => !!rec.exit, 20000, 'exit after acks');
  } finally {
    clearInterval(timer);
  }
  assert.ok(rec.out.replace(/\r?\n/g, '').length >= total);
});

test('large output is coalesced into few frames', async () => {
  const c = await client();
  let frames = 0;
  const id = c.allocateId();
  const rec = new Recorder(c, id);
  const orig = rec.onOutput.bind(rec);
  rec.onOutput = (d) => {
    frames++;
    orig(d);
  };
  c.spawnSession(id, { command: '/bin/sh', args: ['-c', 'i=0; while [ $i -lt 2000 ]; do echo line$i; i=$((i+1)); done'], env: ENV, cols: 80, rows: 24 }, rec);
  await until(() => !!rec.exit, 10000);
  assert.match(rec.out, /line1999/);
  assert.ok(frames < 500, `expected coalescing, got ${frames} frames for 2000 writes`);
});

test('attach replays recent output', async () => {
  const c = await client();
  const { id, rec } = run(c, '/bin/sh', ['-c', 'printf abcdef; sleep 5']);
  await until(() => rec.out === 'abcdef');
  c.attach(id);
  await until(() => rec.replays.length === 1);
  assert.deepEqual(rec.replays[0], { data: 'abcdef', truncated: false });
  c.kill(id);
});

test('replay buffer is bounded and reports truncation', async () => {
  const c = await client();
  const { id, rec } = run(c, '/bin/sh', ['-c', 'printf abcdef; sleep 5'], { replayLimit: 2 });
  await until(() => rec.out === 'abcdef');
  c.attach(id);
  await until(() => rec.replays.length === 1);
  assert.deepEqual(rec.replays[0], { data: 'ef', truncated: true });
  c.kill(id);
});

test('sessions are multiplexed independently', async () => {
  const c = await client();
  const a = run(c, '/bin/sh', ['-c', 'for i in 1 2 3; do echo A$i; sleep 0.05; done']);
  const b = run(c, '/bin/sh', ['-c', 'for i in 1 2 3; do echo B$i; sleep 0.05; done; exit 7']);
  await until(() => !!a.rec.exit && !!b.rec.exit);
  assert.doesNotMatch(a.rec.out, /B/);
  assert.doesNotMatch(b.rec.out, /A/);
  assert.equal(a.rec.exit!.code, 0);
  assert.equal(b.rec.exit!.code, 7);
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('kill hangs up the whole process group', async () => {
  const c = await client();
  const { id, rec } = run(c, '/bin/sh', ['-c', 'sleep 1000 & echo child:$!; wait']);
  await until(() => /child:\d+/.test(rec.out));
  const child = Number(/child:(\d+)/.exec(rec.out)![1]);
  assert.ok(alive(child));
  c.kill(id);
  await until(() => !alive(child), 5000, 'background child to die');
});

test('processes ignoring SIGHUP are killed after the grace period', async () => {
  const c = await client();
  const { id, rec } = run(c, '/bin/sh', ['-c', "trap '' HUP; echo pid:$$; while :; do sleep 0.1; done"]);
  await until(() => /pid:\d+/.test(rec.out));
  const pid = Number(/pid:(\d+)/.exec(rec.out)![1]);
  c.kill(id);
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(alive(pid), 'should survive SIGHUP for the grace period');
  await until(() => !alive(pid), 6000, 'SIGKILL escalation');
});

test('closing stdin shuts down the sidecar and its shells', async () => {
  const c = new SidecarClient(BIN);
  await c.start();
  const { rec } = run(c, '/bin/sh', ['-c', 'sleep 1000 & echo child:$!; wait']);
  await until(() => /child:\d+/.test(rec.out));
  const child = Number(/child:(\d+)/.exec(rec.out)![1]);
  const sidecarPid = c.pid!;
  c.dispose();
  await until(() => !alive(sidecarPid), 5000, 'sidecar exit');
  await until(() => !alive(child), 5000, 'child exit');
});

test('invalid requests produce errors, not crashes', async () => {
  const c = await client();
  const id = c.allocateId();
  const rec = new Recorder(c, id);
  c.spawnSession(id, { command: '/definitely/not/here', args: [], env: ENV, cols: 80, rows: 24 }, rec);
  await until(() => rec.errors.length > 0 || !!rec.exit);
  // The sidecar is still serving.
  const { rec: ok } = run(c, '/bin/sh', ['-c', 'echo fine']);
  await until(() => !!ok.exit);
  assert.match(ok.out, /fine/);
});

const hasBash = spawnSync('bash', ['--version']).status === 0;
test('foreground process is reported', { skip: !hasBash || process.platform === 'win32' }, async () => {
  const c = await client();
  const { id, rec } = run(c, 'bash', ['--norc', '--noprofile', '-i']);
  await new Promise((r) => setTimeout(r, 300));
  c.input(id, 'sleep 3\r');
  await new Promise((r) => setTimeout(r, 300));
  c.queryProcess(id);
  await until(() => rec.infos.some((i) => i.busy === true && i.name === 'sleep'), 3000, 'busy sleep');
  c.input(id, '\x03');
  await until(() => rec.infos.length > 0 && rec.infos[rec.infos.length - 1].busy === false, 3000, 'idle again');
  c.kill(id);
});
