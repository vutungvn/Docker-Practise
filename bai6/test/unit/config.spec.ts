import { loadConfig } from '../../src/config';

describe('loadConfig', () => {
  it('fails fast when connection strings are missing', () => {
    expect(() => loadConfig({})).toThrow('DATABASE_URL, REDIS_URL');
  });

  it('applies defaults for optional values', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://db/x', REDIS_URL: 'redis://cache:6379' });
    expect(config).toMatchObject({ port: 3000, nodeEnv: 'development', cacheTtlSeconds: 60 });
  });
});
