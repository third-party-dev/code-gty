// Loads the real webview bundle in headless Chromium against a mock host.
// Needs a Chromium for playwright-core: set CHROMIUM_PATH, or run inside the
// Playwright image (see the Dockerfile's test-webview stage).

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Browser, chromium, Page } from 'playwright-core';
import { renderTerminalHtml } from '../../src/html';
import type { WebviewConfig } from '../../src/shared/messages';

const MEDIA = join(__dirname, '../../media');
const TYPES: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

const PRELUDE = `
window.__sent = [];
window.__gtyEnableTestHooks = true;
window.__state = undefined;
window.acquireVsCodeApi = () => ({
  postMessage: (m) => window.__sent.push(m),
  getState: () => window.__state,
  setState: (s) => { window.__state = s; },
});
window.__windowKeys = [];
window.addEventListener('keydown', (e) => window.__windowKeys.push(e.key));
window.__cspViolations = [];
document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(e.violatedDirective + ' ' + e.blockedURI));
`;

const CONFIG: WebviewConfig = {
  fontFamily: 'monospace',
  fontSize: 14,
  cursorStyle: 'block',
  cursorBlink: false,
  scrollback: 1000,
  copyOnSelection: false,
  rightClickBehavior: 'default',
  macOptionIsMeta: false,
  enableBell: false,
  passThroughKeys: ['ctrl+p', 'ctrl+shift+p', 'f1'],
  shellKeys: [],
  sendKeybindingsToShell: false,
  allowChords: true,
  linkModifier: 'ctrlCmd',
  colors: {},
  platform: 'linux',
  accessibility: false,
};

let server: Server;
let browser: Browser;
let base: string;

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/') {
      const html = renderTerminalHtml({ cspSource: base, nonce: 'testnonce', media: (f) => `${base}/media/${f}`, preludeScript: PRELUDE });
      res.writeHead(200, { 'content-type': 'text/html' }).end(html);
      return;
    }
    const file = join(MEDIA, url.pathname.replace(/^\/media\//, ''));
    if (!url.pathname.startsWith('/media/') || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream' }).end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
});

after(async () => {
  await browser?.close();
  server?.close();
});

type Sent = { type: string; [k: string]: unknown };

async function openTerminal(overrides: Partial<WebviewConfig> = {}, deviceScaleFactor = 1): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 800, height: 400 }, deviceScaleFactor });
  page.on('pageerror', (e) => console.error('pageerror', e));
  // tsx (esbuild keepNames) wraps named functions in __name(); page.evaluate
  // bodies run in the page, which has no such helper.
  await page.addInitScript('window.__name = (f) => f');
  await page.goto(base);
  await page.waitForFunction(() => (window as any).__sent.some((m: Sent) => m.type === 'ready'));
  await page.evaluate((config) => window.postMessage({ type: 'init', config, restored: false }, '*'), { ...CONFIG, ...overrides });
  await page.waitForFunction(() => (window as any).__sent.some((m: Sent) => m.type === 'resize'), undefined, { timeout: 10000 });
  return page;
}

const sent = (page: Page) => page.evaluate(() => (window as any).__sent as Sent[]);
const output = (page: Page, text: string) =>
  page.evaluate((t) => window.postMessage({ type: 'output', data: new TextEncoder().encode(t) }, '*'), text);
const clearSent = (page: Page) => page.evaluate(() => ((window as any).__sent = []));

test('loads under the shipped CSP and reports a sensible size', async () => {
  const page = await openTerminal();
  const resize = (await sent(page)).find((m) => m.type === 'resize')!;
  assert.ok((resize.cols as number) > 40 && (resize.rows as number) > 10, JSON.stringify(resize));
  assert.deepEqual(await page.evaluate(() => (window as any).__cspViolations), []);
  await page.close();
});

