// The terminal page's configuration from settings, shared by the VS Code
// extension (its configuration) and the native app (a settings file with the
// same keys), so the same settings mean the same thing in both.

import { defaultPassThrough, fullScreenPassThrough, Platform } from '../shared/keys';
import type { WebviewConfig } from '../shared/messages';

/** Bundled in media/fonts and declared in media/webview.css. Keep in sync with package.json. */
export const BUNDLED_FONT = "'IosevkaTerm Nerd Font Mono', monospace";

export type SettingsSection = 'terminal.integrated' | 'codeGty' | 'editor';

/** A setting's value, or undefined when not set (and without a default of its own). */
export type SettingsReader = (section: SettingsSection, key: string) => unknown;

export function buildWebviewConfig(read: SettingsReader, platform: Platform): WebviewConfig {
  const reader = (section: SettingsSection) => ({
    get: <T>(key: string, fallback?: T): T => (read(section, key) ?? fallback) as T,
  });
  const t = reader('terminal.integrated');
  const g = reader('codeGty');
  const editor = reader('editor');
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

