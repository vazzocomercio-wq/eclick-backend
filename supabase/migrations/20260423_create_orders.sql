-- Run this in Supabase SQL Editor
CREATE TABLE IF NOT EXISTS orders (
  id                      uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  source                  text        NOT NULL DEFAULT 'manual',
  platform                text        NOT NULL DEFAULT 'manual',
  external_order_id       text,
  buyer_name              text,
  buyer_username          text,
  product_id              uuid        REFERENCES products(id) ON DELETE SET NULL,
  product_title           text,
  sku                     text,
  quantity                int         NOT NULL DEFAULT 1,
  sale_price              decimal(12,2),
  cost_price              decimal(12,2),
  platform_fee            decimal(12,2),
  shipping_cost           decimal(12,2),
  tax_amount              decimal(12,2),
  gross_profit            decimal(12,2),
  contribution_margin     decimal(12,2),
  contribution_margin_pct decimal(6,2),
  status                  text        NOT NULL DEFAULT 'pending',
  payment_method          text,
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orders_source_idx      ON orders(source);
CREATE INDEX IF NOT EXISTS orders_platform_idx    ON orders(platform);
CREATE INDEX IF NOT EXISTS orders_created_at_idx  ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS orders_product_id_idx  ON orders(product_id);
