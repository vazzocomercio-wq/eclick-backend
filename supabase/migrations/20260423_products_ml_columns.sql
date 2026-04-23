-- Run in Supabase SQL Editor
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS ml_listing_id  text,
  ADD COLUMN IF NOT EXISTS ml_permalink   text,
  ADD COLUMN IF NOT EXISTS ml_catalog_id  text,
  ADD COLUMN IF NOT EXISTS images         jsonb DEFAULT '[]';

CREATE INDEX IF NOT EXISTS products_ml_listing_id_idx ON products(ml_listing_id);
