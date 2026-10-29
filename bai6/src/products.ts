import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { ProductInput } from './validation';

export interface Product {
  id: number;
  name: string;
  price: number;
}

export const PRODUCTS_CACHE_KEY = 'shopfast:products:all';

// Cache-aside: read from Redis first, fall back to Postgres and fill the cache.
export class ProductService {
  constructor(
    private readonly pool: Pool,
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
  ) {}

  async list(): Promise<{ source: 'cache' | 'db'; items: Product[] }> {
    const cached = await this.redis.get(PRODUCTS_CACHE_KEY);
    if (cached) return { source: 'cache', items: JSON.parse(cached) };

    const { rows } = await this.pool.query<Product>('SELECT id, name, price FROM products ORDER BY id');
    await this.redis.set(PRODUCTS_CACHE_KEY, JSON.stringify(rows), 'EX', this.ttlSeconds);
    return { source: 'db', items: rows };
  }

  async create(input: ProductInput): Promise<Product> {
    const { rows } = await this.pool.query<Product>(
      'INSERT INTO products (name, price) VALUES ($1, $2) RETURNING id, name, price',
      [input.name, input.price],
    );
    // The cached list is now stale.
    await this.redis.del(PRODUCTS_CACHE_KEY);
    return rows[0];
  }
}
