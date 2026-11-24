// Runs the integration suite in a real VS Code (Electron) instance.
// VSCODE_TEST_VERSION pins the editor build; defaults to the minimum supported.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workspace = mkdtempSync(join(tmpdir(), 'gty-ws-'));
const version = process.env.VSCODE_TEST_VERSION ?? '1.90.0';

try {
  await runTests({
    version,
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'test', 'integration', 'suite', 'index.js'),
    launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-gpu', '--no-sandbox'],
    extensionTestsEnv: { GTY_TEST_WORKSPACE: workspace },
  });
} catch (e) {
  console.error('Integration tests failed:', e);
  process.exit(1);
}
