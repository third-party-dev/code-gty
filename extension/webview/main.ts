// Webview side of a code-gty terminal: ghostty-web plus the glue that makes it
// behave like VS Code's terminal. It never calls VS Code APIs; it only posts
// messages to the extension host.

import { FitAddon, Ghostty, ILink, ITheme, Terminal } from 'ghostty-web';
import { KeyEventLike, KeyMatcher, parseKey, matches } from '../src/shared/keys';
import type { HostToWebview, PersistedState, WebviewConfig, WebviewToHost } from '../src/shared/messages';
import { preparePaste } from '../src/shared/paste';
import { findFileLinks } from './fileLinks';
import { FindController } from './find';
import { PromptMarks } from './marks';
import { readTheme, sameTheme } from './theme';

interface VsCodeApi {
  postMessage(msg: WebviewToHost): void;
  getState(): PersistedState | undefined;
  setState(state: PersistedState): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const post = (m: WebviewToHost) => vscode.postMessage(m);
const container = document.getElementById('terminal') as HTMLDivElement;
const noticeEl = document.getElementById('notice') as HTMLDivElement;
const a11yEl = document.getElementById('a11y') as HTMLDivElement;

let ghostty: Ghostty | undefined;
let term: Terminal | undefined;
let fit: FitAddon | undefined;
let config: WebviewConfig | undefined;
let theme: ITheme | undefined;
let passThrough = new KeyMatcher([]);
let shellKeys = new KeyMatcher([]);
let chordPending = false;
let exited = false;
const marks = new PromptMarks();
let find: FindController | undefined;
/** Events the workbench should see; everything else stops at the document. */
const toWorkbench = new WeakSet<Event>();

function log(level: 'info' | 'warn' | 'error', message: string): void {
  post({ type: 'log', level, message });
}

window.addEventListener('error', (e) => log('error', `${e.message} at ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => log('error', `unhandled rejection: ${String(e.reason)}`));

// ghostty-web's link providers call window.open; route that to the host so
// links open through VS Code (port-forwarded when remote).
window.open = ((url?: string | URL) => {
  if (url) post({ type: 'openLink', kind: 'url', text: String(url) });
  return null;
}) as typeof window.open;

function showNotice(text: string): void {
  noticeEl.textContent = text;
  noticeEl.hidden = false;
}

// ---- terminal lifecycle --------------------------------------------------

// ghostty-web measures the cell size once, when the font is set, so the faces
// must be loaded first or the grid is sized for a fallback font. Loads the
// regular, bold and italic faces of the configured font.
async function loadFonts(stack: string, size: number): Promise<void> {
  if (!document.fonts) return;
  const styles = ['', 'bold ', 'italic ', 'italic bold '];
  const loads = styles.map((s) => document.fonts.load(`${s}${size}px ${stack}`, 'M'));
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3000));
  await Promise.race([Promise.allSettled(loads), timeout]);
}

function computeTheme(): ITheme {
  return readTheme(getComputedStyle(document.documentElement), config?.colors ?? {});
}

function buildTerminal(): void {
  if (!ghostty || !config) return;
  find?.dispose();
  fit?.dispose();
  term?.dispose();
  container.replaceChildren();
  marks.clear();
  theme = computeTheme();
  document.body.style.backgroundColor = theme.background ?? '';

  const t = new Terminal({
    ghostty,
    fontFamily: config.fontFamily,
    fontSize: config.fontSize,
    cursorStyle: config.cursorStyle,
    cursorBlink: config.cursorBlink,
    scrollback: config.scrollback,
    theme,
    smoothScrollDuration: 0,
  });
  term = t;
  t.open(container);
  fit = new FitAddon();
  t.loadAddon(fit);
  fit.fit();
  fit.observeResize();

  t.onResize(({ cols, rows }) => post({ type: 'resize', cols, rows }));
  t.onData((data) => post({ type: 'input', data }));
  t.onBell(() => bell());
  t.onSelectionChange(() => {
    if (config?.copyOnSelection && t.hasSelection()) post({ type: 'copy', text: t.getSelection() });
  });
  t.attachCustomKeyEventHandler(onKey);
  t.registerLinkProvider({
    provideLinks(y, callback) {
      const line = t.buffer.active.getLine(y)?.translateToString(true);
      if (!line) return callback(undefined);
      const links: ILink[] = findFileLinks(line).map((l) => ({
        text: l.text,
        range: { start: { x: l.start, y }, end: { x: l.end - 1, y } },
        activate(ev: MouseEvent) {
          if (linkModifierHeld(ev)) post({ type: 'openLink', kind: 'file', text: l.text });
        },
      }));
      callback(links.length ? links : undefined);
    },
  });
  find = new FindController(t, document.getElementById('find') as HTMLDivElement);

  post({ type: 'resize', cols: t.cols, rows: t.rows });
}

function linkModifierHeld(ev: MouseEvent): boolean {
  if (config?.linkModifier === 'alt') return ev.altKey;
  return config?.platform === 'mac' ? ev.metaKey : ev.ctrlKey;
}

/** Writes PTY output, recording prompt marks (OSC 133;A) at their exact line. */
function writeOutput(data: Uint8Array): void {
  const t = term;
  if (!t) return;
  for (const segment of marks.split(data)) {
    if (segment.bytes.length) t.write(segment.bytes);
    if (segment.markAfter) marks.record(t, segment.markAfter);
  }
  find?.invalidate();
  scheduleA11y();
}

function applyConfig(next: WebviewConfig): void {
  const prev = config;
  config = next;
  passThrough = new KeyMatcher(next.passThroughKeys);
  shellKeys = new KeyMatcher(next.shellKeys);
  if (!term || !prev) return;
  // Palette and scrollback live inside the WASM terminal: rebuild for those.
  const nextTheme = computeTheme();
  if (prev.scrollback !== next.scrollback || !sameTheme(theme, nextTheme)) {
    rebuild();
    return;
  }
  if (prev.fontFamily !== next.fontFamily || prev.fontSize !== next.fontSize) {
    const stack = next.fontFamily;
    void loadFonts(stack, next.fontSize).then(() => {
      if (!term || config !== next) return;
      term.options.fontFamily = stack;
      term.options.fontSize = next.fontSize;
      fit?.fit();
    });
  }
  if (prev.cursorStyle !== next.cursorStyle) term.options.cursorStyle = next.cursorStyle;
  if (prev.cursorBlink !== next.cursorBlink) term.options.cursorBlink = next.cursorBlink;
  fit?.fit();
}

/** Recreates the terminal and asks the host to replay the session into it. */
function rebuild(): void {
  if (!term) return;
  buildTerminal();
  if (!exited) post({ type: 'reattach' });
}

// Theme changes: VS Code updates the root style and body class.
let themeTimer: ReturnType<typeof setTimeout> | undefined;
const themeObserver = new MutationObserver(() => {
  clearTimeout(themeTimer);
  themeTimer = setTimeout(() => {
    if (term && !sameTheme(theme, computeTheme())) rebuild();
  }, 50);
});
themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

// ---- keyboard ------------------------------------------------------------

function sendToWorkbench(e: KeyboardEvent): boolean {
  toWorkbench.add(e);
  return true; // tells ghostty-web not to handle it
}

const isMac = () => config?.platform === 'mac';
const isWin = () => config?.platform === 'windows';
const key = (spec: string, e: KeyEventLike) => {
  const k = parseKey(spec);
  return !!k && matches(k, e);
};

function onKey(e: KeyboardEvent): boolean {
  if (e.type !== 'keydown' || !term) return false;
  const t = term;

  if (chordPending) {
    chordPending = false;
    return sendToWorkbench(e);
  }

  // Clipboard and terminal actions, with the built-in terminal's bindings.
  if (isMac() ? key('cmd+c', e) : key('ctrl+shift+c', e) || key('ctrl+insert', e) || (isWin() && key('ctrl+c', e) && t.hasSelection())) {
    if (t.hasSelection()) {
      post({ type: 'copy', text: t.getSelection() });
      if (!isMac()) t.clearSelection();
    }
    return true;
  }
  if (isMac() ? key('cmd+v', e) : key('ctrl+shift+v', e) || key('shift+insert', e) || (isWin() && key('ctrl+v', e))) {
    post({ type: 'paste', bracketed: t.hasBracketedPaste() });
    return true;
  }
  if (isMac() ? key('cmd+f', e) : key('ctrl+f', e) && !shellKeys.test(e)) {
    find?.open();
    return true;
  }
  if (isMac() && key('cmd+k', e)) {
    clearTerminal();
    return true;
  }
  if (isMac() ? key('cmd+a', e) : key('ctrl+shift+a', e)) {
    t.selectAll();
    return true;
  }
  if (isMac() ? key('cmd+up', e) : key('ctrl+up', e) && !shellKeys.test(e)) {
    scrollToCommand('previous');
    return true;
  }
  if (isMac() ? key('cmd+down', e) : key('ctrl+down', e) && !shellKeys.test(e)) {
    scrollToCommand('next');
    return true;
  }

  if (shellKeys.test(e)) return false;

  if (config?.allowChords && !config.sendKeybindingsToShell && (isMac() ? key('cmd+k', e) : key('ctrl+k', e))) {
    chordPending = true;
    return sendToWorkbench(e);
  }
  if (passThrough.test(e)) return sendToWorkbench(e);
  // On macOS, Cmd combinations belong to the app, not the shell.
  if (isMac() && e.metaKey) return sendToWorkbench(e);

  if (isMac() && config?.macOptionIsMeta && e.altKey && !e.ctrlKey && !e.metaKey) {
    const ch = metaChar(e);
    if (ch !== undefined) {
      post({ type: 'input', data: `\x1b${ch}` });
      return true;
    }
  }
  return false;
}

function metaChar(e: KeyboardEvent): string | undefined {
  if (/^Key[A-Z]$/.test(e.code)) {
    const c = e.code.slice(3);
    return e.shiftKey ? c : c.toLowerCase();
  }
  if (/^Digit[0-9]$/.test(e.code)) return e.code.slice(5);
  const map: Record<string, string> = { Period: '.', Comma: ',', Slash: '/', Backspace: '\x7f', Minus: '-', Equal: '=' };
  return map[e.code];
}

// Keys handled by the terminal stop here, so the workbench does not also act
// on them (VS Code's webview host forwards bubbling keydowns to the window).
document.addEventListener('keydown', (e) => {
  if (!container.contains(e.target as Node)) return;
  if (toWorkbench.has(e)) return;
  e.stopPropagation();
});

// ---- clipboard and mouse -------------------------------------------------

// Take paste events before ghostty-web, so pastes are bracketed and checked.
container.addEventListener(
  'paste',
  (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    const text = e.clipboardData?.getData('text/plain');
    if (text) post({ type: 'paste', text, bracketed: term?.hasBracketedPaste() ?? false });
  },
  { capture: true },
);

container.addEventListener('contextmenu', (e) => {
  const t = term;
  if (!t || !config) return;
  switch (config.rightClickBehavior) {
    case 'copyPaste':
      e.preventDefault();
      e.stopPropagation();
      if (t.hasSelection()) {
        post({ type: 'copy', text: t.getSelection() });
        t.clearSelection();
      } else {
        post({ type: 'paste', bracketed: t.hasBracketedPaste() });
      }
      break;
    case 'paste':
      e.preventDefault();
      e.stopPropagation();
      post({ type: 'paste', bracketed: t.hasBracketedPaste() });
      break;
    case 'nothing':
      e.preventDefault();
      e.stopPropagation();
      break;
    default:
      // 'default' and 'selectWord': VS Code shows the webview/context menu.
      break;
  }
});

window.addEventListener('focus', () => post({ type: 'focusChanged', focused: true }));
window.addEventListener('blur', () => post({ type: 'focusChanged', focused: false }));

// ---- actions -------------------------------------------------------------

function clearTerminal(): void {
  // Like the built-in: keep the prompt line, drop everything above it.
  term?.clear();
  marks.clear();
}

function scrollToCommand(direction: 'previous' | 'next'): void {
  if (term) marks.scroll(term, direction);
}

let audio: AudioContext | undefined;
function bell(): void {
  post({ type: 'bell' });
  if (!config?.enableBell) return;
  document.body.classList.add('bell');
  setTimeout(() => document.body.classList.remove('bell'), 150);
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    gain.gain.value = 0.05;
    osc.frequency.value = 880;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.08);
  } catch {
    /* audio unavailable */
  }
}

function visibleText(maxLines?: number): string {
  const t = term;
  if (!t) return '';
  const buf = t.buffer.active;
  const total = buf.length;
  const from = maxLines === undefined ? Math.max(0, total - t.rows) : Math.max(0, total - maxLines);
  const lines: string[] = [];
  for (let y = from; y < total; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? '');
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.join('\n');
}

let a11yTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleA11y(): void {
  if (!config?.accessibility || a11yTimer) return;
  a11yTimer = setTimeout(() => {
    a11yTimer = undefined;
    a11yEl.textContent = visibleText();
  }, 500);
}

// ---- messages from the host ---------------------------------------------

window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      void init(msg.config);
      break;
    case 'config':
      applyConfig(msg.config);
      break;
    case 'output': {
      writeOutput(msg.data);
      // Ack once parsed: parsing is the cost that backpressure must bound.
      post({ type: 'ack', bytes: msg.data.length });
      break;
    }
    case 'replay':
      term?.reset();
      marks.clear();
      if (msg.truncated) term?.write('\x1b[2m[earlier output not kept]\x1b[0m\r\n');
      writeOutput(msg.data);
      post({ type: 'ack', bytes: msg.data.length });
      break;
    case 'paste':
      term?.paste(preparePaste(msg.text));
      term?.focus();
      break;
    case 'focus':
      term?.focus();
      break;
    case 'clear':
      clearTerminal();
      break;
    case 'selectAll':
      term?.selectAll();
      break;
    case 'copySelection':
      if (term?.hasSelection()) post({ type: 'copy', text: term.getSelection() });
      break;
    case 'find':
      find?.open();
      break;
    case 'scrollToCommand':
      scrollToCommand(msg.direction);
      break;
    case 'notice':
      term?.write(`\x1b[2m──── ${msg.text} ────\x1b[0m\r\n`);
      break;
    case 'exit':
      exited = true;
      if (term) term.write(`\r\n\x1b[2m${msg.message}\x1b[0m\r\n`);
      else showNotice(msg.message);
      break;
    case 'requestRecentOutput':
      post({ type: 'recentOutput', text: visibleText(500) });
      break;
    case 'persist':
      vscode.setState(msg.state);
      break;
  }
});

async function init(cfg: WebviewConfig): Promise<void> {
  const firstInit = !config;
  config = cfg;
  passThrough = new KeyMatcher(cfg.passThroughKeys);
  shellKeys = new KeyMatcher(cfg.shellKeys);
  try {
    ghostty ??= await Ghostty.load(document.body.dataset.wasm);
  } catch (e) {
    showNotice(`Could not load the terminal engine: ${(e as Error).message}`);
    log('error', `wasm load failed: ${(e as Error).stack ?? e}`);
    return;
  }
  await loadFonts(cfg.fontFamily, cfg.fontSize);
  if (firstInit || !term) buildTerminal();
}

// Read-only hooks for the Playwright tests; only present when a test page asks.
if ((window as unknown as { __gtyEnableTestHooks?: boolean }).__gtyEnableTestHooks) {
  (window as unknown as { __gty: unknown }).__gty = {
    get term() {
      return term;
    },
    get marks() {
      return marks.all;
    },
    text: () => visibleText(),
  };
}

post({ type: 'ready' });
