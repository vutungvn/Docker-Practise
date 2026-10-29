import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';

// Any fixed number works; every runner of this app must use the same one.
const MIGRATION_LOCK_ID = 9_2026_0001;
const MIGRATION_FILE = /^(\d{3})_[a-z0-9_]+\.sql$/;

// Decide which files still have to run. Pure, so it is unit tested without a database.
export function pendingMigrations(files: string[], applied: Iterable<string>): string[] {
  const done = new Set(applied);
  const migrations = files.filter((f) => f.endsWith('.sql')).sort();

  const seen = new Map<string, string>();
  for (const file of migrations) {
    const match = MIGRATION_FILE.exec(file);
    if (!match) throw new Error(`Invalid migration file name: ${file} (expected 001_snake_case.sql)`);
    const clash = seen.get(match[1]);
    if (clash) throw new Error(`Duplicate migration number ${match[1]}: ${clash} and ${file}`);
    seen.set(match[1], file);
  }

  return migrations.filter((f) => !done.has(f));
}

/**
 * Apply pending migrations, each one inside its own transaction.
 * - Postgres DDL is transactional: a migration that fails halfway is rolled back completely,
 *   so the schema is either fully at the previous version or fully at the next one.
 * - An advisory lock makes concurrent runners (two deploys at once) wait instead of racing.
 * - lock_timeout stops a migration from queueing forever behind live traffic holding table locks.
 */
export async function runMigrations(pool: Pool, dir: string): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
    const pending = pendingMigrations(
      await readdir(dir),
      rows.map((r) => r.version),
    );

    for (const file of pending) {
      const sql = await readFile(join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '10s'");
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed and was rolled back: ${(err as Error).message}`);
      }
    }
    return pending;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}
