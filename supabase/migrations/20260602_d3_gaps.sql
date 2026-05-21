-- Store Builder v3 — Gaps D.3.
--
-- 1. tiktok_pixel_id em store_config (alem de google_analytics_id,
--    meta_pixel_id, gtm_id ja existentes).
-- 2. customer_id em storefront_orders (FK pra unified_customers — soft
--    link, sem cascade pra nao apagar pedidos quando contato e merged).

ALTER TABLE public.store_config
  ADD COLUMN IF NOT EXISTS tiktok_pixel_id text;

ALTER TABLE public.storefront_orders
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES public.unified_customers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS storefront_orders_customer_id_idx
  ON public.storefront_orders (customer_id);

COMMENT ON COLUMN public.store_config.tiktok_pixel_id IS 'TikTok Pixel ID — injetado no <head> da vitrine SSR.';
COMMENT ON COLUMN public.storefront_orders.customer_id IS 'FK pra unified_customers — preenchido no checkout quando cliente identificado.';
