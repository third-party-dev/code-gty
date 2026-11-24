// Finds the sidecar binary shipped in the VSIX, restores its executable bit
// (zip packaging can drop it) and verifies the checksum recorded at build
// time before every spawn.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface LocatedBinary {
  path: string;
  verified: boolean;
}

const exe = process.platform === 'win32' ? 'gty-sidecar.exe' : 'gty-sidecar';

export function locateSidecar(extensionPath: string, override?: string | null): LocatedBinary {
  if (override) {
    if (!fs.existsSync(override)) throw new Error(`codeGty.sidecarPath does not exist: ${override}`);
    return { path: override, verified: false };
  }
  const shipped = path.join(extensionPath, 'bin', exe);
  if (fs.existsSync(shipped)) {
    ensureExecutable(shipped);
    verifyChecksum(shipped, path.join(extensionPath, 'bin', `${exe}.sha256`));
    return { path: shipped, verified: true };
  }
  // Development checkout: use a locally built sidecar.
  for (const profile of ['release', 'debug']) {
    const dev = path.join(extensionPath, '..', 'sidecar', 'target', profile, exe);
    if (fs.existsSync(dev)) return { path: dev, verified: false };
  }
  throw new Error(`No sidecar binary for ${process.platform}-${process.arch} in this package. Install the platform-specific build of code-gty.`);
}

function ensureExecutable(file: string): void {
  if (process.platform === 'win32') return;
  const mode = fs.statSync(file).mode;
  if ((mode & 0o111) !== 0o111) fs.chmodSync(file, mode | 0o755);
}

export function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function verifyChecksum(file: string, sumFile: string): void {
  let expected: string;
  try {
    expected = fs.readFileSync(sumFile, 'utf8').trim().split(/\s+/)[0].toLowerCase();
  } catch {
    throw new Error(`Missing checksum file ${sumFile}; refusing to run an unverified sidecar.`);
  }
  const actual = sha256File(file);
  if (actual !== expected) {
    throw new Error(`Sidecar checksum mismatch (expected ${expected}, got ${actual}); refusing to run it.`);
  }
}
