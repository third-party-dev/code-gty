// Loads the real webview bundle (gty-term on libghostty-vt) in a browser
// against a mock host. Needs a browser for playwright-core: set CHROMIUM_PATH
// (or GTY_BROWSER=firefox|webkit with the matching path), or run inside the
// Playwright image (see the Dockerfile's test-webview stage).

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Browser, BrowserType, chromium, firefox, Page, webkit } from 'playwright-core';
import { HostEngine } from '../../src/engine/hostEngine';
import { renderTerminalHtml } from '../../src/html';
import type { WebviewConfig } from '../../src/shared/messages';
import { loadVtSync } from '../../vt/loader';

const MEDIA = join(__dirname, '../../media');
const TYPES: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const ENGINES: Record<string, BrowserType> = { chromium, firefox, webkit };
const ENGINE = process.env.GTY_BROWSER ?? 'chromium';

const PRELUDE = `
window.__sent = [];
window.__gtyEnableTestHooks = true;
window.__state = undefined;
window.__autoAttach = !window.__autoAttachOff;
window.acquireVsCodeApi = () => ({
  postMessage: (m) => {
    window.__sent.push(m);
    // Mock host: the first size request starts an empty session.
    if (m.type === 'resize' && window.__autoAttach && !window.__attached) {
      window.__attached = true;
      setTimeout(() => window.postMessage({ type: 'attach', cols: m.cols, rows: m.rows }, '*'));
    }
  },
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
  lineHeight: 1,
  letterSpacing: 0,
  fontWeight: 'normal',
  fontWeightBold: 'bold',
  cursorStyle: 'block',
  cursorBlink: false,
  cursorWidth: 1,
  scrollback: 1000,
  copyOnSelection: false,
  rightClickBehavior: 'default',
  macOptionIsMeta: false,
  enableBell: false,
  drawBoldTextInBrightColors: true,
  minimumContrastRatio: 1,
  customGlyphs: true,
  wordSeparators: ' ()[]{}\',"`─‘’“”|',
  kittyKeyboard: true,
  images: true,
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
  const path = process.env.BROWSER_PATH || (ENGINE === 'chromium' ? process.env.CHROMIUM_PATH : undefined) || undefined;
  browser = await ENGINES[ENGINE].launch({ executablePath: path });
});

after(async () => {
  await browser?.close();
  server?.close();
});

type Sent = { type: string; [k: string]: unknown };

async function openTerminal(overrides: Partial<WebviewConfig> = {}, deviceScaleFactor = 1, autoAttach = true): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 800, height: 400 }, deviceScaleFactor });
  page.on('pageerror', (e) => console.error('pageerror', e));
  page.on('console', (m) => m.type() === 'error' && console.error('console', m.text()));
  // tsx (esbuild keepNames) wraps named functions in __name(); page.evaluate
  // bodies run in the page, which has no such helper.
  await page.addInitScript('window.__name = (f) => f');
  if (!autoAttach) await page.addInitScript('window.__autoAttachOff = true');
  await page.goto(base);
  await page.waitForFunction(() => (window as any).__sent.some((m: Sent) => m.type === 'ready'));
  await page.evaluate((config) => window.postMessage({ type: 'init', config, restored: false }, '*'), { ...CONFIG, ...overrides });
  await page.waitForFunction(() => (window as any).__sent.some((m: Sent) => m.type === 'resize'), undefined, { timeout: 10000 });
  if (autoAttach) await page.waitForFunction(() => !!(window as any).__gty.term?.mirror);
  return page;
}

const sent = (page: Page) => page.evaluate(() => (window as any).__sent as Sent[]);
const output = (page: Page, text: string) =>
  page.evaluate((t) => window.postMessage({ type: 'output', data: new TextEncoder().encode(t) }, '*'), text);
const clearSent = (page: Page) => page.evaluate(() => ((window as any).__sent = []));
const inputs = async (page: Page) => (await sent(page)).filter((m) => m.type === 'input').map((m) => m.data as string);
const metrics = (page: Page) => page.evaluate(() => (window as any).__gty.term.cellMetrics as { cellWidth: number; cellHeight: number; dpr: number });

