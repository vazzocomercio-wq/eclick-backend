-- ============================================================
-- F8 ML Campaign Center IA — Camada 2 (K2)
-- Motor de Decisao + Recomendacoes
-- ============================================================
-- 2 tabelas:
--   1. ml_campaign_recommendations — recomendacoes geradas
--   2. ml_campaigns_config — config por org/seller (regras de margem,
--      cap diario de IA, quality gate, etc)
-- ============================================================

-- ─── 1. ml_campaign_recommendations ───────────────────────────
CREATE TABLE IF NOT EXISTS ml_campaign_recommendations (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seller_id                   bigint NOT NULL,
  campaign_item_id            uuid NOT NULL REFERENCES ml_campaign_items(id) ON DELETE CASCADE,
  product_id                  uuid REFERENCES products(id) ON DELETE SET NULL,

  -- Custos detalhados (snapshot do momento da analise)
  -- {
  --   cost_price, tax_amount, tax_percentage,
  --   ml_commission, ml_commission_pct, ml_fixed_fee,
  --   free_shipping_cost, packaging_cost, operational_cost,
  --   meli_subsidy_brl,
  --   total_costs, net_revenue
  -- }
  cost_breakdown              jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- 3 cenarios de preco + break_even
  scenarios                   jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Recomendacao de quantidade
  quantity_recommendation     jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Score de oportunidade (0-100)
  opportunity_score           integer CHECK (opportunity_score >= 0 AND opportunity_score <= 100),
  score_breakdown             jsonb DEFAULT '{}'::jsonb,

  -- Classificacao
  recommendation              text NOT NULL CHECK (recommendation IN (
    'recommended',           -- participar recomendado
    'recommended_caution',   -- participar com cautela
    'clearance_only',        -- so pra giro de estoque
    'skip',                  -- nao participar
    'review_costs',          -- revisar custo antes (health nao OK)
    'low_quality_listing'    -- qualidade ML ruim — corrigir antes
  )),
  recommendation_reason       text NOT NULL,        -- texto explicativo

  -- Estrategia escolhida
  recommended_strategy        text CHECK (recommended_strategy IN (
    'conservative', 'competitive', 'aggressive'
  )),
  recommended_price           numeric,
  recommended_quantity        integer,

  -- Alertas (low quality, ads ativo, concorrente mais barato, etc)
  warnings                    jsonb DEFAULT '[]'::jsonb,

  -- Status do fluxo
  status                      text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending',          -- aguardando revisao
    'approved',         -- aprovado pelo lojista (vai pra K3 aplicar)
    'edited',           -- lojista editou e aprovou
    'rejected',         -- lojista rejeitou
    'auto_approved',    -- auto-aprovado por regras (NAO usado em v1)
    'applied',          -- ja aplicado (link com K3)
    'expired'           -- expirou (deadline da campanha)
  )),

  -- Metadados de geracao
  generation_metadata         jsonb DEFAULT '{}'::jsonb,
  -- {
  --   "engine_version": "deterministic-v1",
  --   "ai_reasoning_used": false,
  --   "ai_cost_usd": 0,
  --   "generated_in_ms": 145
  -- }

  reviewed_at                 timestamptz,
  reviewed_by                 uuid,                  -- auth.users(id) — sem FK pra evitar fk warning
  expires_at                  timestamptz,           -- igual deadline_date da campanha
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recos_org_seller
  ON ml_campaign_recommendations(organization_id, seller_id);
CREATE INDEX IF NOT EXISTS idx_recos_item
  ON ml_campaign_recommendations(campaign_item_id);
CREATE INDEX IF NOT EXISTS idx_recos_product
  ON ml_campaign_recommendations(product_id) WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recos_status_pending
  ON ml_campaign_recommendations(organization_id, seller_id, status)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_recos_score
  ON ml_campaign_recommendations(organization_id, seller_id, opportunity_score DESC);
CREATE INDEX IF NOT EXISTS idx_recos_classification
  ON ml_campaign_recommendations(organization_id, seller_id, recommendation);
