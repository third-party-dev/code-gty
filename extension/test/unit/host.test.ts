import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyPatch, buildEnvironment, localeFor, resolveVariables, sanitizeHostEnv } from '../../src/env';
import { parseFileLink } from '../../src/linkParse';
import { interpretOsc, OscScanner, parseFileUri } from '../../src/osc';
import { resolveShell, findExecutable } from '../../src/profiles';
import { encodeAck, encodeFrame, encodeJson, FrameDecoder, Kind } from '../../src/protocol';
import { injectShellIntegration, shellKind } from '../../src/shellIntegration';

const enc = new TextEncoder();

test('frame codec round-trips across arbitrary chunk splits', () => {
  const frames = [
    encodeFrame(Kind.OUTPUT, 1, enc.encode('hello')),
    encodeJson(Kind.RESIZE, 2, { cols: 80, rows: 24 }),
    encodeAck(3, 123456),
    encodeFrame(Kind.KILL, 4),
  ];
  const all = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
  let off = 0;
  for (const f of frames) {
    all.set(f, off);
    off += f.length;
  }
  for (const step of [1, 2, 3, 7, 1000]) {
    const d = new FrameDecoder();
    const got = [];
    for (let i = 0; i < all.length; i += step) got.push(...d.push(all.slice(i, i + step)));
    assert.equal(got.length, 4, `step ${step}`);
    assert.deepEqual([...got.map((g) => g.kind)], [Kind.OUTPUT, Kind.RESIZE, Kind.ACK, Kind.KILL]);
    assert.equal(new TextDecoder().decode(got[0].payload), 'hello');
    assert.equal(new DataView(got[2].payload.buffer, got[2].payload.byteOffset).getUint32(0, true), 123456);
    assert.equal(got[3].session, 4);
    assert.equal(got[3].payload.length, 0);
  }
});

test('frame decoder rejects corrupt lengths', () => {
  assert.throws(() => new FrameDecoder().push(new Uint8Array([1, 0, 0, 0, 0])));
});

test('OSC scanner handles BEL, ST and splits', () => {
  const s = new OscScanner();
  assert.deepEqual(s.push(enc.encode('a\x1b]0;tit')), []);
  assert.deepEqual(s.push(enc.encode('le\x07b\x1b]7;file://h/tmp/x y\x1b\\')), ['0;title', '7;file://h/tmp/x y']);
  assert.deepEqual(s.push(enc.encode('\x1b[31m\x1b]133;A\x07')), ['133;A']);
  // ESC inside an OSC aborts it; the next sequence still parses.
  assert.deepEqual(s.push(enc.encode('\x1b]2;bad\x1b]2;good\x07')), ['2;good']);
});

test('OSC interpretation', () => {
  assert.deepEqual(interpretOsc('2;vim'), { type: 'title', title: 'vim' });
  assert.deepEqual(interpretOsc('7;file://host/home/a%20b'), { type: 'cwd', cwd: '/home/a b' });
  assert.deepEqual(interpretOsc('52;c;aGVsbG8='), { type: 'clipboard', op: 'write', text: 'hello' });
  assert.deepEqual(interpretOsc('52;c;?'), { type: 'clipboard', op: 'read' });
  assert.deepEqual(interpretOsc('133;D;2'), { type: 'commandFinished', exitCode: 2 });
  assert.deepEqual(interpretOsc('133;D'), { type: 'commandFinished', exitCode: undefined });
  assert.deepEqual(interpretOsc('133;C'), { type: 'commandStart' });
  assert.equal(interpretOsc('1337;foo'), undefined);
  assert.equal(parseFileUri('file:///C:/Users/x'), 'C:/Users/x');
});

test('variable resolution', () => {
  const ctx = { workspaceFolder: '/w/proj', userHome: '/home/u', pathSeparator: '/', env: { PATH: '/bin' } };
  assert.equal(resolveVariables('${env:PATH}:${workspaceFolder}/bin', ctx), '/bin:/w/proj/bin');
  assert.equal(resolveVariables('${workspaceFolderBasename}-${userHome}', ctx), 'proj-/home/u');
  assert.equal(resolveVariables('${unknown}', ctx), '${unknown}');
  assert.equal(resolveVariables('${env:path}', ctx), '');
  assert.equal(resolveVariables('${env:path}', { ...ctx, win: true }), '/bin');
});

test('host env is sanitised', () => {
  const env = sanitizeHostEnv({ ELECTRON_RUN_AS_NODE: '1', VSCODE_PID: '1', VSCODE_IPC_HOOK_CLI: '/s', VSCODE_GIT_ASKPASS_MAIN: 'x', HOME: '/h' });
  assert.deepEqual(env, { VSCODE_IPC_HOOK_CLI: '/s', VSCODE_GIT_ASKPASS_MAIN: 'x', HOME: '/h' });
});

test('buildEnvironment sets terminal variables and applies patches in order', () => {
  const env = buildEnvironment({
    hostEnv: { PATH: '/bin', HOME: '/h', FOO: 'x', ELECTRON_RUN_AS_NODE: '1' },
    platform: 'linux',
    inheritEnv: true,
    term: 'xterm-256color',
    vscodeVersion: '1.99.0',
    detectLocale: 'auto',
    uiLanguage: 'de',
    patches: [{ PATH: '${env:PATH}:/extra', FOO: null }, { BAR: '${userHome}/bar' }],
    vars: { userHome: '/h', pathSeparator: '/' },
  });
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.COLORTERM, 'truecolor');
  assert.equal(env.TERM_PROGRAM, 'vscode');
  assert.equal(env.TERM_PROGRAM_VERSION, '1.99.0');
  assert.equal(env.LANG, 'de_DE.UTF-8');
  assert.equal(env.PATH, '/bin:/extra');
  assert.equal(env.FOO, undefined);
  assert.equal(env.BAR, '/h/bar');
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
});

