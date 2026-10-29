import express from 'express';
import type { Pool } from 'pg';
import type { FaultMode } from './config';
import { faultInjection } from './fault';
import { validateProductInput } from './validation';

export interface AppDeps {
  pool: Pool;
  appEnv: string;
  appVersion: string;
  fault?: FaultMode;
  isReady?: () => boolean;
}

export function createApp({ pool, appEnv, appVersion, fault = 'none', isReady = () => true }: AppDeps) {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.set('X-Version', appVersion);
    next();
  });

  // Liveness: the process is up.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Readiness: warm-up done and the database answers. Container healthcheck + deploy script use this.
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
    res.json({ version: appVersion, env: appEnv });
  });

  app.use('/products', faultInjection(fault));

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
