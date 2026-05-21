-- Cashback inteligente para Loja Própria.
--
-- Modelo:
--  1. `store_config.cashback_settings` (JSONB) — config da loja:
--       enabled, earnPct, expirationDays, minBalanceToUseCents,
--       maxRedemptionPctPerOrder, earnDelay.
--  2. `customer_cashback_balances` — saldo agregado por (org, email).
--       Identificador é email lowercase (a vitrine não tem auth ainda —
--       cliente identifica via email no checkout). Quando criarmos
--       customer_id próprio, dá pra migrar via UPDATE com lookup.
--  3. `customer_cashback_movements` — ledger imutável (earn, redeem,
--       expire, adjustment). Idempotência via UNIQUE (org, source_id)
--       — o webhook do gateway pode reentregar sem creditar 2x.
--
-- Fluxo:
--   - Pedido marcado como `paid` → CashbackService.credit(...)
--     cria movement (+amount) + atualiza balance + agenda expires_at.
--   - Cliente no checkout informa email → GET /public/cashback/balance
--     mostra saldo + max redemption permitido pra esse pedido.
--   - Cliente aplica redemption no checkout → debita o saldo.
--   - Cron diário expira movements antigos (TODO J5).

ALTER TABLE public.store_config
  ADD COLUMN IF NOT EXISTS cashback_settings JSONB
  DEFAULT '{
    "enabled":                  false,
    "earnPct":                  3,
    "expirationDays":           90,
    "minBalanceToUseCents":     500,
    "maxRedemptionPctPerOrder": 50,
    "earnDelay":                "immediate"
  }'::jsonb;

COMMENT ON COLUMN public.store_config.cashback_settings IS
  'Settings de cashback: earnPct (% do total vira saldo), expirationDays, redemption rules.';

UPDATE public.store_config
   SET cashback_settings = '{
     "enabled":                  false,
     "earnPct":                  3,
     "expirationDays":           90,
     "minBalanceToUseCents":     500,
     "maxRedemptionPctPerOrder": 50,
     "earnDelay":                "immediate"
   }'::jsonb
 WHERE cashback_settings IS NULL;

-- ── Saldos por cliente ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.customer_cashback_balances (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  customer_identifier text NOT NULL,                    -- email lowercase (futuro: customer_id uuid)
  balance_cents       integer NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  total_earned_cents  integer NOT NULL DEFAULT 0,       -- acumulado total (sem subtrair redemptions)
  total_redeemed_cents integer NOT NULL DEFAULT 0,      -- gasto total
  last_movement_at    timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_cashback_balance_org_customer
  ON public.customer_cashback_balances (organization_id, customer_identifier);

COMMENT ON TABLE public.customer_cashback_balances IS
  'Saldo agregado de cashback por cliente (identificado por email).';

-- ── Ledger de movimentos ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.customer_cashback_movements (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  customer_identifier text NOT NULL,
  type                text NOT NULL CHECK (type IN ('earn', 'redeem', 'expire', 'adjustment')),
  amount_cents        integer NOT NULL,                   -- positivo = entrada, negativo = saída
  reason              text,                                -- "Pedido #abc", "Expirado", "Ajuste manual"
  source_kind         text,                                -- 'storefront_order', 'manual', 'cron_expire'
  source_id           text,                                -- ID da fonte (UUID do pedido, etc) — usado pra idempotência
  expires_at          timestamptz,                         -- pra type=earn — quando esse saldo vai expirar
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Idempotência: 1 movement por (org, source_kind, source_id, type) —
-- webhook reentregue não credita 2x. NULL em source_id não bloqueia
-- (movements manuais admin sem source_id são raros).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_cashback_movement_source
  ON public.customer_cashback_movements (organization_id, source_kind, source_id, type)
  WHERE source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cashback_movements_org_customer
  ON public.customer_cashback_movements (organization_id, customer_identifier, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cashback_movements_expires
  ON public.customer_cashback_movements (organization_id, expires_at)
  WHERE expires_at IS NOT NULL AND type = 'earn';

COMMENT ON TABLE public.customer_cashback_movements IS
  'Ledger imutável de cashback. earn/redeem/expire/adjustment.';

-- ── Trigger pra manter updated_at do balance ────────────────────────
CREATE OR REPLACE FUNCTION public.tg_cashback_balance_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cashback_balance_touch ON public.customer_cashback_balances;
CREATE TRIGGER trg_cashback_balance_touch
  BEFORE UPDATE ON public.customer_cashback_balances
  FOR EACH ROW EXECUTE FUNCTION public.tg_cashback_balance_touch();

-- ── Grants (criação via _admin_exec_sql não herda default privileges) ──
GRANT ALL ON TABLE public.customer_cashback_balances  TO service_role;
GRANT ALL ON TABLE public.customer_cashback_movements TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.customer_cashback_balances  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.customer_cashback_movements TO authenticated;
