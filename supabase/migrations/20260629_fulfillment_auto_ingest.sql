-- F12 Fulfillment Sprint 1 — ingestão automática.
--
-- Pedido pago (Mercado Livre via webhook orders_v2, ou Loja Própria via webhook
-- de pagamento) passa a criar o fulfillment_order + tasks AUTOMATICAMENTE, em vez
-- do seed manual. Opt-in por org (OFF por padrão — mesmo padrão dos outros toggles).

ALTER TABLE public.fulfillment_settings
  ADD COLUMN IF NOT EXISTS auto_ingest_enabled  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_ingest_sources  text[]  NOT NULL DEFAULT '{marketplace,storefront}'::text[],
  ADD COLUMN IF NOT EXISTS default_warehouse_id uuid REFERENCES public.warehouses(id);

COMMENT ON COLUMN public.fulfillment_settings.auto_ingest_enabled IS
  'Se true, pedido pago (ML/loja/b2b) vira fila de separação automaticamente. Opt-in por org.';
COMMENT ON COLUMN public.fulfillment_settings.auto_ingest_sources IS
  'Quais origens auto-ingerem: marketplace, storefront, b2b.';
COMMENT ON COLUMN public.fulfillment_settings.default_warehouse_id IS
  'CD destino da auto-ingestão. NULL = usa o primeiro CD ativo da org.';
