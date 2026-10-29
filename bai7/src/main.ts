import { createApp } from './app';
import { loadConfig } from './config';
import { createPool } from './db';

// Migrations are NOT run here: deploy.sh runs them as a separate, all-or-nothing step first.
const config = (() => {
  try {
    return loadConfig();
  } catch (err) {
    console.error(`[shopfast] ${(err as Error).message}`);
    process.exit(1);
  }
})();

const pool = createPool(config.databaseUrl);
const server = createApp({ pool, appEnv: config.appEnv, appVersion: config.appVersion }).listen(
  config.port,
  () => console.log(`[shopfast] ${config.appVersion} listening on ${config.port} (env=${config.appEnv})`),
);

// node runs as PID 1, so handle SIGTERM ourselves for a clean `docker stop`.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`[shopfast] received ${signal}, shutting down`);
    server.close(async () => {
      await pool.end().catch(() => undefined);
      process.exit(0);
    });
  });
}
