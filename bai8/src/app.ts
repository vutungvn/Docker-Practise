import express from 'express';
import type { Pool } from 'pg';
import type { Release } from './config';
import { productRepo } from './products';

export interface AppDeps {
  pool: Pool;
  release: Release;
  color: string;
  schemaTarget: number;
  isReady: () => boolean;
}

export function createApp({ pool, release, color, schemaTarget, isReady }: AppDeps) {
  const app = express();
  const products = productRepo(pool, release);
  app.use(express.json());
  app.use((req, res, next) => {
    res.set('X-Served-By', `${release}-${color}`);
    // While warming up (the 25 s) or shutting down, a container cannot do real work yet/any more.
    if (!isReady() && !['/health', '/ready', '/version'].includes(req.path)) {
      res.status(503).set('Retry-After', '1').json({ error: 'warming up or shutting down' });
      return;
    }
    next();
  });

  // Liveness: the process is up.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Readiness: warm-up finished and the database answers. Used by the container healthcheck,
  // so a color only counts as started once all of its containers can take traffic.
  app.get('/ready', async (_req, res) => {
    if (!isReady()) {
      res.status(503).json({ ready: false });
      return;
    }
    try {
      await pool.query('SELECT 1');
      res.json({ ready: true });
    } catch {
      res.status(503).json({ ready: false, db: 'down' });
    }
  });

  app.get('/version', (_req, res) => {
    res.json({ version: release, color, schemaTarget });
  });

  app.get('/products', async (_req, res, next) => {
    try {
      res.json(await products.list());
    } catch (err) {
      next(err);
    }
  });

  app.post('/products', async (req, res, next) => {
    const { name, price } = req.body ?? {};
    if (typeof name !== 'string' || !name.trim() || !Number.isInteger(price) || price < 0) {
      res.status(400).json({ error: 'name (string) and price (non-negative integer) are required' });
      return;
    }
    try {
      res.status(201).json(await products.create(name.trim(), price));
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
