// The little of node:path the shared shell code uses, for the native app's
// page (aliased in its bundle). posix and win32 flavours, as Node has.

function make(sep: '/' | '\\') {
  const split = sep === '/' ? /\/+/ : /[\\/]+/;
  return {
    sep,
    join: (...parts: string[]): string =>
      parts
        .filter((p) => p !== '')
        .join(sep)
        .replace(sep === '/' ? /\/+/g : /[\\/]+/g, sep),
    basename: (p: string): string => p.split(split).filter(Boolean).pop() ?? '',
    dirname: (p: string): string => {
      const parts = p.split(split);
      parts.pop();
      return parts.join(sep) || (p.startsWith(sep) ? sep : '.');
    },
    isAbsolute: (p: string): boolean => (sep === '/' ? p.startsWith('/') : /^([A-Za-z]:)?[\\/]/.test(p)),
  };
}

export const posix = make('/');
export const win32 = make('\\');
const native = (globalThis as { navigator?: { platform?: string } }).navigator?.platform?.startsWith('Win') ? win32 : posix;
export const { sep, join, basename, dirname, isAbsolute } = native;
export default { posix, win32, sep, join, basename, dirname, isAbsolute };
