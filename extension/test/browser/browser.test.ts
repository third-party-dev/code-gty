// Browser mode end to end (PLAN-browser-support.md): the real gty-browser
// binary (app/browser/) serves the real page to a real browser, with a real
// daemon and PTY. A test shell records what reached it. Run in the
// Playwright image (the Dockerfile's test-browser-mode stage), with
// GTY_BROWSER_BIN set to the program (there, the Linux launcher, with
// GTY_VIEWER=browser) and GTY_BROWSER to chromium or firefox.

import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Browser, BrowserType, chromium, firefox, Page, webkit } from 'playwright-core';

const ENGINES: Record<string, BrowserType> = { chromium, firefox, webkit };
const ENGINE = process.env.GTY_BROWSER ?? 'chromium';
const BIN = process.env.GTY_BROWSER_BIN ?? 'gty-browser';

// Short: the daemon's socket path must fit in a sockaddr_un.
const dir = mkdtempSync('/tmp/gtyb-');
const out = join(dir, 'out');
let browser: Browser;

const SHELL = `#!/bin/sh
echo $$ > "${out}/pid"
stty size > "${out}/size"
printf 'type here> '
read -r line
echo "$line" > "${out}/typed"
[ -n "$GTY_TEST_EXIT_EARLY" ] && exit 0
printf 'after reload> '
read -r line
echo "$line" > "${out}/again"
sleep 600
`;

before(async () => {
  mkdirSync(join(dir, 'run'), { mode: 0o700 });
  mkdirSync(join(dir, 'config'));
  writeFileSync(join(dir, 'shell'), SHELL);
  chmodSync(join(dir, 'shell'), 0o755);
  browser = await ENGINES[ENGINE].launch();
});

after(async () => {
  await browser?.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Server_ {
  proc: ChildProcess;
  url: string;
  exited: Promise<number | null>;
  stderr: () => string;
}

/** Starts gty-browser with GTY_BROWSER_NO_LAUNCH (it prints the address). */
async function startServer(extraEnv: Record<string, string> = {}): Promise<Server_> {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out);
  const run = join(dir, 'run');
  const proc = spawn(BIN, [], {
    env: {
      ...process.env,
      GTY_BROWSER_NO_LAUNCH: '1',
      SHELL: join(dir, 'shell'),
      XDG_RUNTIME_DIR: run,
      XDG_CONFIG_HOME: join(dir, 'config'),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  proc.stderr!.on('data', (d: Buffer) => (err += d.toString()));
  const exited = new Promise<number | null>((resolve) => proc.on('exit', (code) => resolve(code)));
  const url = await new Promise<string>((resolve, reject) => {
    let text = '';
    proc.stdout!.on('data', (d: Buffer) => {
      text += d.toString();
      const line = text.split('\n')[0];
      if (text.includes('\n')) resolve(line.trim());
    });
    void exited.then((code) => reject(new Error(`gty-browser exited (${code}) before printing its address:\n${err}`)));
  });
  return { proc, url, exited, stderr: () => err };
}

async function waitFor(file: string, ms = 30000): Promise<string> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (existsSync(file)) {
      const t = readFileSync(file, 'utf8');
      if (t.length) return t.trim();
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => (t = setTimeout(() => reject(new Error(`timed out: ${what}`)), ms)));
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t);
  }
}

async function typeLine(page: Page, text: string): Promise<void> {
  await page.locator('body').click();
  await page.keyboard.type(text, { delay: 20 });
  await page.keyboard.press('Enter');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test(`${ENGINE}: the terminal works in a browser, survives a reload, and ends with the page`, async () => {
  const server = await startServer();
  try {
    const page = await browser.newPage();
    await page.goto(server.url);
    const size = await waitFor(join(out, 'size'));
    const [rows, cols] = size.split(' ').map(Number);
    assert.ok(rows > 10 && cols > 40, `PTY size ${size}`);
    const pid = Number(await waitFor(join(out, 'pid')));

    await typeLine(page, 'typed in the browser');
    assert.equal(await waitFor(join(out, 'typed')), 'typed in the browser');

    // A reload reattaches to the same shell (the tab's sessionStorage).
    await page.reload();
    await page.waitForTimeout(1500);
    await typeLine(page, 'typed after the reload');
    assert.equal(await waitFor(join(out, 'again')), 'typed after the reload');
    assert.equal(Number(readFileSync(join(out, 'pid'), 'utf8')), pid, 'the shell was not restarted');

    // Closing the page: after the grace period the server ends the session and exits.
    await page.close();
    const code = await within(server.exited, 20000, 'gty-browser exits after its page closed');
    assert.equal(code, 0, server.stderr());
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(!alive(pid), 'the shell was ended with the page');
  } finally {
    server.proc.kill();
  }
});

test(`${ENGINE}: when the shell exits, the page and the server close at once`, async () => {
  const server = await startServer({ GTY_TEST_EXIT_EARLY: '1' });
  try {
    const page = await browser.newPage();
    await page.goto(server.url);
    await waitFor(join(out, 'size'));
    await typeLine(page, 'bye');
    const start = Date.now();
    const code = await within(server.exited, 10000, 'gty-browser exits after the session ended');
    assert.equal(code, 0, server.stderr());
    // No grace period: the page said its session had ended (this tab, opened
    // by the test, may not close itself; gty's app window does).
    assert.ok(Date.now() - start < 4000, `exited after ${Date.now() - start} ms`);
  } finally {
    server.proc.kill();
  }
});

test(`${ENGINE}: a page on another origin cannot reach the terminal`, async () => {
  const server = await startServer({ GTY_BROWSER_FIRST_PAGE_SECS: '30' });
  let other: Server | undefined;
  try {
    const target = new URL(server.url);
    // A page served from another port on the same machine: another origin.
    other = createServer((_, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><title>other</title>');
    });
    await new Promise<void>((r) => other!.listen(0, '127.0.0.1', r));
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${(other.address() as AddressInfo).port}/`);
    // A string, not a function: tsx would add helpers the page does not have.
    const result = (await page.evaluate(`(async (base) => {
      const ws = (path) => new Promise((resolve) => {
        const s = new WebSocket('ws://' + base + path);
        s.onopen = () => resolve('open');
        s.onerror = () => resolve('refused');
        setTimeout(() => resolve('timeout'), 5000);
      });
      let boot, plain;
      try {
        const r = await fetch('http://' + base + '/boot.json', { headers: { 'X-Gty': 'boot' } });
        boot = 'read ' + r.status;
      } catch { boot = 'refused'; }
      try {
        // A simple request is sent, but its response cannot be read (no CORS).
        await (await fetch('http://' + base + '/boot.json')).text();
        plain = 'read';
      } catch { plain = 'refused'; }
      return { daemon: await ws('/ws'), ipc: await ws('/ipc'), boot, plain };
    })(${JSON.stringify(target.host)})`)) as Record<string, string>;
    assert.deepEqual(result, { daemon: 'refused', ipc: 'refused', boot: 'refused', plain: 'refused' });
    assert.match(server.stderr(), /refused GET \/ws: foreign Origin/);
    await page.close();
  } finally {
    other?.close();
    server.proc.kill();
  }
});
