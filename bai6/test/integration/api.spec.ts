// Integration tests: talk to a real Postgres and a real Redis.
// CI provides both as service containers; locally run `docker compose up -d db redis`.
import Redis from 'ioredis';
import type { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { createPool, migrate, seed } from '../../src/db';
import { PRODUCTS_CACHE_KEY } from '../../src/products';

const config = loadConfig();
let pool: Pool;
let redis: Redis;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  pool = createPool(config.databaseUrl);
  redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
  await migrate(pool);
  app = createApp({ pool, redis, cacheTtlSeconds: 60 });
});

beforeEach(async () => {
  await pool.query('TRUNCATE products RESTART IDENTITY');
  await seed(pool);
  await redis.del(PRODUCTS_CACHE_KEY);
});

afterAll(async () => {
  await Promise.allSettled([pool?.end(), redis?.quit()]);
});

describe('ShopFast API with Postgres + Redis', () => {
  it('GET /health reports both dependencies up', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'up', redis: 'up' });
  });

  it('GET /products reads from Postgres first, then serves from Redis', async () => {
    const first = await request(app).get('/products');
    expect(first.status).toBe(200);
    expect(first.headers['x-cache']).toBe('MISS');
    expect(first.body).toHaveLength(2);

    expect(await redis.exists(PRODUCTS_CACHE_KEY)).toBe(1);

    const second = await request(app).get('/products');
    expect(second.headers['x-cache']).toBe('HIT');
    expect(second.body).toEqual(first.body);
  });

  it('POST /products stores the product and invalidates the cache', async () => {
    await request(app).get('/products'); // warm the cache

    const created = await request(app).post('/products').send({ name: 'Tui deo cheo', price: 259000 });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: 3, name: 'Tui deo cheo', price: 259000 });
    expect(await redis.exists(PRODUCTS_CACHE_KEY)).toBe(0);

    const list = await request(app).get('/products');
    expect(list.headers['x-cache']).toBe('MISS');
    expect(list.body.map((p: { name: string }) => p.name)).toContain('Tui deo cheo');
  });

  it('POST /products rejects invalid input without touching the database', async () => {
    const res = await request(app).post('/products').send({ name: '', price: -5 });
    expect(res.status).toBe(400);
    expect(res.body.errors).toHaveLength(2);

    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM products');
    expect(rows[0].n).toBe(2);
  });
});
