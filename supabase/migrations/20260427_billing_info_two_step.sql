-- Marketplace Buyer Enrichment — 2-step billing_info flow
-- ML now exposes billing in two endpoints:
--   1. GET /orders/{id}                              → buyer.billing_info.id
--   2. GET /orders/billing-info/MLB/{billing_info_id} → identification + name + address
-- Legacy /orders/{id}/billing_info kept as fallback.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS buyer_billing_info_id TEXT,
  ADD COLUMN IF NOT EXISTS buyer_last_name      TEXT,
  ADD COLUMN IF NOT EXISTS billing_address      JSONB,
  ADD COLUMN IF NOT EXISTS billing_country      TEXT DEFAULT 'BR';

CREATE INDEX IF NOT EXISTS idx_orders_buyer_billing_info_id
  ON orders(buyer_billing_info_id) WHERE buyer_billing_info_id IS NOT NULL;
