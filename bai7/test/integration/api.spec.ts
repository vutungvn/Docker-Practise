import type { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app';
import { runMigrations } from '../../src/migrate';
import { freshSchema, MIGRATIONS_DIR } from './helpers';

let pool: Pool;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  pool = await freshSchema('it_api');
  await runMigrations(pool, MIGRATIONS_DIR);
  app = createApp({ pool, appEnv: 'test', appVersion: 'abc1234' });
});

afterEach(async () => {
  await pool.end();
});

describe('ShopFast API on a migrated Postgres', () => {
  it('GET /health reports the database up', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'up' });
  });

  it('GET /version reports the deployed commit and environment', async () => {
    const res = await request(app).get('/version');
    expect(res.body).toEqual({ version: 'abc1234', env: 'test' });
  });

  it('GET /products returns the seeded catalog with stock', async () => {
    const res = await request(app).get('/products');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: 1, name: 'Ao thun ShopFast', price: 149000, stock: 0 },
      { id: 2, name: 'Non luoi trai', price: 99000, stock: 0 },
    ]);
  });

  it('POST /products stores a product', async () => {
    const res = await request(app).post('/products').send({ name: 'Tui deo cheo', price: 259000, stock: 5 });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 3, name: 'Tui deo cheo', price: 259000, stock: 5 });
  });

  it('POST /products rejects invalid input', async () => {
    const res = await request(app).post('/products').send({ name: '', price: -5 });
    expect(res.status).toBe(400);
    expect(res.body.errors).toHaveLength(2);
  });
});
