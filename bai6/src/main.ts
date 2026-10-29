import Redis from 'ioredis';
import { createApp } from './app';
import { loadConfig } from './config';
import { createPool, migrate, seed } from './db';

async function main() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });

  await migrate(pool);
  await seed(pool);

  const server = createApp({ pool, redis, cacheTtlSeconds: config.cacheTtlSeconds }).listen(config.port, () => {
    console.log(`[shopfast] listening on port ${config.port} (NODE_ENV=${config.nodeEnv})`);
  });

  // node runs as PID 1, so handle SIGTERM ourselves for a clean `docker stop`.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      console.log(`[shopfast] received ${signal}, shutting down`);
      server.close(async () => {
        await Promise.allSettled([pool.end(), redis.quit()]);
        process.exit(0);
      });
    });
  }
}

main().catch((err) => {
  console.error(`[shopfast] ${(err as Error).message}`);
  process.exit(1);
});
