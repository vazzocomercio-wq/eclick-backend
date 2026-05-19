-- Loja Propria — Frente C: pedidos transacionais.
--
-- Cria a tabela `storefront_orders` que guarda cada pedido feito pela
-- vitrine publica /loja/[slug] antes do redirect pro gateway (Mercado
-- Pago ou Stripe). Snapshot dos items eh feito aqui — quando o gateway
-- voltar via webhook, atualizamos status + gateway_payment_id.
--
-- Multi-tenant: organization_id NOT NULL + index composto. store_slug
-- duplicado pra lookup publico sem precisar join com store_config.
--
-- Grants explicitos no fim (tabelas criadas via _admin_exec_sql NAO
-- herdam default privileges — bug recorrente).

CREATE TABLE IF NOT EXISTS public.storefront_orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  store_slug          text NOT NULL,

  customer            jsonb NOT NULL,          -- { name, email, phone, doc?, address?, notes? }
  items               jsonb NOT NULL,          -- [{ productId, name, price, qty, imageUrl? }]
  subtotal            numeric(12, 2) NOT NULL,
  shipping            numeric(12, 2) NOT NULL DEFAULT 0,
  total               numeric(12, 2) NOT NULL,

  gateway             text,                    -- 'mercadopago' | 'stripe' | NULL (whatsapp only)
  gateway_session_id  text,                    -- MP preference id / Stripe checkout session id
  gateway_payment_id  text,                    -- id final do pagamento confirmado
  gateway_init_point  text,                    -- URL pra redirect (cache pra reuso)

  status              text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'awaiting_payment', 'paid', 'failed', 'cancelled', 'expired', 'refunded')),

  raw_callback        jsonb,                   -- payload completo do webhook (audit)

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.storefront_orders IS
  'Pedidos da Loja Propria (vitrine /loja/[slug]). Snapshot do carrinho + dados do cliente antes do gateway. Atualizado por webhook.';
COMMENT ON COLUMN public.storefront_orders.gateway IS
  'Gateway escolhido: mercadopago, stripe, ou NULL quando o checkout foi feito direto pelo WhatsApp.';
COMMENT ON COLUMN public.storefront_orders.gateway_session_id IS
  'Mercado Pago: preference.id. Stripe: checkout.session.id. Usado pra match no webhook.';
COMMENT ON COLUMN public.storefront_orders.raw_callback IS
  'Payload completo do webhook do gateway (auditoria).';

-- Lookup principal: org + status + recente
CREATE INDEX IF NOT EXISTS idx_storefront_orders_org_status
  ON public.storefront_orders (organization_id, status, created_at DESC);

-- Lookup do webhook por session_id
CREATE INDEX IF NOT EXISTS idx_storefront_orders_session
  ON public.storefront_orders (gateway, gateway_session_id)
  WHERE gateway_session_id IS NOT NULL;

-- Lookup publico por slug (relatorios da loja, etc)
CREATE INDEX IF NOT EXISTS idx_storefront_orders_slug
  ON public.storefront_orders (store_slug, created_at DESC);

-- Trigger pra manter updated_at
CREATE OR REPLACE FUNCTION public.tg_storefront_orders_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_storefront_orders_touch ON public.storefront_orders;
CREATE TRIGGER trg_storefront_orders_touch
  BEFORE UPDATE ON public.storefront_orders
  FOR EACH ROW EXECUTE FUNCTION public.tg_storefront_orders_touch();

-- Grants (criação via dashboard / _admin_exec_sql nao herda)
GRANT ALL ON TABLE public.storefront_orders TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.storefront_orders TO authenticated;
