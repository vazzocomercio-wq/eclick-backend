-- ============================================================
-- F11 ML Executive Dashboard IA — Camada E2 (Reputação)
--
-- IMPORTANTE: `ml_seller_reputation_snapshots` JÁ EXISTE em prod (criada
-- por ml-vertical/ml-postsale mas com 0 linhas). Esta migration REUSA
-- aquela tabela e apenas adiciona colunas que faltam (level_color, risk
-- flags, periods). Não duplica schema.
--
-- Cria `ml_seller_reputation_current` (cache do mais recente) que não
-- existia ainda.
--
-- Service usa nomenclatura da tabela existente:
--   claims_rate / cancellations_rate / delayed_handling_rate (fração 0-1)
--   claims_count / cancellations_count / delayed_handling_count
--   completed_transactions / cancelled_transactions / total_transactions
--
-- Decisões (vide reference_ml_api_shapes_f11):
--   • API ML chama de `claims`, NÃO `complaints`
--   • `rate` armazenado como fração 0-1
--   • `period` string `"60 days"` (com espaço) — armazenado em colunas novas
--   • Risk: claims ≥ 0.8%, cancellations ≥ 0.4%, late ≥ 5%
--   • GRANT explícito no fim (feedback_grant_admin_exec_sql)
-- ============================================================

-- 1. ALTER snapshots — adiciona colunas executive ──────────────────────
ALTER TABLE public.ml_seller_reputation_snapshots
  ADD COLUMN IF NOT EXISTS level_color           TEXT,
  ADD COLUMN IF NOT EXISTS claims_period         TEXT,
  ADD COLUMN IF NOT EXISTS cancellations_period  TEXT,
  ADD COLUMN IF NOT EXISTS delayed_period        TEXT,
  ADD COLUMN IF NOT EXISTS transactions_period   TEXT,
  ADD COLUMN IF NOT EXISTS is_at_risk            BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS risk_reasons          TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS is_mercado_lider      BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_reputation_snap_at_risk
  ON public.ml_seller_reputation_snapshots(organization_id, seller_id)
  WHERE is_at_risk = true;

CREATE INDEX IF NOT EXISTS idx_reputation_snap_org_seller_date
  ON public.ml_seller_reputation_snapshots(organization_id, seller_id, snapshot_date DESC);

-- 2. CREATE ml_seller_reputation_current — cache do mais recente ─────────
CREATE TABLE IF NOT EXISTS public.ml_seller_reputation_current (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             UUID NOT NULL,
  seller_id                   BIGINT NOT NULL,

  -- Nível
  level_id                    TEXT,
  level_color                 TEXT,
  power_seller_status         TEXT,

  -- Taxas (fração 0-1, espelha snapshot)
  claims_rate                 NUMERIC,
  cancellations_rate          NUMERIC,
  delayed_handling_rate       NUMERIC,

  -- Counts (60 days)
  claims_count                INTEGER,
  cancellations_count         INTEGER,
  delayed_handling_count      INTEGER,

  -- Transactions (historic)
  total_transactions          INTEGER,
  completed_transactions      INTEGER,
  cancelled_transactions      INTEGER,

  -- Ratings
  positive_ratings            NUMERIC,
  neutral_ratings             NUMERIC,
  negative_ratings            NUMERIC,

  -- Derivados
  is_mercado_lider            BOOLEAN DEFAULT false,
  is_at_risk                  BOOLEAN DEFAULT false,
  risk_reasons                TEXT[] DEFAULT '{}',

  -- Tendência (comparando com snapshot anterior)
  trend                       TEXT CHECK (trend IN ('improving', 'stable', 'degrading', 'unknown')),
  trend_calculated_at         TIMESTAMPTZ,

  last_synced_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_sync_at                TIMESTAMPTZ,

  UNIQUE (organization_id, seller_id)
);

CREATE INDEX IF NOT EXISTS idx_reputation_current_org_seller
  ON public.ml_seller_reputation_current(organization_id, seller_id);

-- 3. GRANTs explícitos ─────────────────────────────────────────────────
-- Snapshots já tem GRANTs do módulo anterior, mas reforçamos por garantia.
GRANT ALL                              ON public.ml_seller_reputation_snapshots TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE   ON public.ml_seller_reputation_snapshots TO authenticated;

GRANT ALL                              ON public.ml_seller_reputation_current TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE   ON public.ml_seller_reputation_current TO authenticated;
