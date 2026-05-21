-- Audit de promoções de tier no programa de fidelidade.
--
-- Cada vez que um cliente sobe de nível (recordPurchase detecta
-- current_tier_id != tier resolvido), uma row é inserida aqui.
-- Permite:
--  - Dashboard "Promoções recentes" (motivação visual)
--  - Histórico do cliente
--  - Trigger futuro pra email/WhatsApp ("você virou Ouro!")

CREATE TABLE IF NOT EXISTS public.loyalty_promotions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  customer_identifier text NOT NULL,                                            -- email lowercase
  previous_tier_id    uuid REFERENCES public.loyalty_tiers(id) ON DELETE SET NULL, -- pode ser NULL (primeira vez)
  new_tier_id         uuid NOT NULL REFERENCES public.loyalty_tiers(id) ON DELETE CASCADE,
  triggered_by_order_id uuid REFERENCES public.storefront_orders(id) ON DELETE SET NULL,
  total_spent_cents   integer NOT NULL DEFAULT 0,
  promoted_at         timestamptz NOT NULL DEFAULT now(),

  -- Notificações: marker pra evitar reenvio quando integrar
  -- email/WhatsApp no futuro
  notified_at         timestamptz,
  notification_channel text  -- 'email' | 'whatsapp' | null
);

CREATE INDEX IF NOT EXISTS idx_loyalty_promotions_org_recent
  ON public.loyalty_promotions (organization_id, promoted_at DESC);

CREATE INDEX IF NOT EXISTS idx_loyalty_promotions_customer
  ON public.loyalty_promotions (organization_id, customer_identifier, promoted_at DESC);

CREATE INDEX IF NOT EXISTS idx_loyalty_promotions_unnotified
  ON public.loyalty_promotions (organization_id, promoted_at)
  WHERE notified_at IS NULL;

COMMENT ON TABLE public.loyalty_promotions IS
  'Audit de subidas de tier no programa de fidelidade. 1 row por promoção.';

GRANT ALL ON TABLE public.loyalty_promotions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.loyalty_promotions TO authenticated;
