// Reads terminal.integrated.* and codeGty.* settings and turns them into the
// webview config, the shell launch and the environment.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { buildEnvironment, EnvMap, EnvPatch } from './env';
import { osKey, ProfileConfig, resolveShell, ShellLaunch } from './profiles';
import { defaultPassThrough, fullScreenPassThrough, Platform } from './shared/keys';
import { WebviewConfig } from './shared/messages';
import { injectShellIntegration } from './shellIntegration';

export function platformName(): Platform {
  return process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux';
}

function term(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('terminal.integrated');
}
function gty(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('codeGty');
}

/** Bundled in media/fonts and declared in media/webview.css. Keep in sync with package.json. */
export const BUNDLED_FONT = "'IosevkaTerm Nerd Font Mono', monospace";

export function webviewConfig(): WebviewConfig {
  const t = term();
  const g = gty();
  const editor = vscode.workspace.getConfiguration('editor');
  const platform = platformName();
  const sendKeys = t.get<boolean>('sendKeybindingsToShell', false);
  const cursor = t.get<string>('cursorStyle', 'block');
  // A blank codeGty.fontFamily (what clearing the field in the Settings UI
  // leaves behind) means the bundled default; only null follows VS Code's font.
  const gtyFont = g.get<string | null>('fontFamily');
  const fontFamily =
    gtyFont === null
      ? t.get<string>('fontFamily') || editor.get<string>('fontFamily') || BUNDLED_FONT
      : gtyFont?.trim() || BUNDLED_FONT;
  const rightClickDefault = platform === 'windows' ? 'copyPaste' : platform === 'mac' ? 'selectWord' : 'default';
  const weight = (v: unknown, fallback: string) => (typeof v === 'number' ? String(v) : typeof v === 'string' && /^(normal|bold|[1-9]00)$/.test(v) ? v : fallback);
  return {
    fontFamily,
    fontSize: g.get<number | null>('fontSize') || t.get<number>('fontSize') || editor.get<number>('fontSize') || 14,
    lineHeight: clamp(t.get<number>('lineHeight', 1), 1, 3),
    letterSpacing: clamp(t.get<number>('letterSpacing', 0), -5, 20),
    fontWeight: weight(t.get('fontWeight'), 'normal'),
    fontWeightBold: weight(t.get('fontWeightBold'), 'bold'),
    cursorStyle: cursor === 'line' ? 'bar' : cursor === 'underline' ? 'underline' : 'block',
    cursorBlink: t.get<boolean>('cursorBlinking', false),
    cursorWidth: clamp(t.get<number>('cursorWidth', 1), 1, 10),
    scrollback: clamp(t.get<number>('scrollback', 1000), 0, 1_000_000),
    drawBoldTextInBrightColors: t.get<boolean>('drawBoldTextInBrightColors', true),
    minimumContrastRatio: clamp(t.get<number>('minimumContrastRatio', 4.5), 1, 21),
    customGlyphs: t.get<boolean>('customGlyphs', true),
    wordSeparators: t.get<string>('wordSeparators', ' ()[]{}\',"`─‘’“”|'),
    kittyKeyboard: g.get<boolean>('kittyKeyboard', true),
    images: g.get<boolean>('images', true),
    copyOnSelection: t.get<boolean>('copyOnSelection', false),
    rightClickBehavior: (t.get<string>('rightClickBehavior') ?? rightClickDefault) as WebviewConfig['rightClickBehavior'],
    macOptionIsMeta: t.get<boolean>('macOptionIsMeta', false),
    enableBell: t.get<boolean>('enableBell', false) || t.get<boolean>('enableVisualBell', false),
    passThroughKeys: [...defaultPassThrough(platform, sendKeys), ...g.get<string[]>('passThroughKeys', [])],
    fullScreenPassThroughKeys: g.get<boolean>('keysToFullScreenPrograms', true)
      ? [...fullScreenPassThrough(platform), ...g.get<string[]>('passThroughKeys', [])]
      : undefined,
    shellKeys: g.get<string[]>('shellKeys', []),
    sendKeybindingsToShell: sendKeys,
    allowChords: t.get<boolean>('allowChords', true),
    linkModifier: editor.get<string>('multiCursorModifier') === 'ctrlCmd' ? 'alt' : 'ctrlCmd',
    colors: g.get<Record<string, string>>('colors', {}),
    platform,
    accessibility: editor.get<string>('accessibilitySupport') === 'on',
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}

/** Settings that require the webview to rebuild or reconfigure. */
export function affectsWebview(e: vscode.ConfigurationChangeEvent): boolean {
  return (
    e.affectsConfiguration('terminal.integrated') ||
    e.affectsConfiguration('codeGty') ||
    e.affectsConfiguration('editor.fontFamily') ||
    e.affectsConfiguration('editor.fontSize') ||
    e.affectsConfiguration('editor.multiCursorModifier') ||
    e.affectsConfiguration('editor.accessibilitySupport')
  );
}

export interface LaunchPlan {
  shell: ShellLaunch;
  env: EnvMap;
  cwd: string;
  shellIntegration: boolean;
}

function exists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function loginShell(): string | undefined {
  try {
    return os.userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
}

export function workspaceFolderPath(): string | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  const folder = (active && vscode.workspace.getWorkspaceFolder(active)) ?? vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.scheme === 'file' ? folder.uri.fsPath : undefined;
}

export function planLaunch(extensionPath: string, requestedCwd?: string, overrides?: { shellPath?: string; shellArgs?: string[]; env?: EnvPatch }): LaunchPlan {
  const t = term();
  const key = osKey(process.platform);
  const ws = workspaceFolderPath();
  const home = os.homedir();

  let shell: ShellLaunch;
  if (overrides?.shellPath) {
    shell = { name: path.basename(overrides.shellPath), command: overrides.shellPath, args: overrides.shellArgs ?? [], env: {} };
  } else {
    shell = resolveShell({
      platform: process.platform,
      defaultProfile: t.get<string | null>(`defaultProfile.${key}`),
      profiles: t.get<Record<string, ProfileConfig | null>>(`profiles.${key}`),
      legacyShell: t.get<string>(`shell.${key}`) || undefined,
      legacyArgs: t.get<string[] | string>(`shellArgs.${key}`),
      env: process.env,
      loginShell: loginShell(),
      exists,
    });
  }

  // cwd: explicit request, then terminal.integrated.cwd, then the workspace, then home.
  const vars = { workspaceFolder: ws, userHome: home, pathSeparator: path.sep };
  const configured = t.get<string>('cwd');
  const candidates = [
    requestedCwd,
    configured ? resolveCwd(configured.replace('${workspaceFolder}', ws ?? ''), ws) : undefined,
    ws,
    home,
  ];
  const cwd = candidates.find((c): c is string => !!c && isDir(c)) ?? home;

  const env = buildEnvironment({
    hostEnv: process.env,
    platform: process.platform,
    inheritEnv: t.get<boolean>('inheritEnv', true),
    term: gty().get<string>('term', 'xterm-256color'),
    vscodeVersion: vscode.version,
    detectLocale: t.get<string>('detectLocale', 'auto'),
    uiLanguage: vscode.env.language,
    patches: [t.get<EnvPatch>(`env.${key}`) ?? {}, gty().get<EnvPatch>('env') ?? {}, shell.env, overrides?.env ?? {}],
    vars: { ...vars, cwd },
  });

  let shellIntegration = false;
  if (t.get<boolean>('shellIntegration.enabled', true) && !overrides?.shellPath) {
    const inj = injectShellIntegration(shell.command, shell.args, path.join(extensionPath, 'shell-integration'), env, process.platform);
    if (inj) {
      shell = { ...shell, args: inj.args };
      Object.assign(env, inj.env);
      shellIntegration = true;
    }
  }

  return { shell, env, cwd, shellIntegration };
}

function resolveCwd(p: string, ws: string | undefined): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  if (path.isAbsolute(p)) return p;
  return ws ? path.join(ws, p) : p;
}
