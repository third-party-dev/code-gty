// Bundles the extension host (CommonJS for Node) and the webview (IIFE for
// the browser). Both include gty-vt (vt/), the bindings for libghostty-vt;
// the module itself, media/ghostty-vt.wasm, is built by vt-wasm/build.sh
// (the Docker vt-wasm stage) and is checked here against the bindings'
// generated layout.
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const production = process.env.NODE_ENV === 'production' || process.argv.includes('--production');

// The webview bundle (not counting the WASM module, which loads separately
// and compresses well in the VSIX) must stay small enough to load quickly in
// remote setups.
const WEBVIEW_BUDGET = 200_000;
const WASM_BUDGET = 1_600_000;

const wasm = join(root, 'media', 'ghostty-vt.wasm');
if (!existsSync(wasm)) {
  console.error('media/ghostty-vt.wasm is missing. Build it with vt-wasm/build.sh (Zig 0.17) or:');
  console.error('  docker build --target vt-wasm-out --output type=local,dest=extension/media .');
  process.exit(1);
}
if (statSync(wasm).size > WASM_BUDGET) {
  console.error(`ghostty-vt.wasm is ${statSync(wasm).size} bytes, over the ${WASM_BUDGET} byte budget`);
  process.exit(1);
}
// The bindings read struct offsets and enum values from vt/layout.generated.ts;
// it must describe exactly this module.
execFileSync(process.execPath, [join(root, 'scripts', 'gen-vt-layout.mjs'), '--check', wasm], { stdio: 'inherit' });

const common = {
  bundle: true,
  minify: production,
  sourcemap: production ? false : 'linked',
  logLevel: 'info',
  legalComments: 'linked',
};

const host = {
  ...common,
  entryPoints: [join(root, 'src', 'extension.ts')],
  outfile: join(root, 'dist', 'extension.js'),
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
};

const webview = {
  ...common,
  entryPoints: [join(root, 'webview', 'main.ts')],
  outfile: join(root, 'media', 'webview.js'),
  platform: 'browser',
  format: 'iife',
  // simd128 in the module already needs Chrome 91, Firefox 89, Safari 16.4.
  target: ['chrome114', 'firefox115', 'safari16.4'],
};

if (watch) {
  const ctxs = await Promise.all([esbuild.context(host), esbuild.context(webview)]);
  await Promise.all(ctxs.map((c) => c.watch()));
} else {
  await Promise.all([esbuild.build(host), esbuild.build(webview)]);
  const size = statSync(webview.outfile).size;
  if (size > WEBVIEW_BUDGET) {
    console.error(`webview.js is ${size} bytes, over the ${WEBVIEW_BUDGET} byte budget`);
    process.exit(1);
  }
  console.log(`webview.js: ${size} bytes (budget ${WEBVIEW_BUDGET}); ghostty-vt.wasm: ${statSync(wasm).size} bytes`);
}
