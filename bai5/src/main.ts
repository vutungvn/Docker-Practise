import { createApp } from './app';
import { loadConfig } from './config';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`[shopfast] ${(err as Error).message}`);
  process.exit(1);
}

const server = createApp(config).listen(config.port, () => {
  console.log(`[shopfast] listening on port ${config.port} (NODE_ENV=${config.nodeEnv})`);
});

// node runs as PID 1, so handle SIGTERM ourselves for a clean `docker stop`.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`[shopfast] received ${signal}, shutting down`);
    server.close(() => process.exit(0));
  });
}
