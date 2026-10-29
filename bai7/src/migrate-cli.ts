// Run by deploy.sh as a separate step *before* the new version receives traffic.
import { join } from 'node:path';
import { loadConfig } from './config';
import { createPool } from './db';
import { runMigrations } from './migrate';

async function main() {
  const pool = createPool(loadConfig().databaseUrl);
  try {
    const applied = await runMigrations(pool, join(__dirname, '..', 'migrations'));
    console.log(
      applied.length ? `[migrate] applied: ${applied.join(', ')}` : '[migrate] schema already up to date',
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`[migrate] ${(err as Error).message}`);
  process.exit(1);
});
