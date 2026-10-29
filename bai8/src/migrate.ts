import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';

const MIGRATION_LOCK_ID = 8_2026_0001;
const MIGRATION_FILE = /^(\d{3})_[a-z0-9_]+\.sql$/;

// Files still to run, in order, up to (and including) migration number `upTo`.
export function pendingMigrations(files: string[], applied: Iterable<string>, upTo = Infinity): string[] {
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

  return migrations.filter((f) => !done.has(f) && Number(f.slice(0, 3)) <= upTo);
}

// Same guarantees as bai7: one transaction per file (all-or-nothing), advisory lock against concurrent runners.
export async function runMigrations(pool: Pool, dir: string, upTo = Infinity): Promise<string[]> {
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
      upTo,
    );

    for (const file of pending) {
      const sql = await readFile(join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        // Peak hour: never queue behind live traffic for long; fail fast and retry later instead.
        await client.query("SET LOCAL lock_timeout = '3s'");
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
