import request from 'supertest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';

const env = { DATABASE_URL: 'postgres://u:p@db:5432/test', JWT_SECRET: 'test-secret' };

describe('ShopFast API', () => {
  it('GET /health reports ok without leaking secrets', async () => {
    const res = await request(createApp(loadConfig(env))).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(JSON.stringify(res.body)).not.toContain('test-secret');
  });

  it('GET /products returns the catalog', async () => {
    const res = await request(createApp(loadConfig(env))).get('/products');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it('loadConfig fails fast when secrets are missing', () => {
    expect(() => loadConfig({})).toThrow('DATABASE_URL, JWT_SECRET');
  });
});
