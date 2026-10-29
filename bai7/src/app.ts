import express from 'express';
import type { Pool } from 'pg';
import { validateProductInput } from './validation';

export interface AppDeps {
  pool: Pool;
  appEnv: string;
  appVersion: string;
}

export function createApp({ pool, appEnv, appVersion }: AppDeps) {
  const app = express();
  app.use(express.json());

  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', db: 'up' });
    } catch {
      res.status(503).json({ status: 'degraded', db: 'down' });
    }
  });

  // Lets the deploy script (and humans) confirm exactly which commit is serving traffic.
  app.get('/version', (_req, res) => {
    res.json({ version: appVersion, env: appEnv });
  });

  app.get('/products', async (_req, res, next) => {
    try {
      const { rows } = await pool.query('SELECT id, name, price, stock FROM products ORDER BY id');
      res.json(rows);
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
      const { name, price, stock } = result.value;
      const { rows } = await pool.query(
        'INSERT INTO products (name, price, stock) VALUES ($1, $2, $3) RETURNING id, name, price, stock',
        [name, price, stock],
      );
      res.status(201).json(rows[0]);
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