/** Page coordinates of the centre of a cell. */
async function cellCenter(page: Page, col: number, row: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ([c, r]) => {
      const m = (window as any).__gty.term.cellMetrics as { cellWidth: number; cellHeight: number; dpr: number };
      const rect = (document.querySelector('#terminal canvas') as HTMLCanvasElement).getBoundingClientRect();
      return { x: rect.left + ((c + 0.5) * m.cellWidth) / m.dpr, y: rect.top + ((r + 0.5) * m.cellHeight) / m.dpr };
    },
    [col, row],
  );
}

test('loads under the shipped CSP and reports a sensible size', async () => {
  const page = await openTerminal();
  const resize = (await sent(page)).find((m) => m.type === 'resize')!;
  assert.ok((resize.cols as number) > 40 && (resize.rows as number) > 10, JSON.stringify(resize));
  assert.ok((resize.cellWidth as number) > 0 && (resize.cellHeight as number) > 0);
  assert.ok((await sent(page)).some((m) => m.type === 'theme'), 'theme colours are reported to the host');
  assert.deepEqual(await page.evaluate(() => (window as any).__cspViolations), []);
  await page.close();
});

test('the bundled IosevkaTerm Nerd Font Mono loads and sizes the cell from its ascent and descent', async () => {
  const page = await openTerminal({ fontFamily: "'IosevkaTerm Nerd Font Mono', monospace", fontSize: 14 });
  const loaded = await page.evaluate(() =>
    [...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family.replace(/"/g, '')}/${f.weight}/${f.style}`).sort(),
  );
  for (const s of ['normal/normal', 'bold/normal', 'normal/italic', 'bold/italic']) {
    assert.ok(loaded.includes(`IosevkaTerm Nerd Font Mono/${s}`) || loaded.includes(`IosevkaTerm Nerd Font Mono/${s.replace('bold', '700').replace('normal/', '400/')}`), `${s} not loaded: ${loaded.join(', ')}`);
  }
  // 965/-285 units at 14px: a 7px cell, 18px row.
  assert.deepEqual(await metrics(page), { cellWidth: 7, cellHeight: 18, dpr: 1 });
  await page.close();
});

test('Powerline arches and blocks line up with their segment background at any size and scale', async () => {
  const BLUE = [137, 180, 250];
  // Row 1: left arch, two cells of blue background, right arch, then a full block.
  const line = `\x1b[?25l\r\n\x1b[38;2;${BLUE.join(';')}m\ue0b6\x1b[48;2;${BLUE.join(';')}m  \x1b[49m\ue0b4\u2588\x1b[0m`;
  for (const fontSize of [13, 14, 15, 16]) {
    for (const dpr of [1, 1.25, 1.5, 2]) {
      const page = await openTerminal({ fontFamily: "'IosevkaTerm Nerd Font Mono', monospace", fontSize }, dpr);
      await output(page, line);
      await page.waitForFunction(() => (window as any).__gty.text().includes('\ue0b4'));
      await page.waitForTimeout(80);
      const r = await page.evaluate((blue) => {
        const m = (window as any).__gty.term.cellMetrics as { cellWidth: number; cellHeight: number };
        const cw = m.cellWidth;
        const ch = m.cellHeight;
        const canvas = document.querySelector('#terminal canvas') as HTMLCanvasElement;
        const px = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
        const at = (x: number, y: number) => Array.from(px.data.slice((y * px.width + x) * 4, (y * px.width + x) * 4 + 3));
        const isBlue = (x: number, y: number) => at(x, y).every((v, i) => Math.abs(v - blue[i]) <= 40);
        const top = ch;
        const bottom = 2 * ch;
        const span = (x: number) => {
          const rows = [];
          for (let y = top - 2; y < bottom + 2; y++) if (isBlue(x, y)) rows.push(y);
          return [rows[0], rows[rows.length - 1]];
        };
        const mid = Math.floor((top + bottom) / 2);
        const seams = [];
        for (let x = cw; x < 3 * cw; x++) if (!isBlue(x, mid)) seams.push(x);
        return { top, bottom, bg: span(2 * cw), left: span(cw - 1), right: span(3 * cw), block: span(4 * cw + 1), seams };
      }, BLUE);
      const cells = await page.evaluate(() => (window as any).__gty.term.lastRows[1]?.cells.slice(0, 6).map((c: any) => ({ t: c.text, w: c.wide, bg: c.bg, fg: c.fg })));
      const where = `${fontSize}px at ${dpr}x: ${JSON.stringify(r)} cells ${JSON.stringify(cells)}`;
      assert.deepEqual(r.bg, [r.top, r.bottom - 1], `segment background fills its row, ${where}`);
      assert.deepEqual(r.left, r.bg, `left arch matches the segment height, ${where}`);
      assert.deepEqual(r.right, r.bg, `right arch matches the segment height, ${where}`);
      assert.deepEqual(r.block, r.bg, `full block fills its cell, ${where}`);
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
  // Injected bytes (notices from the host) carry no credit.
  await clearSent(page);
  await page.evaluate(() => window.postMessage({ type: 'output', data: new TextEncoder().encode('note'), ack: false }, '*'));
  await page.waitForFunction(() => (window as any).__gty.text().includes('note'));
  assert.deepEqual((await sent(page)).filter((m) => m.type === 'ack'), []);
  await page.close();
});

test('typing goes to the shell, encoded with the program’s modes, and stops at the document', async () => {
  const page = await openTerminal();
  await page.locator('#terminal').click();
  await clearSent(page);
  await page.keyboard.type('ls');
  await page.keyboard.press('Control+r');
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(() => (window as any).__sent.filter((m: Sent) => m.type === 'input').length >= 4);
  assert.deepEqual(await inputs(page), ['l', 's', '\x12', '\x1b[A']);
  // Application cursor keys and the Kitty keyboard protocol come from the mirror.
  await output(page, '\x1b[?1h');
  await page.waitForTimeout(50);
  await clearSent(page);
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(() => (window as any).__sent.some((m: Sent) => m.type === 'input'));
  assert.deepEqual(await inputs(page), ['\x1bOA']);
  await output(page, '\x1b[>1u');
  await page.waitForTimeout(50);
  await clearSent(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+c');
  await page.waitForFunction(() => (window as any).__sent.filter((m: Sent) => m.type === 'input').length >= 2);
  assert.deepEqual(await inputs(page), ['\x1b[27u', '\x1b[99;5u']);
  assert.deepEqual(await page.evaluate(() => (window as any).__windowKeys), [], 'shell keys must not reach the workbench');
  await page.close();
});

test('IME composition shows pre-edit text and commits it as one input', async () => {
  const page = await openTerminal();
  await page.locator('#terminal').click();
  await clearSent(page);
  await page.evaluate(() => {
    const ta = document.querySelector('.gty-input') as HTMLTextAreaElement;
    ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'にほ' }));
    ta.dispatchEvent(new CompositionEvent('compositionend', { data: '日本' }));
  });
  await page.waitForFunction(() => (window as any).__sent.some((m: Sent) => m.type === 'input'));
  assert.deepEqual(await inputs(page), ['日本']);
  await page.close();
});

test('pass-through keys reach the workbench, not the shell', async () => {
  const page = await openTerminal();
  await page.locator('#terminal').click();
  await clearSent(page);
  await page.keyboard.press('Control+p');
  await page.keyboard.press('F1');
  await page.waitForTimeout(100);
  assert.deepEqual(await inputs(page), []);
  assert.deepEqual(await page.evaluate(() => (window as any).__windowKeys), ['p', 'F1']);
  await page.close();
});

test('the paste shortcut and browser paste events go to the host', async () => {
  const page = await openTerminal();
  await page.locator('#terminal').click();
  await clearSent(page);
  await page.keyboard.press('Control+Shift+V');
  await page.waitForFunction(() => (window as any).__sent.some((m: Sent) => m.type === 'paste'));
  assert.deepEqual((await sent(page)).filter((m) => m.type === 'paste'), [{ type: 'paste' }]);
  await clearSent(page);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'echo hi');
    document.querySelector('#terminal')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  // Firefox does not expose clipboardData on synthetic events; the webview then
  // lets the host read the clipboard, which is the same paste.
  const pastes = (await sent(page)).filter((m) => m.type === 'paste');
  assert.equal(pastes.length, 1);
  if (ENGINE !== 'firefox') assert.deepEqual(pastes, [{ type: 'paste', text: 'echo hi' }]);
  assert.deepEqual(await inputs(page), [], 'the webview must not also paste raw');
  await page.close();
});

test('double-click selects a word, drag extends it, and copy goes to the host', async () => {
  const page = await openTerminal();
  await output(page, 'alpha beta gamma\r\nsecond line\r\n');
  await page.waitForFunction(() => (window as any).__gty.text().includes('second line'));
  const b = await cellCenter(page, 7, 0);
  await page.mouse.dblclick(b.x, b.y);
  await page.waitForFunction(() => (window as any).__gty.selection() === 'beta');
  // A fresh press after the repeat-click interval starts a cell-wise drag.
  await page.waitForTimeout(700);
  const start = await cellCenter(page, 6, 0);
  const g = await cellCenter(page, 14, 0);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(g.x, g.y, { steps: 4 });
  await page.mouse.up();
  assert.equal(await page.evaluate(() => (window as any).__gty.selection()), 'beta gam');
  await clearSent(page);
  await page.keyboard.press('Control+Shift+C');
  assert.deepEqual((await sent(page)).filter((m) => m.type === 'copy'), [{ type: 'copy', text: 'beta gam' }]);
  await page.close();
});

test('mouse events are reported in SGR format when the program tracks the mouse', async () => {
  const page = await openTerminal();
  await output(page, '\x1b[?1000h\x1b[?1006h');
  await page.waitForTimeout(50);
  await clearSent(page);
  const c = await cellCenter(page, 4, 2);
  await page.mouse.click(c.x, c.y);
  await page.waitForFunction(() => (window as any).__sent.filter((m: Sent) => m.type === 'input').length >= 2);
  assert.deepEqual(await inputs(page), ['\x1b[<0;5;3M', '\x1b[<0;5;3m']);
  await page.close();
});

test('the wheel scrolls scrollback, or sends arrows on the alternate screen', async () => {
  const page = await openTerminal();
  let text = '';
  for (let i = 0; i < 200; i++) text += `line ${i}\r\n`;
  await output(page, text);
  await page.waitForFunction(() => (window as any).__gty.text().includes('line 199'));
  const c = await cellCenter(page, 2, 2);
  await page.mouse.move(c.x, c.y);
  await page.mouse.wheel(0, -400);
  await page.waitForFunction(() => !(window as any).__gty.text().includes('line 199'));
  await output(page, '\x1b[?1049h\x1b[?1007h');
  await page.waitForTimeout(50);
  await clearSent(page);
  await page.mouse.wheel(0, 100);
  await page.waitForFunction(() => (window as any).__sent.some((m: Sent) => m.type === 'input'));
  assert.ok((await inputs(page)).every((d) => d === '\x1b[B'), JSON.stringify(await inputs(page)));
  await page.close();
});

test('a render hold keeps the last complete frame until it ends', async () => {
  const page = await openTerminal();
  await output(page, 'frame one');
  await page.waitForFunction(() => (window as any).__gty.text().includes('frame one'));
  await output(page, '\x1b[?2026h\x1b[2J\x1b[Hframe two (half drawn)');
  await page.waitForTimeout(100);
  assert.match(await page.evaluate(() => (window as any).__gty.text()), /frame one/);
  await output(page, '\x1b[?2026l');
  await page.waitForFunction(() => (window as any).__gty.text().includes('frame two'));
  await page.close();
});

test('a webview attached from a host snapshot shows the exact screen and continues the stream', async () => {
  const vt = loadVtSync(new WebAssembly.Module(readFileSync(join(MEDIA, 'ghostty-vt.wasm'))));
  const forwarded: Uint8Array[] = [];
  const engine = new HostEngine(
    vt,
    { cols: 80, rows: 20, scrollbackLines: 1000, colors: {}, cursorStyle: 'block', cursorBlink: false, xtversion: 'x', answerback: '', clipboard: 'write' },
    { writePty: () => undefined, forward: (d) => forwarded.push(d) },
  );
  let text = '';
  for (let i = 0; i < 50; i++) text += `\x1b[3${i % 8}mhistory ${i}\x1b[0m\r\n`;
  engine.push(new TextEncoder().encode(`${text}\x1b[?2004hprompt$ \x1b[1;3`));
  const snapshot = engine.snapshot();
  const page = await openTerminal({}, 1, false);
  await page.evaluate((snap) => window.postMessage({ type: 'attach', snapshot: new Uint8Array(snap), cols: 80, rows: 20 }, '*'), [...snapshot]);
  await page.waitForFunction(() => (window as any).__gty.text().includes('prompt$'));
  // The unfinished SGR in the snapshot completes in the mirror.
  await output(page, '2mbold');
  await page.waitForFunction(() => (window as any).__gty.text().includes('prompt$ bold'));
  assert.equal(await page.evaluate(() => (window as any).__gty.term.hasBracketedPaste), true);
  engine.dispose();
  await page.close();
});

test('a theme change recolours both engines without rebuilding', async () => {
  const page = await openTerminal();
  await output(page, 'keep me');
  await page.waitForFunction(() => (window as any).__gty.text().includes('keep me'));
  await clearSent(page);
  await page.evaluate(() => document.documentElement.style.setProperty('--vscode-terminal-background', '#ffffff'));
  await page.waitForFunction(() => (window as any).__sent.some((m: Sent) => m.type === 'theme'), undefined, { timeout: 3000 });
  const theme = (await sent(page)).find((m) => m.type === 'theme')!;
  assert.equal(theme.background, 0xffffff);
  assert.ok(!(await sent(page)).some((m) => m.type === 'reattach'));
  assert.match(await page.evaluate(() => (window as any).__gty.text()), /keep me/);
  await page.close();
});

test('find counts matches in scrollback with the engine’s search', async () => {
  const page = await openTerminal();
  let text = '';
  for (let i = 0; i < 100; i++) text += `line ${i}${i % 10 === 0 ? ' needle' : ''}\r\n`;
  await output(page, text);
  await page.evaluate(() => window.postMessage({ type: 'find' }, '*'));
  await page.locator('#find-input').fill('needle');
  await page.waitForFunction(() => /10 found|of 10/.test(document.querySelector('#find-count')!.textContent!));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#find-count')!.textContent === '1 of 10');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#find').isHidden(), true);
  await page.close();
});

test('Ctrl+click on a URL, a file path or an OSC 8 hyperlink opens it through the host', async () => {
  const page = await openTerminal();
  const text = 'see https://example.com/x and src/extension.ts:10 here osc-label next-label';
  const osc8 = (label: string, uri: string) => `\x1b]8;;${uri}\x1b\\${label}\x1b]8;;\x1b\\`;
  await output(
    page,
    `${text.replace('osc-label', osc8('osc-label', 'https://example.com/osc')).replace('next-label', osc8('next-label', 'file://somehost/tmp/x.txt'))}\r\n`,
  );
  await page.waitForFunction((t) => (window as any).__gty.text().includes(t), text);
  for (const [target, expected] of [
    ['example.com', { type: 'openLink', kind: 'url', text: 'https://example.com/x' }],
    ['extension.ts', { type: 'openLink', kind: 'file', text: 'src/extension.ts:10' }],
    ['osc-label', { type: 'openLink', kind: 'url', text: 'https://example.com/osc' }],
    ['next-label', { type: 'openLink', kind: 'url', text: 'file://somehost/tmp/x.txt' }],
  ] as const) {
    await clearSent(page);
    const { x, y } = await cellCenter(page, text.indexOf(target) + 2, 0);
    await page.mouse.move(x, y);
    await page.waitForTimeout(50);
    await page.keyboard.down('Control');
    await page.mouse.click(x, y);
    await page.keyboard.up('Control');
    await page.waitForTimeout(100);
    const opened = (await sent(page)).filter((m) => m.type === 'openLink');
    assert.deepEqual(opened, [expected], `Ctrl+click on ${target}: ${JSON.stringify(opened)}`);
  }
  await page.close();
});

test('state persisted by the host is stored for the serializer', async () => {
  const page = await openTerminal();
  await page.evaluate(() => window.postMessage({ type: 'persist', state: { cwd: '/tmp', title: 'x' } }, '*'));
  await page.waitForFunction(() => (window as any).__state?.cwd === '/tmp');
  await page.close();
});

test('Kitty graphics images are drawn at their cells', async () => {
  const page = await openTerminal();
  // A 4x4 opaque red RGB image (f=24), two cells wide and one row tall, at row 1.
  const rgb = Buffer.alloc(4 * 4 * 3);
  for (let i = 0; i < 16; i++) rgb.set([230, 20, 20], i * 3);
  await output(page, `\r\n\x1b_Ga=T,f=24,s=4,v=4,i=9,c=2,r=1;${rgb.toString('base64')}\x1b\\`);
  await page.waitForTimeout(150);
  const px = await page.evaluate(() => {
    const m = (window as any).__gty.term.cellMetrics as { cellWidth: number; cellHeight: number };
    const canvas = document.querySelector('#terminal canvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    const at = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3));
    return { inside: at(Math.floor(m.cellWidth), Math.floor(m.cellHeight * 1.5)), outside: at(Math.floor(m.cellWidth * 3), Math.floor(m.cellHeight * 1.5)) };
  });
  assert.deepEqual(px.inside, [230, 20, 20], JSON.stringify(px));
  assert.notDeepEqual(px.outside, [230, 20, 20]);
  await page.close();
});

test('text stays visible next to and below an image across later frames', async () => {
  const page = await openTerminal();
  const rgb = Buffer.alloc(4 * 4 * 3, 200);
  await output(page, `\x1b_Ga=T,f=24,s=4,v=4,i=11,c=2,r=1;${rgb.toString('base64')}\x1b\\\r\nAFTER IMAGE TEXT\r\n`);
  await page.waitForFunction(() => (window as any).__gty.text().includes('AFTER IMAGE TEXT'));
  // Later frames (cursor blink, more output elsewhere) must keep drawing it.
  await output(page, '\r\nmore');
  await page.waitForTimeout(1500);
  const ink = await page.evaluate(() => {
    const m = (window as any).__gty.term.cellMetrics as { cellWidth: number; cellHeight: number };
    const canvas = document.querySelector('#terminal canvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    // Row 1 holds "AFTER IMAGE TEXT": count pixels that differ from the background.
    const d = ctx.getImageData(0, m.cellHeight, m.cellWidth * 16, m.cellHeight).data;
    const bg = Array.from(ctx.getImageData(canvas.width - 2, canvas.height - 2, 1, 1).data.slice(0, 3));
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 60) n++;
    return n;
  });
  assert.ok(ink > 50, `row with text has only ${ink} lit pixels`);
  await page.close();
});

test('Kitty Unicode placeholder cells (as tmux uses) show the image, not glyphs', async () => {
  const page = await openTerminal();
  // A solid red 4x4 image with a virtual placement 2 columns by 1 row (U=1),
  // then two placeholder cells on row 1 whose foreground colour (palette 42)
  // names the image and whose diacritics give row 0, columns 0 and 1.
  const rgb = Buffer.alloc(4 * 4 * 3);
  for (let i = 0; i < 16; i++) rgb.set([230, 20, 20], i * 3);
  const ph = (col: string) => `\u{10EEEE}̅${col}`;
  await output(page, `\x1b_Ga=T,f=24,s=4,v=4,i=42,U=1,c=2,r=1,q=2;${rgb.toString('base64')}\x1b\\\r\n\x1b[38;5;42m${ph('̅')}${ph('̍')}\x1b[39m after`);
  await page.waitForFunction(() => (window as any).__gty.text().includes('after'));
  await page.waitForTimeout(200);
  const r = await page.evaluate(() => {
    const m = (window as any).__gty.term.cellMetrics as { cellWidth: number; cellHeight: number };
    const ctx = (document.querySelector('#terminal canvas') as HTMLCanvasElement).getContext('2d')!;
    const d = ctx.getImageData(0, m.cellHeight, m.cellWidth * 2, m.cellHeight).data;
    const canvas = ctx.canvas;
    const bg = Array.from(ctx.getImageData(canvas.width - 2, canvas.height - 2, 1, 1).data.slice(0, 3));
    // The square image keeps its aspect ratio inside the 2x1 cell box, so
    // part of the box is background. Anything else would be glyph ink.
    let red = 0;
    let other = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - 230) < 30 && d[i + 1] < 60 && d[i + 2] < 60) red++;
      else if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 40) other++;
    }
    return { red, other, text: (window as any).__gty.text() };
  });
  assert.ok(r.red > 0, `no image drawn: ${JSON.stringify(r)}`);
  assert.equal(r.other, 0, `glyph ink over the image: ${JSON.stringify(r)}`);
  assert.doesNotMatch(r.text, /\u{10EEEE}/u, 'placeholders are not text');
  await page.close();
});
