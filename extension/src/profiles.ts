// Shell selection from terminal.integrated.defaultProfile / profiles, with
// the same fallbacks the built-in terminal uses. Pure: filesystem access is
// injected so it is testable.

import * as path from 'node:path';

export type OsKey = 'linux' | 'osx' | 'windows';

export interface ProfileConfig {
  path?: string | string[];
  source?: string;
  args?: string[] | string;
  env?: Record<string, string | null>;
  overrideName?: boolean;
}

export interface ShellLaunch {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string | null>;
}

export interface ProfileInput {
  platform: NodeJS.Platform;
  defaultProfile: string | null | undefined;
  profiles: Record<string, ProfileConfig | null> | undefined;
  /** Deprecated terminal.integrated.shell.<os> / shellArgs.<os>, still honoured. */
  legacyShell?: string;
  legacyArgs?: string[] | string;
  env: Record<string, string | undefined>;
  loginShell?: string;
  exists: (p: string) => boolean;
}

export function osKey(platform: NodeJS.Platform): OsKey {
  return platform === 'win32' ? 'windows' : platform === 'darwin' ? 'osx' : 'linux';
}

/** Built-in profile definitions, used when the user names one without a path. */
function builtinProfiles(input: ProfileInput): Record<string, ProfileConfig> {
  if (input.platform === 'win32') {
    const sys = input.env.SystemRoot ?? input.env.windir ?? 'C:\\Windows';
    const pf = input.env.ProgramFiles ?? 'C:\\Program Files';
    return {
      PowerShell: { source: 'PowerShell' },
      'Command Prompt': { path: [path.win32.join(sys, 'System32', 'cmd.exe')] },
      'Git Bash': { source: 'Git Bash' },
      'Windows PowerShell': { path: [path.win32.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')] },
      pwsh: { path: [path.win32.join(pf, 'PowerShell', '7', 'pwsh.exe')] },
      cmd: { path: [path.win32.join(sys, 'System32', 'cmd.exe')] },
    };
  }
  const login = input.platform === 'darwin' ? ['-l'] : [];
  return {
    bash: { path: 'bash', args: login },
    zsh: { path: 'zsh', args: login },
    fish: { path: 'fish', args: login },
    sh: { path: 'sh' },
    tmux: { path: 'tmux' },
    pwsh: { path: 'pwsh' },
  };
}

function sourcePaths(source: string, input: ProfileInput): string[] {
  const sys = input.env.SystemRoot ?? 'C:\\Windows';
  const pf = input.env.ProgramFiles ?? 'C:\\Program Files';
  const pf86 = input.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const local = input.env.LOCALAPPDATA ?? '';
  if (source === 'PowerShell') {
    return [
      path.win32.join(pf, 'PowerShell', '7', 'pwsh.exe'),
      local && path.win32.join(local, 'Microsoft', 'WindowsApps', 'pwsh.exe'),
      path.win32.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ].filter(Boolean) as string[];
  }
  if (source === 'Git Bash') {
    return [
      path.win32.join(pf, 'Git', 'bin', 'bash.exe'),
      path.win32.join(pf86, 'Git', 'bin', 'bash.exe'),
      local && path.win32.join(local, 'Programs', 'Git', 'bin', 'bash.exe'),
    ].filter(Boolean) as string[];
  }
  return [];
}

/** Finds an executable: absolute paths are checked directly, bare names on PATH. */
export function findExecutable(name: string, input: ProfileInput): string | undefined {
  const win = input.platform === 'win32';
  const p = win ? path.win32 : path.posix;
  if (p.isAbsolute(name)) return input.exists(name) ? name : undefined;
  if (name.includes('/') || (win && name.includes('\\'))) return undefined;
  const pathVar = (win ? input.env.Path ?? input.env.PATH : input.env.PATH) ?? '';
  const exts = win ? (input.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  for (const dir of pathVar.split(win ? ';' : ':')) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = p.join(dir, name.toLowerCase().endsWith(ext.toLowerCase()) ? name : name + ext);
      if (input.exists(candidate)) return candidate;
    }
  }
  return undefined;
}

function toArgs(a: string[] | string | undefined): string[] | undefined {
  if (a === undefined) return undefined;
  if (Array.isArray(a)) return a;
  // A single string is split like the built-in does for shellArgs on Windows.
  return a.split(' ').filter(Boolean);
}

function fromProfile(name: string, prof: ProfileConfig, input: ProfileInput): ShellLaunch | undefined {
  const candidates = prof.path !== undefined ? (Array.isArray(prof.path) ? prof.path : [prof.path]) : prof.source ? sourcePaths(prof.source, input) : [];
  for (const c of candidates) {
    const found = findExecutable(c, input);
    if (found) {
      return { name, command: found, args: toArgs(prof.args) ?? [], env: prof.env ?? {} };
    }
  }
  return undefined;
}

export function resolveShell(input: ProfileInput): ShellLaunch {
  const builtins = builtinProfiles(input);
  const profiles: Record<string, ProfileConfig | null> = { ...builtins, ...(input.profiles ?? {}) };

  if (input.legacyShell) {
    const found = findExecutable(input.legacyShell, input) ?? input.legacyShell;
    return { name: displayName(found), command: found, args: toArgs(input.legacyArgs) ?? defaultArgs(input), env: {} };
  }

  const wanted = input.defaultProfile ?? undefined;
  if (wanted) {
    const prof = profiles[wanted];
    if (prof) {
      const launch = fromProfile(wanted, { ...builtins[wanted], ...prof }, input);
      if (launch) return launch;
    }
  }

  if (input.platform === 'win32') {
    for (const name of ['PowerShell', 'Command Prompt']) {
      const launch = fromProfile(name, profiles[name] ?? builtins[name], input);
      if (launch) return launch;
    }
    const comspec = input.env.ComSpec ?? 'cmd.exe';
    return { name: 'cmd', command: comspec, args: [], env: {} };
  }

  const shell = input.env.SHELL || input.loginShell || '/bin/sh';
  const prof = profiles[displayName(shell)];
  return {
    name: displayName(shell),
    command: shell,
    args: toArgs(prof?.args) ?? defaultArgs(input),
    env: prof?.env ?? {},
  };
}

/** macOS terminals start login shells, as Terminal.app and VS Code do. */
function defaultArgs(input: ProfileInput): string[] {
  return input.platform === 'darwin' ? ['-l'] : [];
}

export function displayName(command: string): string {
  const base = command.split(/[\\/]/).pop() ?? command;
  return base.replace(/\.exe$/i, '');
}
