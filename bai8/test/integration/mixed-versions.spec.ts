// Trap 1: during blue/green v1 (old) and v2 (new) run against the same database at the same time.
// Needs a Postgres: `docker compose up -d --wait db`, then DATABASE_URL=... npm run test:integration
import { join } from 'node:path';
import { Pool } from 'pg';
import { loadConfig } from '../../src/config';
import { runMigrations } from '../../src/migrate';
import { productRepo } from '../../src/products';

const MIGRATIONS = join(__dirname, '..', '..', 'migrations');
const SCHEMA = 'it_mixed_versions';
let pool: Pool;

beforeAll(async () => {
  const { databaseUrl } = loadConfig();
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  await admin.end();
  pool = new Pool({ connectionString: databaseUrl, max: 5, options: `-c search_path=${SCHEMA}` });
});

afterAll(async () => {
  await pool.end();
});

const v1 = () => productRepo(pool, 'v1');
const v2 = () => productRepo(pool, 'v2');
const byName = async (repo: ReturnType<typeof productRepo>, name: string) =>
  (await repo.list()).find((p) => p.name === name)?.price;

// The tests run in order and walk through the phases of one release.
describe('expand / contract while v1 and v2 run side by side', () => {
  it('phase 0: only v1 and schema 001', async () => {
    await runMigrations(pool, MIGRATIONS, 1);
    await v1().create('Truoc khi deploy', 1000);
    expect(await byName(v1(), 'Truoc khi deploy')).toBe(1000);
  });

  it('phase 1 (expand, before green starts): v1 keeps working unchanged', async () => {
    expect(await runMigrations(pool, MIGRATIONS, 2)).toEqual(['002_expand_price_vnd.sql']);
    await v1().create('v1 sau expand', 2000);
    expect(await byName(v1(), 'v1 sau expand')).toBe(2000);
  });

  it('phase 2 (both live): every write from either version is visible to the other', async () => {
    // existing rows were backfilled
    expect(await byName(v2(), 'Truoc khi deploy')).toBe(1000);
    // v1 -> v2
    await v1().create('Ghi boi v1', 111);
    expect(await byName(v2(), 'Ghi boi v1')).toBe(111);
    // v2 -> v1
    await v2().create('Ghi boi v2', 222);
    expect(await byName(v1(), 'Ghi boi v2')).toBe(222);
    // updates through either column stay in sync
    await pool.query("UPDATE products SET price = 333 WHERE name = 'Ghi boi v2'");
    expect(await byName(v2(), 'Ghi boi v2')).toBe(333);
    await pool.query("UPDATE products SET price_vnd = 444 WHERE name = 'Ghi boi v1'");
    expect(await byName(v1(), 'Ghi boi v1')).toBe(444);
  });

  it('phase 3 (rollback to v1): v1 sees everything v2 wrote, nothing to undo in the schema', async () => {
    const all = await v1().list();
    expect(all.map((p) => p.name)).toEqual(
      expect.arrayContaining(['Ghi boi v1', 'Ghi boi v2', 'v1 sau expand', 'Truoc khi deploy']),
    );
    expect(all.every((p) => typeof p.price === 'number')).toBe(true);
  });

  it('phase 4 (contract, next release): v2 keeps working, v1 would break - hence the guard', async () => {
    expect(await runMigrations(pool, MIGRATIONS, 3)).toEqual(['003_contract_drop_price.sql']);
    await v2().create('Sau contract', 555);
    expect(await byName(v2(), 'Sau contract')).toBe(555);
    await expect(v1().list()).rejects.toThrow('column "price" does not exist');
  });
});
