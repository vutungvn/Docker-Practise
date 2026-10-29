import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { runMigrations } from '../../src/migrate';
import { appliedVersions, FIXTURES_DIR, freshSchema, MIGRATIONS_DIR, tableExists } from './helpers';

let pool: Pool;

afterEach(async () => {
  await pool?.end();
});

describe('runMigrations', () => {
  it('applies every migration once and is idempotent', async () => {
    pool = await freshSchema('it_mig_basic');
    expect(await runMigrations(pool, MIGRATIONS_DIR)).toEqual([
      '001_create_products.sql',
      '002_add_product_stock.sql',
    ]);
    expect(await runMigrations(pool, MIGRATIONS_DIR)).toEqual([]);

    const { rows } = await pool.query('SELECT name, stock FROM products ORDER BY id');
    expect(rows).toEqual([
      { name: 'Ao thun ShopFast', stock: 0 },
      { name: 'Non luoi trai', stock: 0 },
    ]);
  });

  it('a migration that fails halfway leaves no trace (no half-applied schema)', async () => {
    pool = await freshSchema('it_mig_broken');
    await expect(runMigrations(pool, join(FIXTURES_DIR, 'broken-migrations'))).rejects.toThrow(
      'Migration 002_fails_midway.sql failed and was rolled back',
    );

    // 001 committed; 002 created a table and inserted a row before failing - both are gone.
    expect(await tableExists(pool, 'ok_table')).toBe(true);
    expect(await tableExists(pool, 'half_done')).toBe(false);
    expect(await appliedVersions(pool)).toEqual(['001_ok.sql']);
  });

  it('a migration that only fails on real data (works on an empty CI database) is rolled back', async () => {
    pool = await freshSchema('it_mig_data');
    await runMigrations(pool, MIGRATIONS_DIR);
    await pool.query("INSERT INTO products (name, price) VALUES ('Non luoi trai', 120000)"); // duplicate name

    const dir = mkdtempSync(join(tmpdir(), 'shopfast-mig-'));
    try {
      for (const file of readdirSync(MIGRATIONS_DIR))
        copyFileSync(join(MIGRATIONS_DIR, file), join(dir, file));
      writeFileSync(
        join(dir, '003_unique_product_name.sql'),
        `ALTER TABLE products ADD COLUMN slug TEXT;
         UPDATE products SET slug = lower(replace(name, ' ', '-'));
         ALTER TABLE products ADD CONSTRAINT products_name_key UNIQUE (name);`,
      );

      await expect(runMigrations(pool, dir)).rejects.toThrow('003_unique_product_name.sql failed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // The column added by the first statement was rolled back together with the failed constraint.
    const { rows } = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'it_mig_data' AND table_name = 'products'",
    );
    expect(rows.map((r) => r.column_name)).not.toContain('slug');
    expect(await appliedVersions(pool)).toEqual(['001_create_products.sql', '002_add_product_stock.sql']);
  });

  it('two deploys migrating at the same moment do not race (advisory lock)', async () => {
    pool = await freshSchema('it_mig_race');
    const results = await Promise.all([
      runMigrations(pool, MIGRATIONS_DIR),
      runMigrations(pool, MIGRATIONS_DIR),
    ]);

    // Exactly one runner applied the migrations; the other waited, then found nothing to do.
    expect(results.map((r) => r.length).sort()).toEqual([0, 2]);
    expect(await appliedVersions(pool)).toEqual(['001_create_products.sql', '002_add_product_stock.sql']);
  });
});
