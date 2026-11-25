// OSC 7 working-directory reports: `file://host/path` URIs (or bare paths).

/** `file://host/path` -> local path (percent-decoded). Windows drive paths lose the leading slash. */
export function parseFileUri(uri: string): string | undefined {
  if (!uri.startsWith('file://')) {
    // Some shells send a bare path.
    return uri.startsWith('/') ? uri : undefined;
  }
  const afterScheme = uri.slice('file://'.length);
  const slash = afterScheme.indexOf('/');
  if (slash < 0) return undefined;
  let path: string;
  try {
    path = decodeURIComponent(afterScheme.slice(slash));
  } catch {
    return undefined;
  }
  if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
  return path;
}
