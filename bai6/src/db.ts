import { Pool } from 'pg';

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 5 });
}

export async function migrate(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id    SERIAL PRIMARY KEY,
      name  TEXT    NOT NULL,
      price INTEGER NOT NULL CHECK (price >= 0)
    )
  `);
}

// Insert the starter catalog only when the table is empty.
export async function seed(pool: Pool): Promise<void> {
  await pool.query(`
    INSERT INTO products (name, price)
    SELECT * FROM (VALUES ('Ao thun ShopFast', 149000), ('Non luoi trai', 99000)) AS v(name, price)
    WHERE NOT EXISTS (SELECT 1 FROM products)
  `);
}
