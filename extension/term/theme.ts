// Maps VS Code's terminal colour tokens (exposed to webviews as --vscode-*
// CSS variables) onto a terminal theme.

export interface Theme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground?: string;
  findMatchBackground?: string;
  findMatchHighlightBackground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}
type ITheme = Theme;

/** The 16 ANSI colours in palette order. */
export const ANSI_KEYS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const;

const ANSI: [keyof ITheme, string][] = [
  ['black', 'ansiBlack'],
  ['red', 'ansiRed'],
  ['green', 'ansiGreen'],
  ['yellow', 'ansiYellow'],
  ['blue', 'ansiBlue'],
  ['magenta', 'ansiMagenta'],
  ['cyan', 'ansiCyan'],
  ['white', 'ansiWhite'],
  ['brightBlack', 'ansiBrightBlack'],
  ['brightRed', 'ansiBrightRed'],
  ['brightGreen', 'ansiBrightGreen'],
  ['brightYellow', 'ansiBrightYellow'],
  ['brightBlue', 'ansiBrightBlue'],
  ['brightMagenta', 'ansiBrightMagenta'],
  ['brightCyan', 'ansiBrightCyan'],
  ['brightWhite', 'ansiBrightWhite'],
];

/** VS Code's default dark terminal palette, used when a token is missing. */
const FALLBACK: Required<Pick<ITheme, 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white' | 'brightBlack' | 'brightRed' | 'brightGreen' | 'brightYellow' | 'brightBlue' | 'brightMagenta' | 'brightCyan' | 'brightWhite'>> = {
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#e5e5e5',
};

/** Accepts #rgb, #rrggbb, #rrggbbaa and rgb()/rgba(); returns #rrggbb (alpha blended onto `under`). */
export function normalizeColor(value: string | undefined, under = '#000000'): string | undefined {
  if (!value) return undefined;
  const v = value.trim();
  let r: number, g: number, b: number, a = 1;
  let m: RegExpExecArray | null;
  if ((m = /^#([0-9a-f]{3})$/i.exec(v))) {
    [r, g, b] = m[1].split('').map((c) => parseInt(c + c, 16));
  } else if ((m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(v))) {
    r = parseInt(m[1].slice(0, 2), 16);
    g = parseInt(m[1].slice(2, 4), 16);
    b = parseInt(m[1].slice(4, 6), 16);
    if (m[2]) a = parseInt(m[2], 16) / 255;
  } else if ((m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(v))) {
    r = +m[1];
    g = +m[2];
    b = +m[3];
    if (m[4]) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4];
  } else {
    return undefined;
  }
  if (a < 1) {
    const u = normalizeColor(under) ?? '#000000';
    const ur = parseInt(u.slice(1, 3), 16);
    const ug = parseInt(u.slice(3, 5), 16);
    const ub = parseInt(u.slice(5, 7), 16);
    r = r * a + ur * (1 - a);
    g = g * a + ug * (1 - a);
    b = b * a + ub * (1 - a);
  }
  const hex = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

export function readTheme(style: { getPropertyValue(name: string): string }, overrides: Record<string, string>): ITheme {
  const css = (name: string) => style.getPropertyValue(`--vscode-${name}`).trim() || undefined;
  const background = normalizeColor(css('terminal-background') ?? css('panel-background') ?? css('editor-background')) ?? '#1e1e1e';
  const foreground = normalizeColor(css('terminal-foreground') ?? css('editor-foreground'), background) ?? '#cccccc';
  const theme: ITheme = {
    background,
    foreground,
    cursor: normalizeColor(css('terminalCursor-foreground'), background) ?? foreground,
    cursorAccent: normalizeColor(css('terminalCursor-background'), background) ?? background,
    selectionBackground: normalizeColor(css('terminal-selectionBackground') ?? css('editor-selectionBackground'), background) ?? '#264f78',
  };
  const selFg = normalizeColor(css('terminal-selectionForeground'), background);
  if (selFg) theme.selectionForeground = selFg;
  const fm = normalizeColor(css('terminal-findMatchBackground') ?? css('editor-findMatchBackground'), background);
  if (fm) theme.findMatchBackground = fm;
  const fmh = normalizeColor(css('terminal-findMatchHighlightBackground') ?? css('editor-findMatchHighlightBackground'), background);
  if (fmh) theme.findMatchHighlightBackground = fmh;
  for (const [key, token] of ANSI) {
    (theme as unknown as Record<string, string>)[key] = normalizeColor(css(`terminal-${token}`), background) ?? FALLBACK[key as keyof typeof FALLBACK];
  }
  for (const [k, v] of Object.entries(overrides)) {
    const c = normalizeColor(v, background);
    if (c) (theme as unknown as Record<string, string>)[k] = c;
  }
  return theme;
}

export function sameTheme(a: ITheme | undefined, b: ITheme): boolean {
  return !!a && JSON.stringify(a) === JSON.stringify(b);
}

/** '#rrggbb' -> 0xRRGGBB. */
export function hexToRgb(hex: string): number {
  return parseInt(hex.slice(1, 7), 16);
}

/** Palette entries 0-15 from the theme. */
export function themePalette(t: Theme): number[] {
  return ANSI_KEYS.map((k) => hexToRgb(t[k] ?? FALLBACK[k]));
}
