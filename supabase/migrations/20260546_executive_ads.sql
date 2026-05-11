-- ============================================================
-- F11 ML Executive Dashboard IA — Camada E5 (Ads Visibility)
--
-- ESCOPO: apenas visualização sobre `ml_ads_*` que JÁ EXISTE em prod.
-- NÃO é F12 completo (OAuth advertiser, gestão de campanhas, edição de
-- bids, recomendações de budget) — esse é módulo separado futuro.
--
-- Findings das tabelas existentes:
--   - ml_ads_campaigns:  organization_id, advertiser_id, name, status,
--                        daily_budget, type ('PADS'|'BADS'|'DISPLAY'),
--                        start_date, end_date, items jsonb
--   - ml_ads_reports:    organization_id, campaign_id, date, clicks,
--                        impressions, ctr, spend, conversions, revenue,
--                        roas, acos
--
-- Decisão sobre multi-conta: dados de Ads são por `organization_id` +
-- `advertiser_id`. NÃO há vínculo persistido entre advertiser_id e
-- seller_id. Portanto agregamos por **org** (não por seller). Criamos
-- ml_ads_summary com PK (organization_id).
--
-- Aspectos cosméticos: campos `ads_*` em `ml_dashboard_summary` espelham
-- o agregado da org pra cada row de seller daquela org. UI agregando
-- soma cross-account não duplica porque dashboard service lê de
-- ml_ads_summary uma vez e replica.
--
-- Threshold padrão: ACOS > 30% considera campanha "losing money".
-- Pode ser tunado depois (config no settings da org).
--
-- GRANT explícito no fim (feedback_grant_admin_exec_sql).
-- ============================================================

-- 1. ml_ads_summary — cache org-level ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ml_ads_summary (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- Últimos 7 dias
  ads_spend_7d                NUMERIC DEFAULT 0,
  ads_revenue_7d              NUMERIC DEFAULT 0,
  ads_clicks_7d               INTEGER DEFAULT 0,
  ads_impressions_7d          INTEGER DEFAULT 0,
  ads_conversions_7d          INTEGER DEFAULT 0,
  ads_acos_7d                 NUMERIC,         -- spend / revenue (gasto / faturamento) %
  ads_roas_7d                 NUMERIC,         -- revenue / spend (retorno por R$ investido)
  ads_ctr_7d                  NUMERIC,         -- clicks / impressions × 100

  -- Comparação vs 7d anterior
  ads_spend_change_pct        NUMERIC,
  ads_revenue_change_pct      NUMERIC,

  -- Estado das campanhas
  ads_campaigns_active        INTEGER DEFAULT 0,
  ads_campaigns_paused        INTEGER DEFAULT 0,
  ads_campaigns_losing_money  INTEGER DEFAULT 0,  -- ACOS_7d > acos_threshold AND spend_7d > 0
  ads_campaigns_winning       INTEGER DEFAULT 0,  -- ROAS_7d > 3 AND spend_7d > 0

  -- Coverage (são 0 quando org ainda não tem advertiser ligado)
  has_advertiser              BOOLEAN DEFAULT false,
  advertiser_ids              TEXT[] DEFAULT '{}',
  acos_threshold              NUMERIC DEFAULT 0.30,  -- 30% — config futura

  last_refresh_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_refresh_at             TIMESTAMPTZ,

  UNIQUE (organization_id)
);

CREATE INDEX IF NOT EXISTS idx_ads_summary_org
  ON public.ml_ads_summary(organization_id);

-- 2. ALTER ml_dashboard_summary: campos espelhados pro merge no upsertFull ─
ALTER TABLE public.ml_dashboard_summary
  ADD COLUMN IF NOT EXISTS ads_spend_7d                NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ads_revenue_7d              NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ads_clicks_7d               INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ads_impressions_7d          INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ads_acos_7d                 NUMERIC,
  ADD COLUMN IF NOT EXISTS ads_roas_7d                 NUMERIC,
  ADD COLUMN IF NOT EXISTS ads_campaigns_active        INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ads_campaigns_losing_money  INTEGER DEFAULT 0;

-- 3. GRANTs explícitos ─────────────────────────────────────────────────
GRANT ALL                              ON public.ml_ads_summary TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE   ON public.ml_ads_summary TO authenticated;

-- ml_dashboard_summary já tem GRANTs do 20260542 — ALTER ADD COLUMN
-- herda automaticamente, não precisa re-grant.
