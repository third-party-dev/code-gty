// Runs each installed shell with the shipped integration scripts and checks
// that prompts, commands, exit codes and the cwd are reported.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { SidecarClient } from '../../src/sidecar';
import { injectShellIntegration } from '../../src/shellIntegration';

const BIN =
  process.env.GTY_SIDECAR ??
  [join(__dirname, '../../../sidecar/target/debug/gty-sidecar'), join(__dirname, '../../../sidecar/target/release/gty-sidecar')].find(existsSync)!;
const SCRIPTS = join(__dirname, '../../shell-integration');
const dec = new TextDecoder();
const clients: SidecarClient[] = [];
after(() => clients.forEach((c) => c.dispose()));

function which(cmd: string): string | undefined {
  const r = spawnSync('/bin/sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

async function until(cond: () => boolean, ms: number, what: string, dump: () => string): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}; output:\n${JSON.stringify(dump())}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const cases: { shell: string; args: string[]; rc?: [string, string] }[] = [
  { shell: 'bash', args: [], rc: ['.bashrc', 'export GTY_RC=loaded\n'] },
  { shell: 'bash', args: ['-l'], rc: ['.bash_profile', 'export GTY_RC=loaded\n'] },
  { shell: 'zsh', args: [], rc: ['.zshrc', 'export GTY_RC=loaded\nPS1="%~ %# "\n'] },
  { shell: 'zsh', args: ['-l'], rc: ['.zshrc', 'export GTY_RC=loaded\n'] },
  { shell: 'fish', args: [], rc: ['.config/fish/config.fish', 'set -gx GTY_RC loaded\n'] },
  { shell: 'pwsh', args: ['-NoLogo'] },
];

for (const c of cases) {
  const path = which(c.shell);
  test(`${c.shell} ${c.args.join(' ')} reports prompts, commands and cwd`, { skip: !path && `${c.shell} not installed` }, async () => {
    const home = mkdtempSync(join(tmpdir(), 'gty-home-'));
    if (c.rc) {
      const file = join(home, c.rc[0]);
      spawnSync('mkdir', ['-p', join(file, '..')]);
      writeFileSync(file, c.rc[1]);
    }
    const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TERM: 'xterm-256color', LANG: 'C.UTF-8', USER: 'test' };
    const inj = injectShellIntegration(path!, c.args, SCRIPTS, env, 'linux');
    assert.ok(inj, 'shell should be injectable');
    const client = new SidecarClient(BIN);
    clients.push(client);
    await client.start();
    let out = '';
    let exited = false;
    const id = client.allocateId();
    client.spawnSession(id, { command: path!, args: inj.args, env: { ...env, ...inj.env }, cwd: home, cols: 120, rows: 30 }, {
      onOutput: (d) => {
        out += dec.decode(d, { stream: true });
        client.ack(id, d.length);
      },
      onReplay: () => undefined,
      onExit: () => (exited = true),
      onError: (m) => (out += `[error ${m}]`),
    });
    const dump = () => out;
    await until(() => out.includes('\x1b]133;B'), 15000, 'first prompt', dump);
    const rcCheck = c.shell === 'fish' ? 'echo rc=$GTY_RC' : c.shell === 'pwsh' ? 'echo "rc=$env:GTY_RC"' : 'echo rc=$GTY_RC';
    client.input(id, `${rcCheck}\r`);
    client.input(id, 'cd /tmp\r');
    client.input(id, c.shell === 'pwsh' ? 'cmd /c exit 3; bash -c "exit 3"\r' : 'sh -c "exit 3"\r');
    await until(() => /\x1b\]133;D;3\x07/.test(out), 15000, 'exit code 3', dump);
    await until(() => /\x1b\]7;file:\/\/[^/\x07]*\/tmp\x07/.test(out), 5000, 'cwd /tmp', dump);
    assert.match(out, /\x1b\]133;A\x07/);
    assert.match(out, /\x1b\]133;C\x07/);
    if (c.rc) assert.match(out, /rc=loaded/, 'user startup file must still be read');
    // Integration-only variables must not leak into the user's session.
    client.input(id, c.shell === 'pwsh' ? 'echo "leak=$env:GTY_SHELL_INTEGRATION$env:GTY_BASH_LOGIN"\r' : 'echo "leak=$GTY_SHELL_INTEGRATION$GTY_BASH_LOGIN"\r');
    await until(() => /leak=\r?\n/.test(out.replace(/\x1b\][^\x07]*\x07/g, '')), 5000, 'no leaked vars', dump);
    if (c.shell === 'zsh') {
      client.input(id, 'echo "zdot=$ZDOTDIR"\r');
      await until(() => /zdot=(\r|\n)/.test(out) || out.includes(`zdot=${home}`), 5000, 'ZDOTDIR restored', dump);
    }
    client.input(id, 'exit\r');
    await until(() => exited, 5000, 'exit', dump);
  });
}
