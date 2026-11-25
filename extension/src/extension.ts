import * as vscode from 'vscode';
import { CodeGtyApi, createApi } from './api';
import { TerminalManager, VIEW_TYPE } from './manager';
import type { TerminalSession } from './session';

export function activate(context: vscode.ExtensionContext): CodeGtyApi {
  const log = vscode.window.createOutputChannel('code-gty', { log: true });
  context.subscriptions.push(log);
  const manager = new TerminalManager(context, log);

  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, manager));

  const withActive = (fn: (s: TerminalSession) => unknown) => () => {
    const s = manager.activeSession;
    if (s) return fn(s);
    void vscode.window.showInformationMessage('No active Ghostty terminal.');
  };

  const register = (id: string, fn: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register('codeGty.new', () => manager.create());
  register('codeGty.newToSide', () => manager.create({ cwd: manager.activeSession?.cwd }, vscode.ViewColumn.Beside));
  register('codeGty.newInCwd', () => manager.create({ cwd: manager.activeSession?.cwd }));
  register(
    'codeGty.kill',
    withActive(async (s) => {
      await s.refreshProcess();
      const confirm = vscode.workspace.getConfiguration('terminal.integrated').get<string>('confirmOnKill', 'editor');
      if (s.isBusy && !s.isExited && (confirm === 'editor' || confirm === 'always')) {
        const choice = await vscode.window.showWarningMessage(`"${s.foregroundName ?? 'A process'}" is still running. Terminate it?`, { modal: true }, 'Terminate');
        if (choice !== 'Terminate') return;
      }
      s.kill();
      s.panel.dispose();
    }),
  );
  register('codeGty.clear', withActive((s) => s.clear()));
  register('codeGty.focus', () => {
    const s = manager.activeSession ?? manager.all[0];
    if (s) s.panel.reveal(undefined, false);
    else manager.create();
  });
  register('codeGty.copy', withActive((s) => s.post({ type: 'copySelection' })));
  register('codeGty.paste', withActive(async (s) => s.paste(await vscode.env.clipboard.readText())));
  register('codeGty.selectAll', withActive((s) => s.post({ type: 'selectAll' })));
  register('codeGty.find', withActive((s) => s.post({ type: 'find' })));
  register('codeGty.scrollToPreviousCommand', withActive((s) => s.post({ type: 'scrollToCommand', direction: 'previous' })));
  register('codeGty.scrollToNextCommand', withActive((s) => s.post({ type: 'scrollToCommand', direction: 'next' })));
  register('codeGty.restartSidecar', async () => {
    const live = manager.all.filter((s) => !s.isExited).length;
    if (live > 0) {
      const ok = await vscode.window.showWarningMessage(`Restarting the sidecar ends ${live} running terminal(s).`, { modal: true }, 'Restart');
      if (ok !== 'Restart') return;
    }
    for (const s of manager.all) s.kill();
    await manager.restartSidecar();
  });
  register(
    'codeGty.rename',
    withActive(async (s) => {
      const name = await vscode.window.showInputBox({ prompt: 'Terminal name (empty to reset)', value: s.title });
      if (name !== undefined) s.rename(name);
    }),
  );
  register('codeGty.sendText', (args?: { text?: string; addNewLine?: boolean }) => {
    if (typeof args?.text !== 'string') return;
    const s = manager.activeSession ?? manager.create();
    s?.sendText(args.text, args.addNewLine ?? true);
  });
  register('codeGty.runSelectedText', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const text = editor.selections.map((sel) => (sel.isEmpty ? editor.document.lineAt(sel.active.line).text : editor.document.getText(sel))).join('\n');
    const s = manager.activeSession ?? manager.create(undefined, vscode.ViewColumn.Beside, true);
    if (!s) return;
    // Wait for the shell if this created the terminal.
    void s.processId().then(() => s.sendText(text, true));
  });
  register(
    'codeGty.showRecentOutput',
    withActive(async (s) => {
      const text = await s.recentOutput();
      const doc = await vscode.workspace.openTextDocument({ content: text, language: 'plaintext' });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
  );

  return createApi(manager);
}

export function deactivate(): void {
  // Subscriptions dispose the manager, which kills sessions and the sidecar.
}
