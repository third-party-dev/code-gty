// Injects the shell-integration scripts in shell-integration/ through each
// shell's normal startup hooks. The scripts emit OSC 133 (prompt and command
// marks) and OSC 7 (cwd). Pure, so it can be unit tested.

import * as path from 'node:path';

export interface Injection {
  args: string[];
  env: Record<string, string>;
}

export type ShellKind = 'bash' | 'zsh' | 'fish' | 'pwsh' | undefined;

export function shellKind(command: string): ShellKind {
  const base = (command.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '');
  if (base === 'bash') return 'bash';
  if (base === 'zsh') return 'zsh';
  if (base === 'fish') return 'fish';
  if (base === 'pwsh' || base === 'powershell') return 'pwsh';
  return undefined;
}

const LOGIN = new Set(['-l', '--login']);
const BASH_OK = new Set(['-l', '--login', '-i']);
const PWSH_OK = new Set(['-l', '-login', '-nologo', '-noprofile']);

/**
 * Returns the changed args and extra env, or undefined when the shell or its
 * arguments are not ones we can safely wrap (the built-in terminal is just as
 * conservative).
 */
export function injectShellIntegration(
  command: string,
  args: string[],
  scriptsDir: string,
  env: Record<string, string>,
  platform: NodeJS.Platform,
): Injection | undefined {
  const kind = shellKind(command);
  const p = platform === 'win32' ? path.win32 : path.posix;
  switch (kind) {
    case 'bash': {
      if (platform === 'win32') return undefined; // Git Bash path handling differs; not yet.
      if (!args.every((a) => BASH_OK.has(a))) return undefined;
      const login = args.some((a) => LOGIN.has(a));
      return {
        args: ['--init-file', p.join(scriptsDir, 'bash', 'gty.bash')],
        env: { GTY_SHELL_INTEGRATION: '1', ...(login ? { GTY_BASH_LOGIN: '1' } : {}) },
      };
    }
    case 'zsh': {
      if (!args.every((a) => a === '-l' || a === '--login' || a === '-i')) return undefined;
      const userZdotdir = env.ZDOTDIR ?? env.HOME ?? '';
      return {
        args: args.includes('-i') ? args : [...args, '-i'],
        env: { GTY_SHELL_INTEGRATION: '1', ZDOTDIR: p.join(scriptsDir, 'zsh'), GTY_USER_ZDOTDIR: userZdotdir },
      };
    }
    case 'fish':
      return {
        args: [...args, '--init-command', `source ${quoteFish(p.join(scriptsDir, 'fish', 'gty.fish'))}`],
        env: { GTY_SHELL_INTEGRATION: '1' },
      };
    case 'pwsh': {
      if (!args.every((a) => PWSH_OK.has(a.toLowerCase()))) return undefined;
      const script = p.join(scriptsDir, 'pwsh', 'gty.ps1');
      const kept = args.filter((a) => a.toLowerCase() !== '-l' && a.toLowerCase() !== '-login');
      const loginArg = args.some((a) => ['-l', '-login'].includes(a.toLowerCase())) && command.toLowerCase().includes('pwsh') ? ['-Login'] : [];
      return {
        args: [...loginArg, ...kept, '-NoExit', '-Command', `. '${script.replace(/'/g, "''")}'`],
        env: { GTY_SHELL_INTEGRATION: '1' },
      };
    }
    default:
      return undefined;
  }
}

function quoteFish(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
