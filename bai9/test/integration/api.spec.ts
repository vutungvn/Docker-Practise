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
  it('GET /health (liveness) and GET /ready (readiness) are ok', async () => {
    expect((await request(app).get('/health')).body).toEqual({ status: 'ok' });
    const ready = await request(app).get('/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ ready: true });
  });

  it('GET /ready is 503 while warming up', async () => {
    const warming = createApp({ pool, appEnv: 'test', appVersion: 'x', isReady: () => false });
    expect((await request(warming).get('/ready')).status).toBe(503);
  });

  it('GET /ready is 503 and /products 500 when the database is gone', async () => {
    const deadPool = await freshSchema('it_api_dead');
    await deadPool.end();
    const broken = createApp({ pool: deadPool, appEnv: 'test', appVersion: 'x' });
    expect((await request(broken).get('/ready')).body).toEqual({ ready: false, db: 'down' });
    expect((await request(broken).get('/products')).status).toBe(500);
    expect((await request(broken).post('/products').send({ name: 'A', price: 1 })).status).toBe(500);
  });

  it('an injected fault makes catalog requests fail (what the post-deploy check catches)', async () => {
    const faulty = createApp({ pool, appEnv: 'test', appVersion: 'x', fault: 'errors' });
    const statuses = await Promise.all(Array.from({ length: 40 }, () => request(faulty).get('/products')));
    expect(statuses.some((r) => r.status === 500)).toBe(true);
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
