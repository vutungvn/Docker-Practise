// Everything environment-specific comes from env vars at runtime, so one image serves every environment.
export interface AppConfig {
  port: number;
  databaseUrl: string;
  appEnv: string;
  appVersion: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (!env.DATABASE_URL) {
    throw new Error('Missing required environment variable: DATABASE_URL');
  }

  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl: env.DATABASE_URL,
    appEnv: env.APP_ENV ?? 'local',
    appVersion: env.APP_VERSION ?? 'dev',
  };
}
