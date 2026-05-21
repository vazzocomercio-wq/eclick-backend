-- Programa de Fidelidade para Loja Própria.
--
-- Modelo:
--  1. `store_config.loyalty_settings` (JSONB) — config global do programa
--     (enabled, currency_label, pointsPerReal opcional, etc).
--  2. `loyalty_tiers` — níveis configuráveis. Cada nível tem name,
--     min_spent_cents, color, benefits[] (JSON livre).
--  3. `customer_loyalty` — saldo agregado por (org, customer_email).
--     Inclui total_spent_cents (soma de pedidos pagos), current_tier_id
--     (recalculado quando muda) e points (futuro — segundo eixo).
--
-- Fluxo:
--   - Cliente paga pedido → CashbackService.credit (já existe) e
--     LoyaltyService.recordPurchase (novo). Recálculo de tier idempotente.
--   - Cliente abre vitrine → backend resolve tier do email → frontend
--     mostra badge "Cliente Ouro" + benefícios disponíveis.

ALTER TABLE public.store_config
  ADD COLUMN IF NOT EXISTS loyalty_settings JSONB
  DEFAULT '{
    "enabled":        false,
    "currencyLabel":  "pontos",
    "pointsPerReal":  1
  }'::jsonb;

UPDATE public.store_config
   SET loyalty_settings = '{
     "enabled":        false,
     "currencyLabel":  "pontos",
     "pointsPerReal":  1
   }'::jsonb
 WHERE loyalty_settings IS NULL;

-- ── Tiers ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.loyalty_tiers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  name                text NOT NULL,                     -- "Bronze", "Prata", "Ouro", "Diamante"
  description         text,
  color               text NOT NULL DEFAULT '#a1a1aa',   -- cor do badge
  icon_emoji          text DEFAULT '⭐',                  -- emoji do badge ("🥉", "🥈", "🥇")
  min_spent_cents     integer NOT NULL DEFAULT 0,        -- soma total de compras pagas necessária
  benefits            jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{ label: "5% off", icon: "💰" }]
  display_order       integer NOT NULL DEFAULT 0,        -- ordem visual (asc)

  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_loyalty_tiers_org_order
  ON public.loyalty_tiers (organization_id, display_order ASC, min_spent_cents ASC);

COMMENT ON TABLE public.loyalty_tiers IS
  'Níveis do programa de fidelidade (bronze/prata/ouro configuráveis por loja).';

-- ── Customer balance ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.customer_loyalty (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  customer_identifier text NOT NULL,                    -- email lowercase

  total_spent_cents   integer NOT NULL DEFAULT 0,        -- soma de pedidos pagos
  order_count         integer NOT NULL DEFAULT 0,        -- N pedidos pagos
  current_tier_id     uuid REFERENCES public.loyalty_tiers(id) ON DELETE SET NULL,
  points              integer NOT NULL DEFAULT 0,        -- futuro: 2º eixo de fidelidade

  last_purchase_at    timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_customer_loyalty_org_customer
  ON public.customer_loyalty (organization_id, customer_identifier);

COMMENT ON TABLE public.customer_loyalty IS
  'Saldo de fidelidade por cliente (tier atual + total gasto).';

-- Triggers de updated_at
CREATE OR REPLACE FUNCTION public.tg_loyalty_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_loyalty_tiers_touch ON public.loyalty_tiers;
CREATE TRIGGER trg_loyalty_tiers_touch
  BEFORE UPDATE ON public.loyalty_tiers
  FOR EACH ROW EXECUTE FUNCTION public.tg_loyalty_touch();

DROP TRIGGER IF EXISTS trg_customer_loyalty_touch ON public.customer_loyalty;
CREATE TRIGGER trg_customer_loyalty_touch
  BEFORE UPDATE ON public.customer_loyalty
  FOR EACH ROW EXECUTE FUNCTION public.tg_loyalty_touch();

GRANT ALL ON TABLE public.loyalty_tiers      TO service_role;
GRANT ALL ON TABLE public.customer_loyalty   TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.loyalty_tiers      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.customer_loyalty   TO authenticated;
