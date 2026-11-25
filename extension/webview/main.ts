// Webview side of a code-gty terminal: gty-term (our libghostty-vt terminal)
// plus the glue that makes it behave like VS Code's terminal. It never calls
// VS Code APIs; it only posts messages to the extension host.

import { KeyEventLike, KeyMatcher, matches, parseKey } from '../src/shared/keys';
import type { HostToWebview, PersistedState, WebviewConfig, WebviewToHost } from '../src/shared/messages';
import { Vt } from '../vt/core';
import { loadVt } from '../vt/loader';
import { GtyTerminal, TermOptions } from '../term/terminal';
import { hexToRgb, readTheme, sameTheme, Theme, themePalette } from '../term/theme';

interface VsCodeApi {
  postMessage(msg: WebviewToHost): void;
  getState(): PersistedState | undefined;
  setState(state: PersistedState): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const post = (m: WebviewToHost) => vscode.postMessage(m);
const container = document.getElementById('terminal') as HTMLDivElement;
const findEl = document.getElementById('find') as HTMLDivElement;
const noticeEl = document.getElementById('notice') as HTMLDivElement;
const a11yEl = document.getElementById('a11y') as HTMLDivElement;

let vt: Vt | undefined;
let term: GtyTerminal | undefined;
let config: WebviewConfig | undefined;
let theme: Theme | undefined;
let passThrough = new KeyMatcher([]);
let shellKeys = new KeyMatcher([]);
let fullScreenPassThrough = new KeyMatcher([]);
let chordPending = false;
let exited = false;
/** Events the workbench should see; everything else stops at the document. */
const toWorkbench = new WeakSet<Event>();

function log(level: 'info' | 'warn' | 'error', message: string): void {
  post({ type: 'log', level, message });
}

window.addEventListener('error', (e) => log('error', `${e.message} at ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => log('error', `unhandled rejection: ${String(e.reason)}`));

function showNotice(text: string): void {
  noticeEl.textContent = text;
  noticeEl.hidden = false;
}

// ---- configuration ------------------------------------------------------------

/** The cell is measured from the font, so the faces must load first. */
async function loadFonts(cfg: WebviewConfig): Promise<void> {
  if (!document.fonts) return;
  const styles = [`${cfg.fontWeight} `, `${cfg.fontWeightBold} `, `italic ${cfg.fontWeight} `, `italic ${cfg.fontWeightBold} `];
  const loads = styles.map((s) => document.fonts.load(`${s}${cfg.fontSize}px ${cfg.fontFamily}`, 'M'));
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3000));
  await Promise.race([Promise.allSettled(loads), timeout]);
}

function termOptions(cfg: WebviewConfig): TermOptions {
  return {
    fontFamily: cfg.fontFamily,
    fontSize: cfg.fontSize,
    lineHeight: cfg.lineHeight,
    letterSpacing: cfg.letterSpacing,
    fontWeight: cfg.fontWeight,
    fontWeightBold: cfg.fontWeightBold,
    cursorStyle: cfg.cursorStyle,
    cursorWidth: cfg.cursorWidth,
    cursorBlink: cfg.cursorBlink,
    drawBoldTextInBrightColors: cfg.drawBoldTextInBrightColors,
    minimumContrastRatio: cfg.minimumContrastRatio,
    customGlyphs: cfg.customGlyphs,
    scrollback: cfg.scrollback,
    wordSeparators: cfg.wordSeparators,
    macOptionIsMeta: cfg.macOptionIsMeta,
    isMac: cfg.platform === 'mac',
    kittyKeyboard: cfg.kittyKeyboard,
    images: cfg.images,
    padding: 0,
  };
}

function computeTheme(): Theme {
  return readTheme(getComputedStyle(document.documentElement), config?.colors ?? {});
}

function sendTheme(t: Theme): void {
  post({ type: 'theme', foreground: hexToRgb(t.foreground), background: hexToRgb(t.background), cursor: hexToRgb(t.cursor), palette: themePalette(t) });
}

function applyConfig(next: WebviewConfig): void {
  const prev = config;
  config = next;
  passThrough = new KeyMatcher(next.passThroughKeys);
  shellKeys = new KeyMatcher(next.shellKeys);
  fullScreenPassThrough = new KeyMatcher(next.fullScreenPassThroughKeys ?? []);
  if (!term || !prev) return;
  const nextTheme = computeTheme();
  if (!sameTheme(theme, nextTheme)) {
    theme = nextTheme;
    term.setTheme(nextTheme);
    sendTheme(nextTheme);
    document.body.style.backgroundColor = nextTheme.background;
  }
  const fontChanged = prev.fontFamily !== next.fontFamily || prev.fontSize !== next.fontSize || prev.fontWeight !== next.fontWeight || prev.fontWeightBold !== next.fontWeightBold;
  if (fontChanged) {
    void loadFonts(next).then(() => {
      if (term && config === next) term.setOptions(termOptions(next));
    });
  } else {
    term.setOptions(termOptions(next));
  }
}

// Theme changes: VS Code updates the root style and body class. Colours are
// set on both engines live, so nothing is rebuilt.
let themeTimer: ReturnType<typeof setTimeout> | undefined;
const themeObserver = new MutationObserver(() => {
  clearTimeout(themeTimer);
  themeTimer = setTimeout(() => {
    if (!term) return;
    const next = computeTheme();
    if (sameTheme(theme, next)) return;
    theme = next;
    term.setTheme(next);
    sendTheme(next);
    document.body.style.backgroundColor = next.background;
  }, 50);
});
themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

// ---- keyboard ---------------------------------------------------------------------

function sendToWorkbench(e: KeyboardEvent): boolean {
  toWorkbench.add(e);
  return true;
}

const isMac = () => config?.platform === 'mac';
const isWin = () => config?.platform === 'windows';
const key = (spec: string, e: KeyEventLike) => {
  const k = parseKey(spec);
  return !!k && matches(k, e);
};

/** Actions and pass-through rules. Returns true when the terminal must not encode the key. */
function keyFilter(e: KeyboardEvent): boolean {
  const t = term;
  if (!t) return true;
  const handled = () => {
    e.preventDefault();
    e.stopPropagation();
    return true;
  };
  // A full-screen program (Neovim, tmux, htop, less...) gets nearly every
  // key: Ctrl+P, Ctrl+F, Ctrl+K, Ctrl+Tab... mean something to it. Only the
  // Command Palette, F1, the user's own pass-through keys and the
  // Ctrl+Shift clipboard keys still reach VS Code.
  const fullScreen = !!config?.fullScreenPassThroughKeys && !!t.mirror?.altScreen;

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
    return handled();
  }
  if (isMac() ? key('cmd+v', e) : key('ctrl+shift+v', e) || key('shift+insert', e) || (isWin() && !fullScreen && key('ctrl+v', e))) {
    // The host reads the clipboard: a webview's own paste event is not
    // reliable for keyboard shortcuts in every VS Code host.
    post({ type: 'paste' });
    return handled();
  }
  if (shellKeys.test(e)) return false;

  if (fullScreen) {
    if (fullScreenPassThrough.test(e)) return sendToWorkbench(e);
    // On macOS, Cmd combinations belong to the app.
    if (isMac() && e.metaKey) return sendToWorkbench(e);
    return false;
  }

  if (isMac() ? key('cmd+f', e) : key('ctrl+f', e)) {
    t.find.open();
    return handled();
  }
  if (isMac() && key('cmd+k', e)) {
    post({ type: 'clear' });
    return handled();
  }
  if (isMac() ? key('cmd+a', e) : key('ctrl+shift+a', e)) {
    t.selectAll();
    return handled();
  }
  if (isMac() ? key('cmd+up', e) : key('ctrl+up', e)) {
    t.scrollToPrompt(-1);
    return handled();
  }
  if (isMac() ? key('cmd+down', e) : key('ctrl+down', e)) {
    t.scrollToPrompt(1);
    return handled();
  }
  if (key('shift+pageup', e)) {
    t.scrollLines(-t.mirror!.rows + 1);
    return handled();
  }
  if (key('shift+pagedown', e)) {
    t.scrollLines(t.mirror!.rows - 1);
    return handled();
  }

  if (config?.allowChords && !config.sendKeybindingsToShell && (isMac() ? key('cmd+k', e) : key('ctrl+k', e))) {
    chordPending = true;
    return sendToWorkbench(e);
  }
  if (passThrough.test(e)) return sendToWorkbench(e);
  // On macOS, Cmd combinations belong to the app, not the shell.
  if (isMac() && e.metaKey) return sendToWorkbench(e);
  return false;
}

// Keys handled by the terminal stop here, so the workbench does not also act
// on them (VS Code's webview host forwards bubbling keydowns to the window).
document.addEventListener('keydown', (e) => {
  if (!container.contains(e.target as Node)) return;
  if (toWorkbench.has(e)) return;
  e.stopPropagation();
});

// ---- clipboard and mouse -------------------------------------------------------

container.addEventListener(
  'paste',
  (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    const text = e.clipboardData?.getData('text/plain');
    post(text ? { type: 'paste', text } : { type: 'paste' });
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
        post({ type: 'paste' });
      }
      break;
    case 'paste':
      e.preventDefault();
      e.stopPropagation();
      post({ type: 'paste' });
      break;
    case 'nothing':
      e.preventDefault();
      e.stopPropagation();
      break;
    case 'selectWord': {
      // Select the word under the pointer, then let VS Code show the menu.
      const c = t.cellAt(e);
      if (!t.hasSelection()) t.selectWordAt(c.x, c.y);
      break;
    }
    default:
      break;
  }
});

window.addEventListener('focus', () => post({ type: 'focusChanged', focused: true }));
window.addEventListener('blur', () => post({ type: 'focusChanged', focused: false }));

// ---- bell and accessibility -------------------------------------------------------

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

let a11yTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleA11y(): void {
  if (!config?.accessibility || a11yTimer) return;
  a11yTimer = setTimeout(() => {
    a11yTimer = undefined;
    if (term) a11yEl.textContent = term.visibleText();
  }, 500);
}

function linkModifierHeld(ev: MouseEvent): boolean {
  if (config?.linkModifier === 'alt') return ev.altKey;
  return config?.platform === 'mac' ? ev.metaKey : ev.ctrlKey;
}

// ---- terminal lifecycle --------------------------------------------------------

async function init(cfg: WebviewConfig): Promise<void> {
  config = cfg;
  passThrough = new KeyMatcher(cfg.passThroughKeys);
  shellKeys = new KeyMatcher(cfg.shellKeys);
  fullScreenPassThrough = new KeyMatcher(cfg.fullScreenPassThroughKeys ?? []);
  if (term) return;
  try {
    if (!vt) {
      const res = await fetch(document.body.dataset.wasm!);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      vt = await loadVt(await res.arrayBuffer(), { log: (l) => log('info', `vt: ${l}`) });
      log('info', `libghostty-vt ${vt.version} ${JSON.stringify(vt.features)}`);
    }
  } catch (e) {
    showNotice(`Could not load the terminal engine: ${(e as Error).message}`);
    log('error', `wasm load failed: ${(e as Error).stack ?? e}`);
    return;
  }
  await loadFonts(cfg);
  theme = computeTheme();
  document.body.style.backgroundColor = theme.background;
  term = new GtyTerminal(vt, container, findEl, termOptions(cfg), theme, {
    input: (data, binary) => post({ type: 'input', data, binary }),
    requestResize: (cols, rows, cellWidth, cellHeight) => post({ type: 'resize', cols, rows, cellWidth, cellHeight }),
    bell,
    selectionChanged: (text) => {
      if (config?.copyOnSelection && text) post({ type: 'copy', text });
    },
    openLink: (kind, text) => post({ type: 'openLink', kind, text }),
    keyFilter,
    linkModifierHeld,
    log,
    outputProcessed: scheduleA11y,
  });
  sendTheme(theme);
  term.fit();
}

/** Messages wait for init (WASM and fonts) so output is never applied out of order. */
let chain: Promise<void> = Promise.resolve();
function enqueue(fn: () => void | Promise<void>): void {
  chain = chain.then(fn).catch((e) => log('error', `message handling: ${(e as Error).stack ?? e}`));
}

window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
  const msg = event.data;
  if (msg.type === 'init') return enqueue(() => init(msg.config));
  enqueue(() => handle(msg));
});

function handle(msg: HostToWebview): void {
  switch (msg.type) {
    case 'config':
      applyConfig(msg.config);
      break;
    case 'attach':
      term?.attach(msg.snapshot, msg.cols, msg.rows);
      term?.fit();
      break;
    case 'output':
      term?.write(msg.data);
      // Ack once parsed: parsing is the cost that backpressure must bound.
      if (msg.ack !== false) post({ type: 'ack', bytes: msg.data.length });
      break;
    case 'resized':
      term?.applyResize(msg.cols, msg.rows);
      break;
    case 'focus':
      term?.focus();
      break;
    case 'selectAll':
      term?.selectAll();
      break;
    case 'copySelection':
      if (term?.hasSelection()) post({ type: 'copy', text: term.getSelection() });
      break;
    case 'find':
      term?.find.open();
      break;
    case 'scrollToCommand':
      term?.scrollToPrompt(msg.direction === 'previous' ? -1 : 1);
      break;
    case 'exit':
      exited = true;
      if (!term?.mirror) showNotice(msg.message);
      break;
    case 'persist':
      vscode.setState(msg.state);
      break;
  }
}

// Read-only hooks for the Playwright tests; only present when a test page asks.
if ((window as unknown as { __gtyEnableTestHooks?: boolean }).__gtyEnableTestHooks) {
  (window as unknown as { __gty: unknown }).__gty = {
    get term() {
      return term;
    },
    get exited() {
      return exited;
    },
    text: () => term?.visibleText() ?? '',
    selection: () => term?.getSelection() ?? '',
  };
}

post({ type: 'ready' });
