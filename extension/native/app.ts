// Entry point of the native app's page: the bridge first (it provides
// acquireVsCodeApi), then the extension's terminal page, then the host.

import './bridge';
import '../webview/main';
import { startApp } from './host';

void startApp().catch((e: Error) => {
  document.body.textContent = `code-gty could not start: ${e.message}`;
});
