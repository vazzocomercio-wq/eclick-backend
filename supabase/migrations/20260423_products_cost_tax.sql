-- Run in Supabase SQL Editor
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS cost_price     decimal(12,2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS tax_percentage decimal(6,2)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS tax_on_freight boolean       DEFAULT false;
