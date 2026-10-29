-- CONTRACT (next release, NOT part of the peak-hour deploy): run only when no v1 container exists any more
-- and rolling back to v1 is no longer an option. blue-green.sh `contract` enforces this.
DROP TRIGGER products_sync_price ON products;
DROP FUNCTION products_sync_price();
ALTER TABLE products ALTER COLUMN price_vnd SET NOT NULL;
ALTER TABLE products DROP COLUMN price;