test('the complete bundled IosevkaTerm Nerd Font Mono loads, icons included', async () => {
  const page = await openTerminal({ fontFamily: "'IosevkaTerm Nerd Font Mono', monospace", fontSize: 14 });
  const loaded = await page.evaluate(() =>
    [...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family.replace(/"/g, '')}/${f.weight}/${f.style}`).sort(),
  );
  for (const s of ['normal/normal', 'bold/normal', 'normal/italic', 'bold/italic']) {
    assert.ok(loaded.includes(`IosevkaTerm Nerd Font Mono/${s}`), `${s} not loaded: ${loaded.join(', ')}`);
  }
  // Every icon must come from the font itself and fit one cell (half an em).
  // U+E0B6 is drawn against the right edge of its cell; Powerline glyphs
  // overlap their neighbour by ~6% by design (Chromium rounds the box to 8px),
  // where a 1em-wide icon font would reach ~15px.
  const widths = await page.evaluate(() => {
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = "14px 'IosevkaTerm Nerd Font Mono'";
    return ['M', '\ue0b6', '\ue0b4', '\uf1ae', '\ue795', '\uf496', '\uf274', '\uf2c9', '\uf0ce', '\uf2db'].map((c) => {
      const m = ctx.measureText(c);
      return { c, width: m.width, right: m.actualBoundingBoxRight };
    });
  });
  for (const w of widths) {
    assert.equal(w.width, 7, `${JSON.stringify(w)} is not one cell wide`);
    assert.ok(w.right <= 8, `${JSON.stringify(w)} spills into the next cell`);
  }
  // Rows use the font's ascent and descent (patched in scripts/build.mjs), so
  // glyphs designed to fill the line stay inside their row: 965/-285 units at
  // 14px is 13.5px + 4px, an 18px row with the baseline at 14px.
  const rows = await page.evaluate(() => {
    const metrics = (window as any).__gty.term.renderer.metrics as { height: number; baseline: number };
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = "14px 'IosevkaTerm Nerd Font Mono'";
    const ink = ['\ue0b6', '\ue0b4', '\u2588'].map((c) => {
      const m = ctx.measureText(c);
      return { c, top: metrics.baseline - m.actualBoundingBoxAscent, bottom: metrics.baseline + m.actualBoundingBoxDescent };
    });
    return { metrics, ink };
  });
  assert.deepEqual(rows.metrics, { ...rows.metrics, height: 18, baseline: 14 });
  for (const g of rows.ink) {
    // Chromium rounds ink boxes out to whole pixels: allow 1px for that (the
    // arch really ends at 18.09px). Unpatched, the row is 16px and the arch top
    // measures -2.
    assert.ok(g.top >= -1 && g.bottom <= rows.metrics.height + 1, `${JSON.stringify(g)} overflows its ${rows.metrics.height}px row`);
  }
  assert.deepEqual(await page.evaluate(() => (window as any).__cspViolations), []);
  await page.close();
});

test('Powerline arches line up with their segment background at any size and scale', async () => {
  const BLUE = [137, 180, 250];
  // Row 1: left arch, two cells of blue background, right arch.
  const line = `\x1b[?25l\r\n\x1b[38;2;${BLUE.join(';')}m\x1b[48;2;${BLUE.join(';')}m  \x1b[49m\x1b[0m`;
  for (const fontSize of [13, 14, 15, 16]) {
    for (const dpr of [1, 1.25, 1.5, 2]) {
      const page = await openTerminal({ fontFamily: "'IosevkaTerm Nerd Font Mono', monospace", fontSize }, dpr);
      await output(page, line);
      await page.waitForFunction(() => (window as any).__gty.text().includes(''));
      await page.waitForTimeout(50);
      const r = await page.evaluate(
        ({ dpr, blue }) => {
          const { width: cw, height: ch } = (window as any).__gty.term.renderer.metrics as { width: number; height: number };
          const canvas = document.querySelector('#terminal canvas') as HTMLCanvasElement;
          const px = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
          const at = (x: number, y: number) => Array.from(px.data.slice((y * px.width + x) * 4, (y * px.width + x) * 4 + 3));
          const isBlue = (x: number, y: number) => at(x, y).every((v, i) => Math.abs(v - blue[i]) <= 40);
          const dev = (v: number) => Math.round(v * dpr);
          const top = dev(ch), bottom = dev(2 * ch); // device rows [top, bottom) of row 1
          const span = (x: number) => {
            const rows = [];
            for (let y = top - 2; y < bottom + 2; y++) if (isBlue(x, y)) rows.push(y);
            return [rows[0], rows[rows.length - 1]];
          };
          const mid = Math.floor((top + bottom) / 2);
          const seams = [];
          for (let x = dev(cw); x < dev(3 * cw); x++) if (!isBlue(x, mid)) seams.push(x);
          return { top, bottom, bg: span(dev(2 * cw)), left: span(dev(cw) - 1), right: span(dev(3 * cw)), seams };
        },
        { dpr, blue: BLUE },
      );
      const where = `${fontSize}px at ${dpr}x: ${JSON.stringify(r)}`;
      assert.deepEqual(r.bg, [r.top, r.bottom - 1], `segment background fills its row, ${where}`);
      assert.deepEqual(r.left, r.bg, `left arch matches the segment height, ${where}`);
      assert.deepEqual(r.right, r.bg, `right arch matches the segment height, ${where}`);
      assert.deepEqual(r.seams, [], `no seams between cells, ${where}`);
      await page.close();
    }
  }
});

test('renders output and acknowledges it', async () => {
  const page = await openTerminal();
  await output(page, 'hello \x1b[31mworld\x1b[0m\r\n');
  await page.waitForFunction(() => (window as any).__gty.text().includes('hello world'));
  const acks = (await sent(page)).filter((m) => m.type === 'ack');
  assert.equal(acks.reduce((n, a) => n + (a.bytes as number), 0), new TextEncoder().encode('hello \x1b[31mworld\x1b[0m\r\n').length);
  await page.close();
});

test('typing goes to the shell and stops at the document', async () => {
  const page = await openTerminal();
  await page.locator('#terminal').click();
  await clearSent(page);
  await page.keyboard.type('ls');
  await page.keyboard.press('Control+r');
  await page.waitForFunction(() => (window as any).__sent.filter((m: Sent) => m.type === 'input').length >= 3);
  const inputs = (await sent(page)).filter((m) => m.type === 'input').map((m) => m.data);
  assert.deepEqual(inputs, ['l', 's', '\x12']);
  assert.deepEqual(await page.evaluate(() => (window as any).__windowKeys), [], 'shell keys must not reach the workbench');
  await page.close();
});

test('pass-through keys reach the workbench, not the shell', async () => {
  const page = await openTerminal();
  await page.locator('#terminal').click();
  await clearSent(page);
  await page.keyboard.press('Control+p');
  await page.keyboard.press('F1');
  await page.waitForTimeout(100);
  assert.deepEqual((await sent(page)).filter((m) => m.type === 'input'), []);
  assert.deepEqual(await page.evaluate(() => (window as any).__windowKeys), ['p', 'F1']);
  await page.close();
});

test('copy and paste shortcuts go through the host', async () => {
  const page = await openTerminal();
  await page.locator('#terminal').click();
  await clearSent(page);
  await page.keyboard.press('Control+Shift+V');
  await page.waitForFunction(() => (window as any).__sent.some((m: Sent) => m.type === 'paste'));
  const p = (await sent(page)).find((m) => m.type === 'paste')!;
  assert.equal(p.text, undefined);
  assert.equal(p.bracketed, false);
  await page.close();
});

test('browser paste events are captured and bracketed state reported', async () => {
  const page = await openTerminal();
  await output(page, '\x1b[?2004h');
  await clearSent(page);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'echo hi');
    document.querySelector('#terminal')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  const p = (await sent(page)).filter((m) => m.type === 'paste');
  assert.deepEqual(p, [{ type: 'paste', text: 'echo hi', bracketed: true }]);
  assert.deepEqual((await sent(page)).filter((m) => m.type === 'input'), [], 'ghostty-web must not also paste raw');
  await page.close();
});

test('host paste is sanitised and bracketed', async () => {
  const page = await openTerminal();
  await output(page, '\x1b[?2004h');
  await clearSent(page);
  await page.evaluate(() => window.postMessage({ type: 'paste', text: 'a\nb\x1b[201~c' }, '*'));
  await page.waitForFunction(() => (window as any).__sent.some((m: Sent) => m.type === 'input'));
  const input = (await sent(page)).find((m) => m.type === 'input')!;
  assert.equal(input.data, '\x1b[200~a\rbc\x1b[201~');
  await page.close();
});

test('prompt marks are recorded at their lines', async () => {
  const page = await openTerminal();
  await output(page, '\x1b]133;A\x07$ \x1b]133;B\x07ls\r\nfile\r\n\x1b]133;D;0\x07\x1b]133;A\x07$ ');
  const marks = await page.evaluate(() => (window as any).__gty.marks);
  assert.deepEqual(marks.map((m: { line: number }) => m.line), [0, 2]);
  assert.equal(marks[0].exitCode, 0);
  await page.close();
});

test('a theme change rebuilds the terminal and asks for a replay', async () => {
  const page = await openTerminal();
  await clearSent(page);
  await page.evaluate(() => document.documentElement.style.setProperty('--vscode-terminal-background', '#ffffff'));
  await page.waitForFunction(() => (window as any).__sent.some((m: Sent) => m.type === 'reattach'), undefined, { timeout: 3000 });
  await page.evaluate(() => window.postMessage({ type: 'replay', data: new TextEncoder().encode('restored'), truncated: false }, '*'));
  await page.waitForFunction(() => (window as any).__gty.text().includes('restored'));
  await page.close();
});

test('find widget counts matches in scrollback', async () => {
  const page = await openTerminal();
  let text = '';
  for (let i = 0; i < 100; i++) text += `line ${i}${i % 10 === 0 ? ' needle' : ''}\r\n`;
  await output(page, text);
  await page.evaluate(() => window.postMessage({ type: 'find' }, '*'));
  await page.locator('#find-input').fill('needle');
  await page.waitForFunction(() => document.querySelector('#find-count')!.textContent!.endsWith('of 10'));
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#find').isHidden(), true);
  await page.close();
});

test('window.open from link providers is routed to the host', async () => {
  const page = await openTerminal();
  await clearSent(page);
  await page.evaluate(() => window.open('https://example.com/x', '_blank'));
  assert.deepEqual((await sent(page)).filter((m) => m.type === 'openLink'), [{ type: 'openLink', kind: 'url', text: 'https://example.com/x' }]);
  await page.close();
});

test('Ctrl+click on a URL, a file path or an OSC 8 hyperlink opens it through the host', async () => {
  const page = await openTerminal();
  // Two OSC 8 links on one line: ghostty-web gives every linked cell the same
  // hyperlink id, so each must still open its own URI.
  const text = 'see https://example.com/x and src/extension.ts:10 here osc-label next-label';
  const osc8 = (label: string, uri: string) => `\x1b]8;;${uri}\x1b\\${label}\x1b]8;;\x1b\\`;
  await output(
    page,
    `${text.replace('osc-label', osc8('osc-label', 'https://example.com/osc')).replace('next-label', osc8('next-label', 'file://somehost/tmp/x.txt'))}\r\n`,
  );
  await page.waitForFunction((t) => (window as any).__gty.text().includes(t), text);
  /** Centre of the cell at column `col` of row 0, in page coordinates. */
  const cell = (col: number) =>
    page.evaluate((c) => {
      const { width, height } = (window as any).__gty.term.renderer.metrics as { width: number; height: number };
      const r = (document.querySelector('#terminal canvas') as HTMLCanvasElement).getBoundingClientRect();
      return { x: r.left + (c + 0.5) * width, y: r.top + 0.5 * height };
    }, col);
  for (const [target, expected] of [
    ['example.com', { type: 'openLink', kind: 'url', text: 'https://example.com/x' }],
    ['extension.ts', { type: 'openLink', kind: 'file', text: 'src/extension.ts:10' }],
    ['osc-label', { type: 'openLink', kind: 'url', text: 'https://example.com/osc' }],
    ['next-label', { type: 'openLink', kind: 'url', text: 'file://somehost/tmp/x.txt' }],
  ] as const) {
    await clearSent(page);
    const { x, y } = await cell(text.indexOf(target) + 2);
    await page.mouse.move(x, y);
    await page.keyboard.down('Control');
    await page.mouse.click(x, y);
    await page.keyboard.up('Control');
    await page.waitForTimeout(200);
    const opened = (await sent(page)).filter((m) => m.type === 'openLink');
    assert.deepEqual(opened, [expected], `Ctrl+click on ${target}: ${JSON.stringify(opened)} links ${JSON.stringify(await page.evaluate(() => (window as any).__gty.hyperlinks))}`);
  }
  await page.close();
});

test('state persisted by the host is stored for the serializer', async () => {
  const page = await openTerminal();
  await page.evaluate(() => window.postMessage({ type: 'persist', state: { cwd: '/tmp', title: 'x' } }, '*'));
  await page.waitForFunction(() => (window as any).__state?.cwd === '/tmp');
  await page.close();
});
