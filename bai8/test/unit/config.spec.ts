import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../src/config';
import { pendingMigrations } from '../../src/migrate';

const files = readdirSync(join(__dirname, '..', '..', 'migrations'));

describe('schema targets', () => {
  it('v1 only needs 001, v2 needs the expand migration but never the contract one', () => {
    expect(
      pendingMigrations(files, [], loadConfig({ DATABASE_URL: 'x', APP_VERSION: 'v1' }).schemaTarget),
    ).toEqual(['001_create_products.sql']);
    expect(
      pendingMigrations(files, [], loadConfig({ DATABASE_URL: 'x', APP_VERSION: 'v2' }).schemaTarget),
    ).toEqual(['001_create_products.sql', '002_expand_price_vnd.sql']);
  });

  it('the contract migration only runs when SCHEMA_TARGET is raised explicitly', () => {
    const config = loadConfig({ DATABASE_URL: 'x', APP_VERSION: 'v2', SCHEMA_TARGET: '3' });
    expect(
      pendingMigrations(files, ['001_create_products.sql', '002_expand_price_vnd.sql'], config.schemaTarget),
    ).toEqual(['003_contract_drop_price.sql']);
  });

  it('rejects an unknown release', () => {
    expect(() => loadConfig({ DATABASE_URL: 'x', APP_VERSION: 'v9' })).toThrow('Unknown APP_VERSION');
  });

  it('reads drain and warm-up settings', () => {
    expect(loadConfig({ DATABASE_URL: 'x', STARTUP_DELAY_SECONDS: '25', DRAIN_SECONDS: '20' })).toMatchObject(
      {
        startupDelayMs: 25_000,
        drainMs: 20_000,
      },
    );
  });
});
