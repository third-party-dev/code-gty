// Builds the shell environment the way the built-in terminal does, as far as
// the public API allows. Pure functions; the vscode-specific inputs are
// gathered in terminalConfig.ts.

export type EnvMap = Record<string, string>;
export type EnvPatch = Record<string, string | null | undefined>;
/** The host's environment (process.env, or what the native app passes its page). */
export type HostEnv = Record<string, string | undefined>;

export interface VariableContext {
  workspaceFolder?: string;
  userHome: string;
  cwd?: string;
  pathSeparator: string;
  env: EnvMap;
  /** Windows: variable names are case-insensitive. */
  win?: boolean;
}

/**
 * Resolves `${env:X}`, `${workspaceFolder}`, `${workspaceFolderBasename}`,
 * `${userHome}`, `${cwd}` and `${pathSeparator}`. Unknown variables are left
 * as they are, like VS Code does.
 */
export function resolveVariables(value: string, ctx: VariableContext): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, name: string) => {
    if (name.startsWith('env:')) return lookup(ctx.env, name.slice(4), ctx.win ?? false) ?? '';
    switch (name) {
      case 'workspaceFolder':
        return ctx.workspaceFolder ?? match;
      case 'workspaceFolderBasename':
        return ctx.workspaceFolder ? basename(ctx.workspaceFolder) : match;
      case 'userHome':
        return ctx.userHome;
      case 'cwd':
        return ctx.cwd ?? match;
      case 'pathSeparator':
      case '/':
        return ctx.pathSeparator;
      default:
        return match;
    }
  });
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Variables the extension host carries that must not leak into a shell. */
const STRIP_EXACT = new Set([
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ELECTRON_ENABLE_STACK_DUMPING',
  'ELECTRON_ENABLE_LOGGING',
  'APPLICATION_INSIGHTS_NO_DIAGNOSTIC_CHANNEL',
  'GOOGLE_API_KEY',
  'CHROME_CRASHPAD_PIPE_NAME',
]);
/** VSCODE_* variables that terminals do get: the CLI hook and git helpers. */
const KEEP_VSCODE = [/^VSCODE_IPC_HOOK_CLI$/, /^VSCODE_GIT_/, /^VSCODE_SHELL_LOGIN$/];

export function sanitizeHostEnv(env: HostEnv): EnvMap {
  const out: EnvMap = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (STRIP_EXACT.has(k)) continue;
    if (k.startsWith('VSCODE_') && !KEEP_VSCODE.some((re) => re.test(k))) continue;
    out[k] = v;
  }
  return out;
}

export interface EnvInput {
  hostEnv: HostEnv;
  /** As Node names it: 'linux', 'darwin', 'win32', ... */
  platform: string;
  /** terminal.integrated.inheritEnv (only meaningful on macOS and Linux). */
  inheritEnv: boolean;
  term: string;
  vscodeVersion: string;
  /** terminal.integrated.detectLocale: 'auto' | 'off' | 'on'. */
  detectLocale: string;
  /** vscode.env.language, e.g. "en" or "de". */
  uiLanguage: string;
  /** Applied in order: terminal.integrated.env.<os>, codeGty.env, profile env. */
  patches: EnvPatch[];
  vars: Omit<VariableContext, 'env'>;
}

/** Minimal set kept when inheritEnv is false. */
const MINIMAL_KEYS = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'TMPDIR', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'SSH_AUTH_SOCK', 'VSCODE_IPC_HOOK_CLI'];

export function buildEnvironment(input: EnvInput): EnvMap {
  const win = input.platform === 'win32';
  const sanitized = sanitizeHostEnv(input.hostEnv);
  let env: EnvMap;
  if (!win && !input.inheritEnv) {
    env = {};
    for (const k of MINIMAL_KEYS) if (sanitized[k] !== undefined) env[k] = sanitized[k];
  } else {
    env = sanitized;
  }

  set(env, 'TERM', input.term, win);
  set(env, 'COLORTERM', 'truecolor', win);
  set(env, 'TERM_PROGRAM', 'vscode', win);
  set(env, 'TERM_PROGRAM_VERSION', input.vscodeVersion, win);
  set(env, 'CODE_GTY', '1', win);

  if (!win && shouldSetLocale(env, input.detectLocale)) {
    set(env, 'LANG', localeFor(input.uiLanguage), win);
  }

  for (const patch of input.patches) applyPatch(env, patch, input.vars, win);
  return env;
}

function shouldSetLocale(env: EnvMap, mode: string): boolean {
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  return !env.LANG && !env.LC_ALL && !env.LC_CTYPE;
}

/** Mirrors the built-in terminal: "en" -> "en_US.UTF-8", "de" -> "de_DE.UTF-8". */
export function localeFor(language: string): string {
  const [lang, region] = language.split(/[-_]/);
  const l = (lang || 'en').toLowerCase();
  const r = region ? region.toUpperCase() : l === 'en' ? 'US' : l.toUpperCase();
  return `${l}_${r}.UTF-8`;
}

export function applyPatch(env: EnvMap, patch: EnvPatch, vars: Omit<VariableContext, 'env'>, win: boolean): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      remove(env, k, win);
    } else if (typeof v === 'string') {
      // Resolve against the env as it stands, so PATH: "${env:PATH}:/x" works.
      set(env, k, resolveVariables(v, { ...vars, env, win }), win);
    }
  }
}

/** Windows variable names are case-insensitive; keep the existing spelling. */
function keyFor(env: EnvMap, key: string, win: boolean): string {
  if (!win) return key;
  const lower = key.toLowerCase();
  return Object.keys(env).find((k) => k.toLowerCase() === lower) ?? key;
}

function lookup(env: EnvMap, key: string, win: boolean): string | undefined {
  const exact = env[key];
  if (exact !== undefined || !win) return exact;
  const lower = key.toLowerCase();
  const k = Object.keys(env).find((x) => x.toLowerCase() === lower);
  return k === undefined ? undefined : env[k];
}

export function set(env: EnvMap, key: string, value: string, win: boolean): void {
  env[keyFor(env, key, win)] = value;
}

function remove(env: EnvMap, key: string, win: boolean): void {
  delete env[keyFor(env, key, win)];
}
