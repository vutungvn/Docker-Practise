import { join } from 'node:path';
import { Pool } from 'pg';
import { loadConfig } from '../../src/config';

export const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');
export const FIXTURES_DIR = join(__dirname, '..', 'fixtures');

const { databaseUrl } = loadConfig();

// Each suite gets its own empty schema, so suites cannot see each other's tables.
export async function freshSchema(schema: string): Promise<Pool> {
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  return new Pool({ connectionString: databaseUrl, max: 5, options: `-c search_path=${schema}` });
}

export async function tableExists(pool: Pool, table: string): Promise<boolean> {
  const { rows } = await pool.query('SELECT to_regclass($1) IS NOT NULL AS found', [table]);
  return rows[0].found;
}

export async function appliedVersions(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
  return rows.map((r) => r.version);
}
