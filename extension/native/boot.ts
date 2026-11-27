// What the native app (app/, Rust) tells its page at startup: set by an
// initialization script before any of our code runs (the system web view),
// or fetched from the server that served the page (browser mode).

export interface Boot {
  /** The bridge to the sidecar daemon: ws://127.0.0.1:<port>/... */
  ws: string;
  /** Which viewer shows the page. */
  mode: 'webview' | 'browser';
  version: string;
  os: 'linux' | 'mac' | 'windows';
  /** The same, as Node names it (for the shared environment and shell code). */
  nodePlatform: 'linux' | 'darwin' | 'win32';
  /** The app's environment, for the shell's. */
  env: Record<string, string>;
  home: string;
  /** The user's login shell. */
  shell: string;
  /** Where the app unpacked shell-integration/. */
  shellIntegrationDir: string;
  /** The settings file's contents: VS Code's keys, e.g. "terminal.integrated.fontSize". */
  settings: Record<string, unknown>;
  settingsFile: string;
}

/** Set by loadBoot(), before the host starts. */
export let boot: Boot;

/** In a web browser (browser mode): no window.ipc from the web view. */
export const inBrowser = !('ipc' in globalThis);

export async function loadBoot(): Promise<Boot> {
  const injected = (globalThis as unknown as { __GTY_BOOT__?: Boot }).__GTY_BOOT__;
  if (injected) {
    boot = { ...injected, mode: injected.mode ?? 'webview' };
    return boot;
  }
  // Browser mode: the server answers this only for its own page (the header
  // cannot be sent from another site without a preflight it refuses).
  const r = await fetch('/boot.json', { headers: { 'X-Gty': 'boot' }, cache: 'no-store' });
  if (!r.ok) throw new Error(`the terminal's server refused its start-up data (${r.status})`);
  boot = (await r.json()) as Boot;
  return boot;
}
