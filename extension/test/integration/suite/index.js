// Integration suite, run inside VS Code by @vscode/test-electron. Plain
// CommonJS with a tiny runner so it needs no compile step or test framework.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(cond, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const ws = process.env.GTY_TEST_WORKSPACE;
const readWhenWritten = (file) => until(() => {
  try {
    const t = fs.readFileSync(file, 'utf8');
    return t.endsWith('\n') ? t.trim() : false;
  } catch {
    return false;
  }
}, 15000, file);

let api;

test('extension activates and exports its API', async () => {
  const ext = vscode.extensions.getExtension('code-gty.code-gty');
  assert.ok(ext, 'extension not found');
  api = await ext.activate();
  assert.equal(api.version, 1);
});

test('a terminal opens as an editor tab and starts a shell', async () => {
  await vscode.workspace.getConfiguration('terminal.integrated').update('defaultProfile.linux', 'bash', vscode.ConfigurationTarget.Global);
  const t = api.createTerminal({ name: 'it-1' });
  assert.ok(t);
  const pid = await Promise.race([t.processId, sleep(20000).then(() => undefined)]);
  assert.equal(typeof pid, 'number', 'shell pid');
  const tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((x) => x.label === 'it-1');
  assert.ok(tab, 'editor tab exists');
  assert.ok(tab.input instanceof vscode.TabInputWebview);
});

test('environment matches the built-in terminal conventions', async () => {
  const t = api.terminals.find((x) => x.name === 'it-1');
  const out = path.join(ws, 'env.txt');
  t.sendText(`printf '%s|%s|%s|%s\\n' "$TERM_PROGRAM" "$COLORTERM" "$CODE_GTY" "\${ELECTRON_RUN_AS_NODE:-unset}" > ${out}`);
  assert.equal(await readWhenWritten(out), 'vscode|truecolor|1|unset');
});

test('shell integration reports the cwd', async () => {
  const t = api.terminals.find((x) => x.name === 'it-1');
  t.sendText('cd /tmp');
  await until(() => t.cwd === '/tmp', 10000, 'cwd /tmp');
});

test('contributed environment reaches new terminals', async () => {
  const d = api.contributeEnvironment('test', { GTY_CONTRIB: 'from-api' });
  const t = api.createTerminal({ name: 'it-2', env: { GTY_OPT: 'opt' } });
  await t.processId;
  const out = path.join(ws, 'contrib.txt');
  t.sendText(`echo "$GTY_CONTRIB $GTY_OPT" > ${out}`);
  assert.equal(await readWhenWritten(out), 'from-api opt');
  d.dispose();
  t.dispose();
});

test('settings env is applied with variable resolution', async () => {
  await vscode.workspace.getConfiguration('codeGty').update('env', { GTY_SETTING: '${userHome}/x' }, vscode.ConfigurationTarget.Global);
  const t = api.createTerminal({ name: 'it-3' });
  await t.processId;
  const out = path.join(ws, 'setting.txt');
  t.sendText(`echo "$GTY_SETTING" > ${out}`);
  assert.equal(await readWhenWritten(out), `${require('node:os').homedir()}/x`);
  t.dispose();
});

test('commands are registered', async () => {
  const all = await vscode.commands.getCommands(true);
  for (const c of ['codeGty.new', 'codeGty.newToSide', 'codeGty.kill', 'codeGty.clear', 'codeGty.find', 'codeGty.sendText']) {
    assert.ok(all.includes(c), c);
  }
});

test('exit with code 0 closes the tab', async () => {
  const t = api.createTerminal({ name: 'it-4' });
  await t.processId;
  let closed = false;
  const sub = api.onDidCloseTerminal((x) => {
    if (x === t) closed = true;
  });
  t.sendText('exit 0');
  await until(() => closed, 10000, 'close event');
  sub.dispose();
});

test('the tab can move to another editor group and keep working', async () => {
  const t = api.terminals.find((x) => x.name === 'it-1');
  t.show(false);
  await vscode.commands.executeCommand('workbench.action.moveEditorToNextGroup');
  await sleep(1000);
  const out = path.join(ws, 'moved.txt');
  t.sendText(`echo moved > ${out}`);
  assert.equal(await readWhenWritten(out), 'moved');
});

test('disposing a terminal closes it', async () => {
  const t = api.terminals.find((x) => x.name === 'it-1');
  const pid = await t.processId;
  t.dispose();
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, 10000, 'shell to exit');
});

module.exports.run = async function run() {
  let failed = 0;
  for (const { name, fn } of tests) {
    const start = Date.now();
    try {
      await fn();
      console.log(`ok - ${name} (${Date.now() - start} ms)`);
    } catch (e) {
      failed++;
      console.log(`not ok - ${name}\n  ${e && e.stack ? e.stack.replace(/\n/g, '\n  ') : e}`);
    }
  }
  console.log(`# ${tests.length - failed} passed, ${failed} failed`);
  if (failed) throw new Error(`${failed} integration test(s) failed`);
};
