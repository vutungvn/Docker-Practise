import express from 'express';
import { AppConfig } from './config';

const products = [
  { id: 1, name: 'Ao thun ShopFast', price: 149000 },
  { id: 2, name: 'Non luoi trai', price: 99000 },
];

export function createApp(config: AppConfig) {
  const app = express();

  app.get('/health', (_req, res) => {
    // Never echo secrets back; only report whether they were provided.
    res.json({
      status: 'ok',
      version: 'v1',
      env: config.nodeEnv,
      databaseConfigured: Boolean(config.databaseUrl),
      jwtConfigured: Boolean(config.jwtSecret),
    });
  });

  app.get('/products', (_req, res) => {
    res.json(products);
  });

  return app;
}
