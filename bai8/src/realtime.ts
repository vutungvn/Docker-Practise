import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { drainDelays } from './drain';

// RFC 6455 close code 1012 "Service Restart": tells the client this is planned and it should reconnect.
export const CLOSE_SERVICE_RESTART = 1012;

export interface RealtimeOptions {
  release: string;
  color: string;
  drainMs: number;
  isReady: () => boolean;
}

export function attachRealtime(server: Server, { release, color, drainMs, isReady }: RealtimeOptions) {
  // New realtime connections are refused (HTTP 503) while warming up or shutting down.
  const wss = new WebSocketServer({ server, path: '/ws', verifyClient: () => isReady() });

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'hello', version: release, color }));
  });

  const heartbeat = setInterval(() => {
    const tick = JSON.stringify({ type: 'tick', at: Date.now() });
    for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(tick);
  }, 10_000);

  return {
    connections: () => wss.clients.size,

    // Move every client currently connected here to whatever the load balancer routes to now.
    // New connections are still accepted (needed when this color becomes live again after a rollback).
    async drain(): Promise<number> {
      const clients = [...wss.clients];
      const delays = drainDelays(clients.length, drainMs);
      await Promise.all(
        clients.map(
          (ws, i) =>
            new Promise<void>((resolve) =>
              setTimeout(() => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'reconnect', reason: 'deploy' }));
                  ws.close(CLOSE_SERVICE_RESTART, 'deploy: reconnect');
                }
                resolve();
              }, delays[i]),
            ),
        ),
      );
      return clients.length;
    },

    close() {
      clearInterval(heartbeat);
      wss.close();
    },
  };
}
