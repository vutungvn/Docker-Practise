// Everything environment-specific comes from env vars at runtime, so one image serves every environment.
export type FaultMode = 'none' | 'errors' | 'latency';

export interface AppConfig {
  port: number;
  databaseUrl: string;
  appEnv: string;
  appVersion: string;
  startupDelayMs: number;
  fault: FaultMode;
}

const FAULTS: FaultMode[] = ['none', 'errors', 'latency'];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (!env.DATABASE_URL) throw new Error('Missing required environment variable: DATABASE_URL');

  const fault = (env.FAULT_MODE || 'none') as FaultMode;
  if (!FAULTS.includes(fault)) throw new Error(`Unknown FAULT_MODE: ${env.FAULT_MODE}`);

  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl: env.DATABASE_URL,
    appEnv: env.APP_ENV ?? 'local',
    appVersion: env.APP_VERSION ?? 'dev',
    startupDelayMs: Number(env.STARTUP_DELAY_SECONDS ?? 0) * 1000,
    fault,
  };
}
