// Runs migrations up to the schema target of this image (SCHEMA_TARGET can raise it for the contract step).
import { join } from 'node:path';
import { loadConfig } from './config';
import { createPool } from './db';
import { runMigrations } from './migrate';

async function main() {
  const { databaseUrl, schemaTarget, release } = loadConfig();
  const pool = createPool(databaseUrl);
  try {
    const applied = await runMigrations(pool, join(__dirname, '..', 'migrations'), schemaTarget);
    console.log(
      `[migrate ${release}] ` +
        (applied.length ? `applied: ${applied.join(', ')}` : `schema already at ${schemaTarget}`),
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`[migrate] ${(err as Error).message}`);
  process.exit(1);
});
