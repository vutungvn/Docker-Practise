import { createServer } from 'node:http';
import { createApp } from './app';
import { loadConfig } from './config';
import { createPool } from './db';
import { attachRealtime } from './realtime';

const config = (() => {
  try {
    return loadConfig();
  } catch (err) {
    console.error(`[shopfast] ${(err as Error).message}`);
    process.exit(1);
  }
})();
const tag = `${config.release}-${config.color}`;

let ready = false;
let stopping = false;
const pool = createPool(config.databaseUrl);
const isReady = () => ready && !stopping;
const server = createServer(createApp({ ...config, pool, isReady }));
const realtime = attachRealtime(server, { ...config, isReady });

server.listen(config.port, () => console.log(`[${tag}] listening on ${config.port}, warming up`));

// Models the 25 s the real service needs before it can take traffic (caches, connection pools, JIT...).
setTimeout(() => {
  ready = true;
  console.log(`[${tag}] ready`);
}, config.startupDelayMs);

// Standby after a switch: hand realtime users over to the live color, keep serving HTTP for a fast rollback.
process.on('SIGUSR2', async () => {
  const moved = await realtime.drain();
  console.log(`[${tag}] drained ${moved} realtime connections`);
});

// Final stop: refuse readiness, move remaining realtime users gracefully, then finish in-flight requests.
process.on('SIGTERM', async () => {
  if (stopping) return;
  stopping = true;
  console.log(`[${tag}] SIGTERM: draining ${realtime.connections()} realtime connections`);
  await realtime.drain();
  realtime.close();
  server.close(async () => {
    await pool.end().catch(() => undefined);
    console.log(`[${tag}] stopped cleanly`);
    process.exit(0);
  });
});
