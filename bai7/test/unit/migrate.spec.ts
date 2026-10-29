import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../src/config';
import { pendingMigrations } from '../../src/migrate';

describe('pendingMigrations', () => {
  it('returns unapplied files in numeric order', () => {
    expect(pendingMigrations(['002_b.sql', '001_a.sql', '003_c.sql'], ['001_a.sql'])).toEqual([
      '002_b.sql',
      '003_c.sql',
    ]);
  });

  it('ignores non-SQL files', () => {
    expect(pendingMigrations(['001_a.sql', 'README.md'], [])).toEqual(['001_a.sql']);
  });

  it('rejects two migrations with the same number (two branches merged at once)', () => {
    expect(() => pendingMigrations(['003_add_x.sql', '003_add_y.sql'], [])).toThrow(
      'Duplicate migration number 003',
    );
  });

  it('rejects badly named files', () => {
    expect(() => pendingMigrations(['add-column.sql'], [])).toThrow('Invalid migration file name');
  });

  it('the real migrations folder is valid', () => {
    const files = readdirSync(join(__dirname, '..', '..', 'migrations'));
    expect(pendingMigrations(files, []).length).toBeGreaterThan(0);
  });
});

describe('loadConfig', () => {
  it('fails fast without DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow('DATABASE_URL');
  });

  it('defaults version and env', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://db/x' })).toMatchObject({
      appEnv: 'local',
      appVersion: 'dev',
      port: 3000,
    });
  });
});
