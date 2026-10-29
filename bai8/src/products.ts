import type { Pool } from 'pg';
import type { Release } from './config';

export interface Product {
  id: number;
  name: string;
  price: number;
}

// v1 reads/writes the old column, v2 the new one. During blue/green both run against the same table;
// the trigger from migration 002 keeps the two columns identical whichever version writes.
const PRICE_COLUMN: Record<Release, string> = { v1: 'price', v2: 'price_vnd' };

export function productRepo(pool: Pool, release: Release) {
  const price = PRICE_COLUMN[release];
  return {
    async list(): Promise<Product[]> {
      const { rows } = await pool.query(`SELECT id, name, ${price} AS price FROM products ORDER BY id`);
      return rows;
    },
    async create(name: string, value: number): Promise<Product> {
      const { rows } = await pool.query(
        `INSERT INTO products (name, ${price}) VALUES ($1, $2) RETURNING id, name, ${price} AS price`,
        [name, value],
      );
      return rows[0];
    },
  };
}
