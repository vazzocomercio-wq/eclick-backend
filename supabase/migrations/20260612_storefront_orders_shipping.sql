-- Loja Própria — tracking de entrega.
--
-- Adiciona colunas pra acompanhar status físico do pedido após pagamento:
--   - shipping_status: 'pending', 'preparing', 'shipped', 'in_transit',
--                       'delivered', 'returned', 'lost'
--   - shipping_carrier: text livre (Correios, Jadlog, transportadora local)
--   - tracking_code: código de rastreio do carrier
--   - shipped_at / delivered_at: timestamps de transições
--
-- Default 'pending' pra todos os existentes (lojista marca manualmente
-- via dashboard). Cron de cashback after_delivery checa
-- shipping_status='delivered' pra creditar.

ALTER TABLE public.storefront_orders
  ADD COLUMN IF NOT EXISTS shipping_status text NOT NULL DEFAULT 'pending'
  CHECK (shipping_status IN ('pending', 'preparing', 'shipped', 'in_transit', 'delivered', 'returned', 'lost'));

ALTER TABLE public.storefront_orders ADD COLUMN IF NOT EXISTS shipping_carrier text;
ALTER TABLE public.storefront_orders ADD COLUMN IF NOT EXISTS tracking_code    text;
ALTER TABLE public.storefront_orders ADD COLUMN IF NOT EXISTS shipped_at       timestamptz;
ALTER TABLE public.storefront_orders ADD COLUMN IF NOT EXISTS delivered_at     timestamptz;

CREATE INDEX IF NOT EXISTS idx_storefront_orders_shipping
  ON public.storefront_orders (organization_id, shipping_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_storefront_orders_delivered
  ON public.storefront_orders (organization_id, delivered_at DESC)
  WHERE shipping_status = 'delivered';

COMMENT ON COLUMN public.storefront_orders.shipping_status IS
  'Status físico do pedido: pending→preparing→shipped→in_transit→delivered.';
COMMENT ON COLUMN public.storefront_orders.tracking_code IS
  'Código de rastreio do carrier (Correios SEDEX, etc).';
