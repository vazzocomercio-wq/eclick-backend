-- ============================================================
-- Onda 3 / S4 — Ads Hub: Produto -> Campanha
-- Campanhas de ads (Meta/Google/TikTok/ML Ads) geradas por IA
-- ============================================================

CREATE TABLE IF NOT EXISTS ads_campaigns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id      UUID REFERENCES products(id) ON DELETE SET NULL,
  user_id         UUID NOT NULL REFERENCES auth.users(id),

  -- Plataforma
  platform TEXT NOT NULL CHECK (platform IN (
    'meta','google','tiktok','mercado_livre_ads'
  )),

  name      TEXT NOT NULL,
  objective TEXT NOT NULL CHECK (objective IN (
    'traffic','conversions','engagement','awareness','catalog_sales','leads'
  )),

  -- Segmentação (shape varia por plataforma — ver doc inline na service)
  targeting JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Orçamento
  budget_daily_brl  NUMERIC NOT NULL CHECK (budget_daily_brl > 0),
  budget_total_brl  NUMERIC,
  duration_days     INTEGER NOT NULL DEFAULT 7,
  bid_strategy      TEXT NOT NULL DEFAULT 'lowest_cost',

  -- Copies (array de variantes A/B)
  ad_copies JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- URLs
  destination_url TEXT,
  utm_params      JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Status
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft','ready','publishing','active','paused','completed','error','archived'
  )),
  external_campaign_id TEXT,
  external_adset_id    TEXT,
  external_ad_ids      TEXT[] NOT NULL DEFAULT '{}',
  published_at         TIMESTAMPTZ,

  -- Métricas (atualizadas via cron na Sprint 6)
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- { impressions, clicks, ctr, cpc_brl, spend_brl, conversions,
  --   conversion_value_brl, roas, cpa_brl, last_sync }

  generation_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ads_campaigns_org      ON ads_campaigns(organization_id);
CREATE INDEX IF NOT EXISTS idx_ads_campaigns_product  ON ads_campaigns(product_id);
CREATE INDEX IF NOT EXISTS idx_ads_campaigns_platform ON ads_campaigns(platform);
CREATE INDEX IF NOT EXISTS idx_ads_campaigns_status   ON ads_campaigns(status);
CREATE INDEX IF NOT EXISTS idx_ads_campaigns_active   ON ads_campaigns(status)
  WHERE status IN ('active','publishing');

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.set_ads_campaigns_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ads_campaigns_updated_at ON ads_campaigns;
CREATE TRIGGER trg_ads_campaigns_updated_at
  BEFORE UPDATE ON ads_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.set_ads_campaigns_updated_at();

-- RLS
ALTER TABLE ads_campaigns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ads_campaigns_select ON ads_campaigns;
CREATE POLICY ads_campaigns_select ON ads_campaigns
  FOR SELECT TO authenticated
  USING (
    organization_id IN (
      SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS ads_campaigns_modify ON ads_campaigns;
CREATE POLICY ads_campaigns_modify ON ads_campaigns
  FOR ALL TO authenticated
  USING (
    organization_id IN (
      SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    organization_id IN (
      SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
    )
  );
