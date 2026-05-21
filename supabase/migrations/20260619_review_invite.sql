-- Loja Própria — convite pra avaliar pós-entrega (AE1).
--
-- Cron diário acha pedidos com:
--   - status = 'paid'
--   - shipping_status = 'delivered'
--   - delivered_at <= now() - review_settings.ask_after_days
--   - review_invite_sent_at IS NULL
-- e manda 1 WhatsApp convidando o cliente a avaliar os produtos do
-- pedido (deep link pra /conta, que lista o que pode ser avaliado).
--
-- review_invite_sent_at marca o envio pra não duplicar.

ALTER TABLE public.storefront_orders
  ADD COLUMN IF NOT EXISTS review_invite_sent_at timestamptz;

-- Lookup do cron: pedidos entregues sem convite enviado
CREATE INDEX IF NOT EXISTS idx_storefront_orders_review_invite
  ON public.storefront_orders (organization_id, delivered_at)
  WHERE status = 'paid'
    AND shipping_status = 'delivered'
    AND review_invite_sent_at IS NULL;

COMMENT ON COLUMN public.storefront_orders.review_invite_sent_at IS
  'Quando o convite pra avaliar (WhatsApp pós-entrega) foi disparado. NULL = ainda não enviado.';

-- Garante que review_settings tenha invite_enabled no default das lojas
-- novas (lojas existentes ganham o campo via merge no service).
ALTER TABLE public.store_config
  ALTER COLUMN review_settings SET DEFAULT
  '{"auto_approve":false,"min_body_chars":20,"max_photos":3,"ask_after_days":3,"hide_customer_full_name":true,"invite_enabled":false}'::jsonb;
