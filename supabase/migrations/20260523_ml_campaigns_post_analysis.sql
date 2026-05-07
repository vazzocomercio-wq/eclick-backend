-- ============================================================
-- F8 ML Campaign Center IA — Camada 4 (K4)
-- Pos-campanha + Aprendizado
-- ============================================================
-- Apos campanha encerrar, computa metricas antes/durante/depois,
-- ROI e identifica best/worst performers. Aprende por categoria/tipo
-- pra ajustar score de proximas recomendacoes.
-- ============================================================

-- ─── 1. ml_campaign_post_analysis ────────────────────────────
CREATE TABLE IF NOT EXISTS ml_campaign_post_analysis (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seller_id                   bigint NOT NULL,
  campaign_id                 uuid NOT NULL REFERENCES ml_campaigns(id) ON DELETE CASCADE,

  -- Janelas analisadas
  campaign_start              timestamptz NOT NULL,
  campaign_end                timestamptz NOT NULL,
  before_window_start         timestamptz NOT NULL,
  after_window_end            timestamptz NOT NULL,

  -- Participacao
  participated_items_count    integer NOT NULL DEFAULT 0,
  approved_items_count        integer NOT NULL DEFAULT 0,
  applied_items_count         integer NOT NULL DEFAULT 0,

  -- Vendas (units e revenue agregados nas janelas)
  units_sold_before           integer DEFAULT 0,
  units_sold_during           integer DEFAULT 0,
  units_sold_after            integer DEFAULT 0,
  units_sold_lift_pct         numeric,

  revenue_before              numeric DEFAULT 0,
  revenue_during              numeric DEFAULT 0,
  revenue_after               numeric DEFAULT 0,
  revenue_lift_pct            numeric,

  -- Margem
  avg_margin_before_pct       numeric,
  avg_margin_during_pct       numeric,
  avg_margin_after_pct        numeric,
  total_margin_brl_during     numeric,
  margin_loss_brl             numeric,

  -- Subsidio MELI total recebido (R$) — somatoria nos items que tinham subsidio
  total_meli_subsidy_received numeric DEFAULT 0,

  -- ROI
  incremental_revenue         numeric,
  incremental_units           integer,
  campaign_roi_brl            numeric,
  campaign_roi_pct            numeric,

  -- Performance por item (top 10 + bottom 10 + ruptures)
  best_performers             jsonb DEFAULT '[]'::jsonb,
  worst_performers            jsonb DEFAULT '[]'::jsonb,
  rupture_items               jsonb DEFAULT '[]'::jsonb,

  -- Recomendacao pra proximas
  ai_summary                  text,
  recommended_for_next_time   jsonb DEFAULT '[]'::jsonb,
  not_recommended_for_next_time jsonb DEFAULT '[]'::jsonb,
  insights                    jsonb DEFAULT '[]'::jsonb,

  generated_at                timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organization_id, seller_id, campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_post_analysis_org_seller
  ON ml_campaign_post_analysis(organization_id, seller_id);
CREATE INDEX IF NOT EXISTS idx_post_analysis_roi
  ON ml_campaign_post_analysis(organization_id, campaign_roi_pct DESC);

-- ─── 2. ml_campaign_learnings (agregados por categoria/tipo) ──
CREATE TABLE IF NOT EXISTS ml_campaign_learnings (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seller_id                   bigint NOT NULL,

  -- Chave do aprendizado (group by)
  ml_promotion_type           text,                  -- DEAL/SMART/LIGHTNING/...
  ml_domain_id                text,                  -- categoria ML (opcional)
  campaign_pattern            text,                  -- 'high_subsidy'/'sazonal'/'liquidation'/null

  -- Estatisticas agregadas (ao longo de N campanhas)
  campaigns_analyzed          integer DEFAULT 0,
  avg_units_lift_pct          numeric,
  avg_revenue_lift_pct        numeric,
  avg_margin_change_pct       numeric,
  avg_roi_pct                 numeric,
  success_rate                numeric,               -- % que tiveram ROI positivo

  -- Ajuste sugerido pro engine
  recommended_score_adjustment numeric DEFAULT 0,

  insights                    jsonb DEFAULT '[]'::jsonb,
  last_updated_at             timestamptz NOT NULL DEFAULT now(),
  created_at                  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organization_id, seller_id, ml_promotion_type, ml_domain_id)
);

CREATE INDEX IF NOT EXISTS idx_learnings_org_seller
  ON ml_campaign_learnings(organization_id, seller_id);

-- ─── GRANTs ───────────────────────────────────────────────────
DO $$
DECLARE
  tbl text;
  affected_tables text[] := ARRAY[
    'ml_campaign_post_analysis',
    'ml_campaign_learnings'
  ];
BEGIN
  FOREACH tbl IN ARRAY affected_tables LOOP
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', tbl);
  END LOOP;
END $$;
