// What the native app (app/, Rust) tells its page at startup, set by an
// initialization script before any of our code runs.

export interface Boot {
  /** The bridge to the sidecar daemon: ws://127.0.0.1:<port>/?token=... */
  ws: string;
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

export const boot: Boot = (globalThis as unknown as { __GTY_BOOT__: Boot }).__GTY_BOOT__;
