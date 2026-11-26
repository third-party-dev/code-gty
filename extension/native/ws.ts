// The sidecar daemon, reached through the native app's WebSocket bridge:
// the Rust side authenticates to the daemon and passes bytes both ways, so
// this page speaks the same frames as the extension host.

import type { Connector, Transport, TransportEvents } from '../src/core/sidecarClient';

export function wsConnector(url: string): Connector {
  return {
    persistent: true,
    connect(events: TransportEvents): Promise<Transport> {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';
        let open = false;
        ws.onopen = () => {
          open = true;
          resolve({
            send: (bytes) => {
              if (ws.readyState === WebSocket.OPEN) ws.send(bytes);
            },
            close: () => ws.close(),
            destroy: () => ws.close(),
          });
        };
        ws.onmessage = (ev) => events.data(new Uint8Array(ev.data as ArrayBuffer));
        ws.onerror = () => {
          if (!open) reject(new Error('could not reach the sidecar bridge'));
        };
        ws.onclose = (ev) => events.closed(`sidecar bridge closed (${ev.code})`);
      });
    },
  };
}
