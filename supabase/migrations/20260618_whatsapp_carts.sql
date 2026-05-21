-- Loja Própria — recovery de carrinho abandonado (AB1).
--
-- Cliente que adiciona produtos no carrinho mas não conclui o checkout
-- vira candidato a recovery via WhatsApp. O frontend "pinga" este
-- backend a cada mudança de carrinho com snapshot { items, contato }.
--
-- Backend persiste 1 row por (org, identificador do cliente). Quando
-- o cron roda (15 em 15 min) ele encontra carts com:
--   - status = 'active'
--   - last_activity_at < now() - settings.minutes_after
--   - reminder_sent_at IS NULL
-- e dispara WhatsApp via Active bridge (mesmo path das notificações
-- transacionais).
--
-- Quando o cliente conclui um pedido (status='paid'), o hook em
-- payments.service procura o cart pelo email/phone e marca como
-- 'recovered' linkando o order_id (pra métrica do lojista).
--
-- Identificador do cliente: phone (preferido) ou email. Lookup case-
-- insensitive pra email.
--
-- Settings ficam em store_config.cart_recovery_settings (jsonb):
--   {
--     "enabled":          false,
--     "minutes_after":    30,
--     "message_template": "Oi {{name}}! ...",
--     "ttl_hours":        72
--   }

CREATE TABLE IF NOT EXISTS public.whatsapp_carts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  store_slug          text NOT NULL,

  -- Identificação do cliente (qualquer um dos dois precisa estar setado)
  customer_id         uuid REFERENCES public.storefront_customers(id) ON DELETE SET NULL,
  customer_phone      text,            -- dígitos puros (ex.: 5511999999999)
  customer_email      text,
  customer_name       text,

  -- Snapshot do carrinho
  items               jsonb NOT NULL DEFAULT '[]'::jsonb,
                       -- [{ productId, name, price, qty, imageUrl? }]
  subtotal            numeric(12, 2) NOT NULL DEFAULT 0,
  items_count         int NOT NULL DEFAULT 0,

  -- Estado / fluxo
  status              text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'sent_reminder', 'recovered', 'expired', 'dismissed')),
  last_activity_at    timestamptz NOT NULL DEFAULT now(),
  reminder_sent_at    timestamptz,
  reminder_dedup_key  text,           -- bridge dedup_key (pra não duplicar envio)
  recovered_order_id  uuid REFERENCES public.storefront_orders(id) ON DELETE SET NULL,
  recovered_at        timestamptz,

  -- Audit
  client_ip_hash      text,            -- SHA256 do IP pra detectar bots/spam
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Identificação preferencial por phone, fallback email — em ambos os casos
-- 1 row por (org, identificador) e atualizada via UPSERT pelo endpoint
-- de tracking.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_whatsapp_carts_phone
  ON public.whatsapp_carts (organization_id, customer_phone)
  WHERE customer_phone IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_whatsapp_carts_email
  ON public.whatsapp_carts (organization_id, lower(customer_email))
  WHERE customer_email IS NOT NULL AND customer_phone IS NULL;

-- Cron lookup: encontra ativos passíveis de envio
CREATE INDEX IF NOT EXISTS idx_whatsapp_carts_cron
  ON public.whatsapp_carts (organization_id, status, last_activity_at)
  WHERE status = 'active' AND reminder_sent_at IS NULL;

-- Dashboard lojista
CREATE INDEX IF NOT EXISTS idx_whatsapp_carts_dash
  ON public.whatsapp_carts (organization_id, status, updated_at DESC);

COMMENT ON TABLE  public.whatsapp_carts IS
  'Carrinhos abandonados da Loja Própria pra recovery via WhatsApp (AB1).';
COMMENT ON COLUMN public.whatsapp_carts.status IS
  'active=tracking | sent_reminder=lembrete enviado | recovered=virou pedido | expired=passou ttl | dismissed=cliente recusou.';
COMMENT ON COLUMN public.whatsapp_carts.reminder_dedup_key IS
  'Chave única passada ao Active bridge pra evitar reenvio do mesmo lembrete.';


-- Trigger updated_at + items_count
CREATE OR REPLACE FUNCTION public.tg_whatsapp_carts_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  NEW.items_count = CASE WHEN jsonb_typeof(NEW.items) = 'array'
                         THEN jsonb_array_length(NEW.items)
                         ELSE 0 END;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_whatsapp_carts_touch ON public.whatsapp_carts;
CREATE TRIGGER trg_whatsapp_carts_touch
  BEFORE INSERT OR UPDATE ON public.whatsapp_carts
  FOR EACH ROW EXECUTE FUNCTION public.tg_whatsapp_carts_touch();


-- Settings na store_config
ALTER TABLE public.store_config
  ADD COLUMN IF NOT EXISTS cart_recovery_settings jsonb NOT NULL DEFAULT
  '{"enabled":false,"minutes_after":30,"ttl_hours":72,"message_template":""}'::jsonb;

COMMENT ON COLUMN public.store_config.cart_recovery_settings IS
  'Config de recovery de carrinho: { enabled, minutes_after, ttl_hours, message_template }. Quando template vazio, usa default amigável.';


-- Grants (criação via _admin_exec_sql não herda)
GRANT ALL ON TABLE public.whatsapp_carts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.whatsapp_carts TO authenticated;
