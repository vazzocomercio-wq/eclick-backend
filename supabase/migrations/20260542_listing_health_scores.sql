-- ============================================================
-- F10 ML Listing Center IA — L4 Sprint 7: Score consolidado por anúncio
-- Combina sinais de F7 (quality), L2 (pricing), L3 (fiscal/status/policy)
-- e dados internos (margin, sales) em um score 0-100 por item.
-- Spec canônica: docs/ml-listing-center-spec.md
-- ============================================================

CREATE TABLE IF NOT EXISTS public.ml_listing_health_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  seller_id BIGINT NOT NULL,
  ml_item_id TEXT NOT NULL,
  product_id UUID REFERENCES public.products(id),

  -- Score consolidado 0-100
  health_score INTEGER NOT NULL CHECK (health_score >= 0 AND health_score <= 100),

  -- Breakdown (cada um 0-100)
  quality_score INTEGER,        -- F7 (ml_quality_snapshots.ml_score)
  pricing_score INTEGER,        -- L2 (buy_box_status + price_diff)
  fiscal_score INTEGER,         -- L3 (ml_listing_fiscal_snapshots.score)
  status_score INTEGER,         -- L1 (100 se active, 0 se paused/closed)
  margin_score INTEGER,         -- Margem média do produto vinculado
  sales_score INTEGER,          -- Vendas relativas nos últimos 30d

  -- Insights
  key_issues TEXT[] DEFAULT '{}'::text[],
  -- ['quality_low', 'price_high', 'fiscal_incomplete', 'inactive',
  --  'margin_low', 'losing_buy_box']

  -- Recomendação principal
  top_recommendation TEXT,
  top_recommendation_action TEXT CHECK (top_recommendation_action IN (
    'fix_fiscal', 'improve_quality', 'reduce_price',
    'activate_automation', 'replenish_stock', 'reactivate',
    'improve_margin', 'apply_promotion', 'none'
  )),
  top_recommendation_impact NUMERIC,

  -- Tendência (calculada comparando com score anterior)
  trend TEXT CHECK (trend IN ('improving', 'stable', 'degrading')),
  prev_score INTEGER,
  score_change INTEGER,

  calculated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_health_scores_org_seller
  ON public.ml_listing_health_scores(organization_id, seller_id);
CREATE INDEX IF NOT EXISTS idx_health_scores_item
  ON public.ml_listing_health_scores(ml_item_id);
CREATE INDEX IF NOT EXISTS idx_health_scores_score
  ON public.ml_listing_health_scores(health_score);
CREATE INDEX IF NOT EXISTS idx_health_scores_low
  ON public.ml_listing_health_scores(health_score)
  WHERE health_score < 60;
CREATE UNIQUE INDEX IF NOT EXISTS idx_health_scores_unique
  ON public.ml_listing_health_scores(organization_id, seller_id, ml_item_id);

GRANT ALL ON public.ml_listing_health_scores TO service_role;
GRANT SELECT ON public.ml_listing_health_scores TO authenticated;

NOTIFY pgrst, 'reload schema';
