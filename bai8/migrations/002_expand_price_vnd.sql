-- EXPAND (release v2): rename products.price -> price_vnd without breaking v1, which keeps running
-- next to v2 during blue/green and must stay usable as the rollback target.
--
--   * add the new column (nullable, no default => metadata-only change, no table rewrite, short lock)
--   * copy existing values
--   * a trigger keeps both columns identical, whichever version writes:
--       v1 writes price      -> price_vnd follows
--       v2 writes price_vnd  -> price follows (price is still NOT NULL for v1)
-- The old column is only dropped by 003 (contract), in a later release, once no v1 container is left.

ALTER TABLE products ADD COLUMN price_vnd INTEGER CHECK (price_vnd >= 0);

UPDATE products SET price_vnd = price WHERE price_vnd IS NULL;

CREATE FUNCTION products_sync_price() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.price_vnd := COALESCE(NEW.price_vnd, NEW.price);
    NEW.price     := COALESCE(NEW.price, NEW.price_vnd);
  ELSIF NEW.price IS DISTINCT FROM OLD.price THEN
    NEW.price_vnd := NEW.price;
  ELSIF NEW.price_vnd IS DISTINCT FROM OLD.price_vnd THEN
    NEW.price := NEW.price_vnd;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER products_sync_price
  BEFORE INSERT OR UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION products_sync_price();
