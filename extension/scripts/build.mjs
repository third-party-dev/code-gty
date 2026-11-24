// Bundles the extension host (CommonJS for Node) and the webview (IIFE for
// the browser), and copies the ghostty-web WASM into media/ after checking it
// against the checksum pinned below.
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const production = process.env.NODE_ENV === 'production' || process.argv.includes('--production');

// ghostty-web@0.4.0 ghostty-vt.wasm. Update deliberately with the dependency.
const WASM_SHA256 = 'd6f0326f1874ad2ce9f289e3a4a0c5f3507d4cb38d8747e4b287def470a0c60a';
// The webview bundle must stay small enough to load quickly in remote setups.
const WEBVIEW_BUDGET = 400_000;

const wasmSrc = join(root, 'node_modules', 'ghostty-web', 'ghostty-vt.wasm');
const wasmSum = createHash('sha256').update(readFileSync(wasmSrc)).digest('hex');
if (wasmSum !== WASM_SHA256) {
  console.error(`ghostty-vt.wasm checksum mismatch: expected ${WASM_SHA256}, got ${wasmSum}`);
  process.exit(1);
}
copyFileSync(wasmSrc, join(root, 'media', 'ghostty-vt.wasm'));

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

// ghostty-web sizes the cell from the ink of "M": the cap height above the
// baseline, a 0.2em guess below it (M has no descent, and 0 is falsy), plus
// 2px. That is shorter than the font's line, so glyphs designed to fill the
// line (Powerline arches and separators, full blocks) overflow the row. Use the
// font's own ascent and descent instead, as native terminals do.
const MEASURE_FONT_ORIGINAL =
  'C = g.actualBoundingBoxAscent || this.fontSize * 0.8, I = g.actualBoundingBoxDescent || this.fontSize * 0.2, D = Math.ceil(C + I) + 2, i = Math.ceil(C) + 1;';
const MEASURE_FONT_PATCHED =
  'C = g.fontBoundingBoxAscent || g.actualBoundingBoxAscent || this.fontSize * 0.8, I = g.fontBoundingBoxDescent || this.fontSize * 0.2, D = Math.ceil(C + I), i = Math.round(C + (D - C - I) / 2);';

// Draw Powerline separators and block elements as shapes that fill the cell
// (webview/sprites.ts), and snap cell and row backgrounds to device pixels so
// neighbouring cells meet without seams at fractional scales.
const SPRITES = join(root, 'webview', 'sprites.ts');
const RENDER_PATCHES = [
  {
    what: 'row background',
    count: 1,
    from: 'this.ctx.fillRect(0, E, g * this.metrics.width, this.metrics.height);',
    to: '__gtyFillSnapped(this.ctx, 0, E, g * this.metrics.width, this.metrics.height, this.devicePixelRatio);',
  },
  {
    what: 'cell and selection backgrounds',
    count: 2,
    from: 'this.ctx.fillRect(E, C, I, this.metrics.height)',
    to: '__gtyFillSnapped(this.ctx, E, C, I, this.metrics.height, this.devicePixelRatio)',
  },
  {
    what: 'cell text',
    count: 1,
    from: 'this.ctx.fillText(N, w, s)',
    to: '(__gtyDrawSprite(this.ctx, N, E, C, I, this.metrics.height, this.devicePixelRatio) || this.ctx.fillText(N, w, s))',
  },
];

function replaceExactly(src, from, to, count, what) {
  const found = src.split(from).length - 1;
  if (found !== count) throw new Error(`ghostty-web ${what}: expected ${count} match(es), found ${found}; update patchGhosttyWeb`);
  return src.split(from).join(to);
}

// Source patches for ghostty-web@0.4.0. Each must match exactly, so a
// dependency update that changes the code fails the build instead of silently
// dropping the patch.
const patchGhosttyWeb = {
  name: 'patch-ghostty-web',
  setup(build) {
    build.onLoad({ filter: /ghostty-web[\\/]dist[\\/]ghostty-web\.js$/ }, (args) => {
      let src = readFileSync(args.path, 'utf8');
      // ghostty-web inlines a base64 copy of the WASM as a fallback. We always
      // load the file through asWebviewUri, so drop the copy (about 560 KB).
      const stripped = src.replace(/"data:application\/wasm;base64,[A-Za-z0-9+/=]+"/, '"data:application/wasm;base64,"');
      if (stripped === src) throw new Error('inline WASM not found in ghostty-web; update patchGhosttyWeb');
      src = stripped;
      src = replaceExactly(src, MEASURE_FONT_ORIGINAL, MEASURE_FONT_PATCHED, 1, 'measureFont');
      for (const p of RENDER_PATCHES) src = replaceExactly(src, p.from, p.to, p.count, p.what);
      src = `import { drawSprite as __gtyDrawSprite, fillSnapped as __gtyFillSnapped } from ${JSON.stringify(SPRITES)};\n${src}`;
      return { contents: src, loader: 'js' };
    });
  },
};

const webview = {
  ...common,
  plugins: [patchGhosttyWeb],
  entryPoints: [join(root, 'webview', 'main.ts')],
  outfile: join(root, 'media', 'webview.js'),
  platform: 'browser',
  format: 'iife',
  target: 'chrome114',
  // ghostty-web's Node/Bun file loader is never used in the browser.
  define: { 'process.env.NODE_ENV': '"production"' },
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
  console.log(`webview.js: ${size} bytes (budget ${WEBVIEW_BUDGET})`);
}
