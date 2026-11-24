// Opens links clicked in the terminal: web URLs through the external-URI
// mapping (so localhost is port-forwarded remotely), files at line:col.

import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseFileLink } from './linkParse';

const WEB_SCHEMES = new Set(['http', 'https', 'mailto']);

export async function openLink(kind: 'url' | 'file', text: string, cwd: string | undefined): Promise<void> {
  if (kind === 'url' && !text.startsWith('file:')) {
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(text, true);
    } catch {
      return;
    }
    if (!WEB_SCHEMES.has(uri.scheme)) {
      void vscode.window.showWarningMessage(`code-gty: not opening link with scheme "${uri.scheme}:".`);
      return;
    }
    const external = uri.scheme === 'mailto' ? uri : await vscode.env.asExternalUri(uri);
    await vscode.env.openExternal(external);
    return;
  }
  await openFileLink(text, cwd);
}

async function openFileLink(text: string, cwd: string | undefined): Promise<void> {
  const parsed = parseFileLink(text);
  const target = await resolveExisting(parsed.path, cwd);
  if (!target) {
    // Same fallback as the built-in terminal: let Quick Open search for it.
    await vscode.commands.executeCommand('workbench.action.quickOpen', parsed.path);
    return;
  }
  if (target.type === vscode.FileType.Directory) {
    await vscode.commands.executeCommand('revealInExplorer', target.uri);
    return;
  }
  const options: vscode.TextDocumentShowOptions = { preview: false };
  if (parsed.line) {
    const pos = new vscode.Position(Math.max(0, parsed.line - 1), Math.max(0, (parsed.col ?? 1) - 1));
    options.selection = new vscode.Range(pos, pos);
  }
  await vscode.commands.executeCommand('vscode.open', target.uri, options);
}

async function resolveExisting(p: string, cwd: string | undefined): Promise<{ uri: vscode.Uri; type: vscode.FileType } | undefined> {
  if (!p) return undefined;
  let expanded = p;
  if (p === '~' || p.startsWith('~/')) expanded = path.join(os.homedir(), p.slice(1));
  const candidates: string[] = [];
  if (path.isAbsolute(expanded)) {
    candidates.push(expanded);
  } else {
    if (cwd) candidates.push(path.join(cwd, expanded));
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      if (f.uri.scheme === 'file') candidates.push(path.join(f.uri.fsPath, expanded));
    }
  }
  for (const c of candidates) {
    const uri = vscode.Uri.file(c);
    try {
      // workspace.fs works the same locally and on a remote extension host.
      const stat = await vscode.workspace.fs.stat(uri);
      return { uri, type: stat.type & vscode.FileType.Directory ? vscode.FileType.Directory : vscode.FileType.File };
    } catch {
      /* try the next one */
    }
  }
  return undefined;
}
