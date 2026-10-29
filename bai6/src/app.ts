import express from 'express';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { ProductService } from './products';
import { validateProductInput } from './validation';

export interface AppDeps {
  pool: Pool;
  redis: Redis;
  cacheTtlSeconds: number;
}

export function createApp({ pool, redis, cacheTtlSeconds }: AppDeps) {
  const app = express();
  const products = new ProductService(pool, redis, cacheTtlSeconds);
  app.use(express.json());

  app.get('/health', async (_req, res) => {
    const [db, cache] = await Promise.allSettled([pool.query('SELECT 1'), redis.ping()]);
    const status = {
      db: db.status === 'fulfilled' ? 'up' : 'down',
      redis: cache.status === 'fulfilled' ? 'up' : 'down',
    };
    const healthy = status.db === 'up' && status.redis === 'up';
    res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', ...status });
  });

  app.get('/products', async (_req, res, next) => {
    try {
      const { source, items } = await products.list();
      res.set('X-Cache', source === 'cache' ? 'HIT' : 'MISS').json(items);
    } catch (err) {
      next(err);
    }
  });

  app.post('/products', async (req, res, next) => {
    const result = validateProductInput(req.body);
    if (!result.ok) {
      res.status(400).json({ errors: result.errors });
      return;
    }
    try {
      res.status(201).json(await products.create(result.value));
    } catch (err) {
      next(err);
    }
  });

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(`[shopfast] ${err.message}`);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