-- Unique parcial: 1 recomendacao 'pending' por (item × campanha) — evita
-- duplicatas quando regenera. Outras (rejected/applied) podem ter N.
CREATE UNIQUE INDEX IF NOT EXISTS idx_recos_pending_unique
  ON ml_campaign_recommendations(campaign_item_id)
  WHERE status = 'pending';

-- ─── 2. ml_campaigns_config (1 row por org+seller) ────────────
CREATE TABLE IF NOT EXISTS ml_campaigns_config (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seller_id                   bigint NOT NULL,

  -- Regras de margem (default coerente com lojista medio)
  min_acceptable_margin_pct   numeric NOT NULL DEFAULT 15,
  target_margin_pct           numeric NOT NULL DEFAULT 25,
  clearance_min_margin_pct    numeric NOT NULL DEFAULT 5,

  -- Regras de estoque
  safety_stock_days           integer NOT NULL DEFAULT 7,
  high_stock_threshold_days   integer NOT NULL DEFAULT 90,
  min_stock_to_participate    integer NOT NULL DEFAULT 3,

  -- Quality gate (Camada 2): warning forte mas NAO blocker
  quality_gate_enabled        boolean NOT NULL DEFAULT true,
  quality_gate_min_score      integer NOT NULL DEFAULT 60,

  -- Custos operacionais (defaults — entram no cost_breakdown)
  default_packaging_cost      numeric NOT NULL DEFAULT 0,
  default_operational_cost_pct numeric NOT NULL DEFAULT 0,

  -- Cap de IA (USD/dia) — configuravel por org
  ai_daily_cap_usd            numeric NOT NULL DEFAULT 10,
  ai_alert_at_pct             integer NOT NULL DEFAULT 80,
  ai_reasoning_enabled        boolean NOT NULL DEFAULT true,

  -- Auto-suggest (gerar recomendacao automaticamente quando candidate vira disponivel)
  auto_suggest_on_new_candidate boolean NOT NULL DEFAULT true,
  daily_analysis_enabled        boolean NOT NULL DEFAULT true,

  -- v1.1 — auto-approve fica desligado por seguranca
  auto_approve_enabled        boolean NOT NULL DEFAULT false,
  auto_approve_score_above    integer NOT NULL DEFAULT 85,

  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organization_id, seller_id)
);

CREATE INDEX IF NOT EXISTS idx_camp_config_org
  ON ml_campaigns_config(organization_id);

-- ─── 3. ml_campaigns_ai_usage_log (tracking de cap diario) ────
-- Cada chamada de IA gera 1 row. Cap diario aggregates por dia.
CREATE TABLE IF NOT EXISTS ml_campaigns_ai_usage_log (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seller_id                   bigint,

  recommendation_id           uuid REFERENCES ml_campaign_recommendations(id) ON DELETE SET NULL,
  provider                    text NOT NULL,         -- 'anthropic' / 'openai' / 'deterministic'
  model                       text,

  input_tokens                integer DEFAULT 0,
  output_tokens               integer DEFAULT 0,
  cost_usd                    numeric NOT NULL DEFAULT 0,

  duration_ms                 integer,
  success                     boolean NOT NULL DEFAULT true,
  error_message               text,

  created_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_org_date
  ON ml_campaigns_ai_usage_log(organization_id, created_at DESC);

-- ─── Triggers ─────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_recos_updated ON ml_campaign_recommendations;
CREATE TRIGGER trg_recos_updated
  BEFORE UPDATE ON ml_campaign_recommendations
  FOR EACH ROW EXECUTE FUNCTION ml_campaigns_touch_updated_at();

DROP TRIGGER IF EXISTS trg_camp_config_updated ON ml_campaigns_config;
CREATE TRIGGER trg_camp_config_updated
  BEFORE UPDATE ON ml_campaigns_config
  FOR EACH ROW EXECUTE FUNCTION ml_campaigns_touch_updated_at();

-- ─── GRANTs ───────────────────────────────────────────────────
DO $$
DECLARE
  tbl text;
  affected_tables text[] := ARRAY[
    'ml_campaign_recommendations',
    'ml_campaigns_config',
    'ml_campaigns_ai_usage_log'
  ];
BEGIN
  FOREACH tbl IN ARRAY affected_tables LOOP
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', tbl);
  END LOOP;
END $$;