test('inheritEnv=false keeps only the minimal set', () => {
  const env = buildEnvironment({
    hostEnv: { PATH: '/bin', HOME: '/h', RANDOM_THING: 'x', LANG: 'C.UTF-8' },
    platform: 'darwin',
    inheritEnv: false,
    term: 't',
    vscodeVersion: '1',
    detectLocale: 'off',
    uiLanguage: 'en',
    patches: [],
    vars: { userHome: '/h', pathSeparator: '/' },
  });
  assert.equal(env.RANDOM_THING, undefined);
  assert.equal(env.HOME, '/h');
  assert.equal(env.LANG, undefined);
});

test('windows env names are case-insensitive', () => {
  const env: Record<string, string> = { Path: 'C:\\bin' };
  applyPatch(env, { PATH: '${env:PATH};C:\\x' }, { userHome: 'C:\\u', pathSeparator: '\\' }, true);
  assert.deepEqual(env, { Path: 'C:\\bin;C:\\x' });
});

test('locale mapping', () => {
  assert.equal(localeFor('en'), 'en_US.UTF-8');
  assert.equal(localeFor('zh-cn'), 'zh_CN.UTF-8');
});

test('shell resolution', () => {
  const files = new Set(['/usr/bin/zsh', '/bin/bash', '/usr/bin/fish']);
  const base = { platform: 'linux' as const, env: { PATH: '/usr/bin:/bin', SHELL: '/bin/bash' }, exists: (p: string) => files.has(p), defaultProfile: undefined, profiles: undefined };
  assert.deepEqual(resolveShell(base), { name: 'bash', command: '/bin/bash', args: [], env: {} });
  assert.equal(resolveShell({ ...base, defaultProfile: 'zsh' }).command, '/usr/bin/zsh');
  const custom = resolveShell({ ...base, defaultProfile: 'mine', profiles: { mine: { path: 'fish', args: ['--private'], env: { A: '1' } } } });
  assert.deepEqual(custom, { name: 'mine', command: '/usr/bin/fish', args: ['--private'], env: { A: '1' } });
  // An unknown profile falls back to $SHELL.
  assert.equal(resolveShell({ ...base, defaultProfile: 'nope' }).command, '/bin/bash');
  // macOS starts login shells.
  assert.deepEqual(resolveShell({ ...base, platform: 'darwin', env: { ...base.env, SHELL: '/bin/zsh' } }).args, ['-l']);
  assert.equal(findExecutable('nothere', base), undefined);
});

test('windows shell resolution prefers PowerShell', () => {
  const files = new Set(['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'C:\\Windows\\System32\\cmd.exe']);
  const r = resolveShell({ platform: 'win32', env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' }, exists: (p) => files.has(p), defaultProfile: undefined, profiles: undefined });
  assert.equal(r.command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
});

test('shell integration injection', () => {
  assert.equal(shellKind('/usr/bin/zsh'), 'zsh');
  assert.equal(shellKind('C:\\x\\pwsh.exe'), 'pwsh');
  const bash = injectShellIntegration('/bin/bash', ['-l'], '/ext/si', {}, 'linux')!;
  assert.deepEqual(bash.args, ['--init-file', '/ext/si/bash/gty.bash']);
  assert.equal(bash.env.GTY_BASH_LOGIN, '1');
  assert.equal(injectShellIntegration('/bin/bash', ['-c', 'echo'], '/ext/si', {}, 'linux'), undefined);
  const zsh = injectShellIntegration('/bin/zsh', ['-l'], '/ext/si', { HOME: '/h' }, 'darwin')!;
  assert.equal(zsh.env.ZDOTDIR, '/ext/si/zsh');
  assert.equal(zsh.env.GTY_USER_ZDOTDIR, '/h');
  const fish = injectShellIntegration('/usr/bin/fish', [], '/ext/si', {}, 'linux')!;
  assert.deepEqual(fish.args, ['--init-command', "source '/ext/si/fish/gty.fish'"]);
  const pwsh = injectShellIntegration('/usr/bin/pwsh', ['-l'], '/ext/si', {}, 'linux')!;
  assert.deepEqual(pwsh.args, ['-Login', '-NoExit', '-Command', ". '/ext/si/pwsh/gty.ps1'"]);
  assert.equal(injectShellIntegration('/bin/sh', [], '/ext/si', {}, 'linux'), undefined);
});

test('file link parsing', () => {
  assert.deepEqual(parseFileLink('src/a.ts:12:3'), { path: 'src/a.ts', line: 12, col: 3 });
  assert.deepEqual(parseFileLink('a.py(7,2)'), { path: 'a.py', line: 7, col: 2 });
  assert.deepEqual(parseFileLink('"./x.rs:9"'), { path: './x.rs', line: 9, col: undefined });
  assert.deepEqual(parseFileLink('/etc/hosts'), { path: '/etc/hosts' });
  assert.deepEqual(parseFileLink('file://myhost/home/u/notes.md'), { path: '/home/u/notes.md' });
  assert.deepEqual(parseFileLink('file:///tmp/a%20b.txt'), { path: '/tmp/a b.txt' });
});
