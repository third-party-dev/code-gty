// The terminal webview page. vscode-free so the webview tests load exactly
// the page (and content security policy) the extension ships.

export interface HtmlInput {
  cspSource: string;
  nonce: string;
  media: (file: string) => string;
  /** Extra script injected before the bundle (tests only). */
  preludeScript?: string;
}

export function renderTerminalHtml({ cspSource, nonce, media, preludeScript }: HtmlInput): string {
  const csp = [
    "default-src 'none'",
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
    `style-src ${cspSource} 'nonce-${nonce}'`,
    // libghostty-vt is WebAssembly, and callbacks are tiny generated modules: 'wasm-unsafe-eval'.
    `script-src 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    `connect-src ${cspSource}`,
  ].join('; ');
  const prelude = preludeScript ? `<script nonce="${nonce}">${preludeScript}</script>\n` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${media('webview.css')}" nonce="${nonce}">
</head>
<body data-wasm="${media('ghostty-vt.wasm')}">
<div id="terminal" role="application" aria-label="Terminal"></div>
<div id="find" class="find" hidden>
  <input id="find-input" type="text" placeholder="Find" aria-label="Find in terminal" spellcheck="false">
  <span id="find-count" class="find-count" aria-live="polite"></span>
  <button id="find-prev" title="Previous match (Shift+Enter)" aria-label="Previous match">&#8593;</button>
  <button id="find-next" title="Next match (Enter)" aria-label="Next match">&#8595;</button>
  <button id="find-close" title="Close (Escape)" aria-label="Close find">&#215;</button>
</div>
<div id="notice" class="notice" hidden></div>
<div id="a11y" class="sr-only" aria-live="polite" role="log"></div>
${prelude}<script nonce="${nonce}" src="${media('webview.js')}"></script>
</body>
</html>`;
}
