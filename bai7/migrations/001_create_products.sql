CREATE TABLE products (
  id         SERIAL PRIMARY KEY,
  name       TEXT        NOT NULL,
  price      INTEGER     NOT NULL CHECK (price >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO products (name, price) VALUES
  ('Ao thun ShopFast', 149000),
  ('Non luoi trai', 99000);
