// End to end in a browser against code-server with the Linux VSIX installed.
// Run through docker compose (see docker-compose.yml): CODE_SERVER_URL points
// at the server and /workspace is shared with it.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { Browser, BrowserType, chromium, firefox, Frame, Page, webkit } from 'playwright-core';

const URL_ = process.env.CODE_SERVER_URL ?? 'http://localhost:8080';
const WS = process.env.E2E_WORKSPACE ?? '/workspace';
/** chromium (default), firefox or webkit: gty-term must work in all three. */
const ENGINE = (process.env.GTY_BROWSER ?? 'chromium') as 'chromium' | 'firefox' | 'webkit';
const ENGINES: Record<string, BrowserType> = { chromium, firefox, webkit };

let browser: Browser;
let page: Page;

before(async () => {
  // Webviews need a secure context, so CODE_SERVER_URL must be HTTPS or
  // localhost (docker-compose.yml shares code-server's network for that).
  browser = await ENGINES[ENGINE].launch();
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await openWorkbench();
});
after(() => browser?.close());

async function openWorkbench(): Promise<void> {
  await page.goto(`${URL_}/?folder=${WS}`);
  await page.locator('.monaco-workbench').waitFor({ timeout: 60000 });
  const trust = page.getByRole('button', { name: /Yes, I trust/ });
  if (await trust.isVisible().catch(() => false)) await trust.click();
}

async function runCommand(title: string): Promise<void> {
  await page.keyboard.press('F1');
  const input = page.locator('.quick-input-widget input');
  await input.waitFor();
  await input.fill(`>${title}`);
  // Fuzzy matching can rank another command first (several contain the same
  // words), so move down until the focused row is exactly this command.
  // Its aria-label is "<title>" or "<title>, <keybinding>".
  const exact = (label: string | null) => !!label && (label === title || label.startsWith(`${title}, `));
  for (let i = 0; i < 20; i++) {
    const focused = page.locator('.quick-input-list .monaco-list-row.focused').first();
    await focused.waitFor({ state: 'attached' });
    if (exact(await focused.getAttribute('aria-label'))) {
      await page.keyboard.press('Enter');
      return;
    }
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(50);
  }
  throw new Error(`command not found in palette: ${title}`);
}

/** The terminal's document lives two iframes deep inside the webview element. */
async function terminalFrame(): Promise<Frame> {
  for (let i = 0; i < 200; i++) {
    for (const f of page.frames()) {
      if (await f.locator('#terminal canvas').count().catch(() => 0)) return f;
    }
    await page.waitForTimeout(100);
  }
  throw new Error('terminal webview not found');
}

async function waitForFile(name: string, expected: string): Promise<void> {
  const file = `${WS}/${name}`;
  for (let i = 0; i < 200; i++) {
    if (existsSync(file) && readFileSync(file, 'utf8').trim() === expected) return;
    await page.waitForTimeout(100);
  }
  assert.fail(`${file} never contained ${expected} (has: ${existsSync(file) ? JSON.stringify(readFileSync(file, 'utf8')) : 'no file'})`);
}

async function typeInTerminal(text: string): Promise<void> {
  const f = await terminalFrame();
  await f.locator('#terminal').click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

test('open a terminal tab and run a command', async () => {
  rmSync(`${WS}/one.txt`, { force: true });
  await runCommand('Ghostty: New Terminal');
  await page.locator('.tab', { hasText: 'Ghostty 1' }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500); // first prompt
  await typeInTerminal('echo e2e-$((40+2)) > one.txt');
  await waitForFile('one.txt', 'e2e-42');
});

test('the environment says vscode', async () => {
  await typeInTerminal('echo "$TERM_PROGRAM/$CODE_GTY" > env.txt');
  await waitForFile('env.txt', 'vscode/1');
});

test('workbench shortcuts pass through while the terminal has focus', async () => {
  const f = await terminalFrame();
  await f.locator('#terminal').click();
  await page.keyboard.press('Control+Shift+P');
  await page.locator('.quick-input-widget').waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
});

test('the tab moves into a split and keeps working', async () => {
  await runCommand('View: Move Editor into Right Group');
  await page.waitForTimeout(1500);
  assert.ok((await page.locator('.editor-group-container').count()) >= 2);
  await typeInTerminal('echo split > split.txt');
  await waitForFile('split.txt', 'split');
});

test('reload reattaches the tab to the same shell (persistent sessions)', async () => {
  await typeInTerminal('mkdir -p sub && cd sub && KEPT=across-reload');
  // code-server saves webview state lazily: with 0.5 s here the restored
  // shell started in the old directory. Known limitation, see README.
  await page.waitForTimeout(5000);
  await page.reload();
  await page.locator('.monaco-workbench').waitFor({ timeout: 60000 });
  await page.locator('.tab', { hasText: /Ghostty/ }).first().click({ timeout: 30000 });
  const f = await terminalFrame();
  await f.locator('#terminal canvas').waitFor();
  await page.waitForTimeout(1500);
  // The same shell: its directory and its unexported variable survived.
  await typeInTerminal(`echo "$(pwd) $KEPT" > ${WS}/restored.txt`);
  await waitForFile('restored.txt', `${WS}/sub across-reload`);
});

test('the host engine answers queries from a program in the terminal', async () => {
  // DA1 from the authoritative engine: the reply is typed back by the PTY
  // and saved by the shell.
  rmSync(`${WS}/da.txt`, { force: true });
  await typeInTerminal(`printf '\\033[c'; read -rs -t 2 -d c r; echo "\${r:1}" > ${WS}/da.txt`);
  await waitForFile('da.txt', '[?62;4;22;52'); // 4: sixel, through the image bridge
});

test('the WASM is served with the right type', async () => {
  const f = await terminalFrame();
  const wasm = await f.evaluate(() => document.body.dataset.wasm!);
  const type = await f.evaluate(async (u) => (await fetch(u)).headers.get('content-type'), wasm);
  assert.match(type ?? '', /application\/wasm/);
});
