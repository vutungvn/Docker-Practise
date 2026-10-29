// v1 and v2 are two releases of the same service. To keep the demo in one folder the release is chosen at
// build time (`--build-arg APP_VERSION=v2`), which bakes the matching code path and schema target into the image.
export type Release = 'v1' | 'v2';

// Highest migration number each release needs. 003 (contract) belongs to the *next* release.
export const SCHEMA_TARGET: Record<Release, number> = { v1: 1, v2: 2 };

export interface AppConfig {
  port: number;
  databaseUrl: string;
  release: Release;
  color: string;
  schemaTarget: number;
  startupDelayMs: number;
  drainMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (!env.DATABASE_URL) throw new Error('Missing required environment variable: DATABASE_URL');

  const release = (env.APP_VERSION ?? 'v1') as Release;
  if (!(release in SCHEMA_TARGET)) throw new Error(`Unknown APP_VERSION: ${env.APP_VERSION}`);

  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl: env.DATABASE_URL,
    release,
    color: env.COLOR ?? 'none',
    schemaTarget: Number(env.SCHEMA_TARGET ?? SCHEMA_TARGET[release]),
    startupDelayMs: Number(env.STARTUP_DELAY_SECONDS ?? 0) * 1000,
    drainMs: Number(env.DRAIN_SECONDS ?? 30) * 1000,
  };
}
