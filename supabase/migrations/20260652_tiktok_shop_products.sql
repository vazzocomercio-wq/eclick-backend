-- 20260652_tiktok_shop_products.sql
-- Produtos importados do TikTok Shop — tabela ISOLADA (não toca em public.products).
-- v1 read-only: alimenta a geração de conteúdo (Fase 4). Só backend (service_role).

CREATE TABLE IF NOT EXISTS public.tiktok_shop_products (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL,
  shop_id           text,
  tts_product_id    text NOT NULL,
  title             text,
  status            text,
  sku_count         integer NOT NULL DEFAULT 0,
  main_image_url    text,
  raw               jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tiktok_shop_products_org_product
  ON public.tiktok_shop_products (organization_id, tts_product_id);

ALTER TABLE public.tiktok_shop_products ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public.tiktok_shop_products TO service_role;
