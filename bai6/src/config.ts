// Connection strings are read at runtime only; nothing is baked into the image or the workflow file.
export interface AppConfig {
  port: number;
  nodeEnv: string;
  databaseUrl: string;
  redisUrl: string;
  cacheTtlSeconds: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const missing = ['DATABASE_URL', 'REDIS_URL'].filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
    port: Number(env.PORT ?? 3000),
    nodeEnv: env.NODE_ENV ?? 'development',
    databaseUrl: env.DATABASE_URL as string,
    redisUrl: env.REDIS_URL as string,
    cacheTtlSeconds: Number(env.CACHE_TTL_SECONDS ?? 60),
  };
}
