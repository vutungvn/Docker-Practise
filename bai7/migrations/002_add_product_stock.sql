-- Expand-only change: a new column with a default. Code from the previous release never reads it,
-- so rolling the app back does not require undoing this migration.
ALTER TABLE products ADD COLUMN stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0);
