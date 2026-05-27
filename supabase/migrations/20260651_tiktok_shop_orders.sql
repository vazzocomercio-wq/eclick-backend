-- 20260651_tiktok_shop_orders.sql
-- Pedidos importados do TikTok Shop — tabela ISOLADA (não toca em public.orders
-- da operação). v1: captura/valida os pedidos reais; o mapeamento pro modelo
-- unificado da operação é refinamento posterior. Só backend (service_role).

CREATE TABLE IF NOT EXISTS public.tiktok_shop_orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL,
  shop_id           text,
  tts_order_id      text NOT NULL,
  order_status      text,
  buyer_message     text,
  recipient_name    text,
  total_amount      text,
  currency          text,
  line_item_count   integer NOT NULL DEFAULT 0,
  tts_create_time   bigint,
  tts_update_time   bigint,
  raw               jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tiktok_shop_orders_org_order
  ON public.tiktok_shop_orders (organization_id, tts_order_id);

CREATE INDEX IF NOT EXISTS idx_tiktok_shop_orders_org_created
  ON public.tiktok_shop_orders (organization_id, tts_create_time DESC);

ALTER TABLE public.tiktok_shop_orders ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public.tiktok_shop_orders TO service_role;
