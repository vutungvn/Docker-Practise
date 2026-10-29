import { createApp } from './app';
import { loadConfig } from './config';
import { createPool } from './db';

// Migrations are not run here: the deploy script runs them as a separate, all-or-nothing step first.
const config = (() => {
  try {
    return loadConfig();
  } catch (err) {
    console.error(`[shopfast] ${(err as Error).message}`);
    process.exit(1);
  }
})();

let ready = false;
let stopping = false;
const pool = createPool(config.databaseUrl);
const server = createApp({ ...config, pool, isReady: () => ready && !stopping }).listen(config.port, () =>
  console.log(
    `[shopfast] ${config.appVersion} on ${config.port} (env=${config.appEnv}, fault=${config.fault})`,
  ),
);
setTimeout(() => (ready = true), config.startupDelayMs);

// node runs as PID 1, so handle SIGTERM ourselves: stop being ready, finish in-flight requests, exit.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    stopping = true;
    server.close(async () => {
      await pool.end().catch(() => undefined);
      process.exit(0);
    });
  });
}
