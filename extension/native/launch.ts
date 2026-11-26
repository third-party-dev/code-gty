// The shell for a new session: the user's login shell, with the same
// environment rules and shell integration as the extension (src/env.ts,
// src/shellIntegration.ts). Profiles (terminal.integrated.profiles.*) are not
// read yet: picking one needs to look for executables on disk.

import type { LaunchPlan } from '../src/core/platform';
import type { CreateOptions } from '../src/core/session';
import { buildEnvironment, EnvPatch } from '../src/env';
import { injectShellIntegration } from '../src/shellIntegration';
import type { Boot } from './boot';

export function planLaunch(boot: Boot, cwd: string | undefined, opts: CreateOptions): LaunchPlan {
  const s = (key: string) => boot.settings[key];
  const osKey = boot.os === 'mac' ? 'osx' : boot.os;
  let shell = { command: opts.shellPath ?? boot.shell, args: opts.shellArgs ?? [] };
  const dir = cwd || boot.home;
  const env = buildEnvironment({
    hostEnv: boot.env,
    platform: boot.nodePlatform,
    inheritEnv: (s('terminal.integrated.inheritEnv') as boolean | undefined) ?? true,
    term: (s('codeGty.term') as string | undefined) ?? 'xterm-256color',
    vscodeVersion: boot.version,
    detectLocale: (s('terminal.integrated.detectLocale') as string | undefined) ?? 'auto',
    uiLanguage: navigator.language.split('-')[0] || 'en',
    patches: [(s(`terminal.integrated.env.${osKey}`) as EnvPatch | undefined) ?? {}, (s('codeGty.env') as EnvPatch | undefined) ?? {}, opts.env ?? {}],
    vars: { workspaceFolder: undefined, userHome: boot.home, pathSeparator: boot.os === 'windows' ? '\\' : '/', cwd: dir },
  });
  // Not VS Code: programs that check TERM_PROGRAM (the `code` CLI, say) must not think so.
  env.TERM_PROGRAM = 'code-gty';
  env.TERM_PROGRAM_VERSION = boot.version;
  let shellIntegration = false;
  if (((s('terminal.integrated.shellIntegration.enabled') as boolean | undefined) ?? true) && !opts.shellPath) {
    const inj = injectShellIntegration(shell.command, shell.args, boot.shellIntegrationDir, env, boot.nodePlatform);
    if (inj) {
      shell = { ...shell, args: inj.args };
      Object.assign(env, inj.env);
      shellIntegration = true;
    }
  }
  return { shell, env, cwd: dir, shellIntegration };
}
