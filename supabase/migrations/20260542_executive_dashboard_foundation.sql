-- ============================================================
-- F11 ML Executive Dashboard IA — Camada E1 (Foundation + Agregação)
--
-- Tela home do operador. Snapshot consolidado da operação ML:
-- vendas, anúncios ativos, qualidade, campanhas, tarefas do Listing Center,
-- pós-venda. Schema preparado para receber dados de E2 (reputação),
-- E3 (logística) e E4 (visitas) nas próximas migrations.
--
-- VIEW v_dashboard_aggregated_metrics consome **dados reais** dos módulos
-- F7 (ml_quality_snapshots), F8 (ml_campaigns / ml_campaign_recommendations),
-- F10 (ml_listing_tasks) e do core (orders + products + product_listings).
-- Sem placeholders. Mudanças nesses módulos refletem automaticamente.
--
-- Decisões aplicadas (vide review com user 2026-05-11):
--   • platform = 'mercadolivre' (sem underscore) — feedback_ml_platform_string
--   • GMV = SUM(sale_price * quantity) — orders nao tem total_amount
--   • Anúncios ativos = EXISTS via product_listings.is_active=true
--   • Multi-conta via public.ml_connections (NÃO ml_oauth_tokens)
--   • GRANT explícito no fim — feedback_grant_admin_exec_sql
-- ============================================================

-- 1. ml_dashboard_summary — cache do dashboard (1 row por org+seller) ──
-- Campos cobertos pela E1 não-nuláveis; campos de E2/E3/E4 preenchidos
-- conforme as próximas camadas entrarem.
CREATE TABLE IF NOT EXISTS public.ml_dashboard_summary (
  id                                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id                     UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  seller_id                           BIGINT NOT NULL,

  -- KPIs gerais (E1)
  total_active_listings               INTEGER DEFAULT 0,
  total_paused_listings               INTEGER DEFAULT 0,
  total_inactive_listings             INTEGER DEFAULT 0,
  total_out_of_stock                  INTEGER DEFAULT 0,

  -- Vendas últimos 7d (E1)
  sales_7d_count                      INTEGER DEFAULT 0,
  sales_7d_units                      INTEGER DEFAULT 0,
  sales_7d_gmv                        NUMERIC DEFAULT 0,
  sales_7d_avg_ticket                 NUMERIC,
  sales_7d_change_pct                 NUMERIC,

  -- Hoje (E1)
  sales_today_count                   INTEGER DEFAULT 0,
  sales_today_gmv                     NUMERIC DEFAULT 0,
  shipments_to_dispatch_today         INTEGER DEFAULT 0,  -- preenchido em E3
  shipments_late                      INTEGER DEFAULT 0,  -- preenchido em E3

  -- Perguntas e pós-venda (gradual)
  questions_unanswered                INTEGER DEFAULT 0,
  questions_avg_response_hours        NUMERIC,
  questions_critical                  INTEGER DEFAULT 0,
  unread_messages                     INTEGER DEFAULT 0,
  open_claims                         INTEGER DEFAULT 0,
  open_returns                        INTEGER DEFAULT 0,
  open_mediations                     INTEGER DEFAULT 0,

  -- F7 Quality Center
  listings_quality_low                INTEGER DEFAULT 0,
  listings_quality_basic              INTEGER DEFAULT 0,
  listings_with_penalty               INTEGER DEFAULT 0,
  listings_incomplete_specs           INTEGER DEFAULT 0,

  -- Preços / pricing (F10)
  listings_price_high                 INTEGER DEFAULT 0,
  pricing_automation_eligible         INTEGER DEFAULT 0,
  pricing_automation_active           INTEGER DEFAULT 0,
  pricing_automation_paused           INTEGER DEFAULT 0,

  -- F8 Campaign Center
  active_campaigns                    INTEGER DEFAULT 0,
  campaigns_ending_today              INTEGER DEFAULT 0,
  campaigns_ending_this_week          INTEGER DEFAULT 0,
  campaign_recommendations_pending    INTEGER DEFAULT 0,
  campaign_high_opportunities         INTEGER DEFAULT 0,

  -- F9 Dropship
  dropship_pending_oc                 INTEGER DEFAULT 0,
  dropship_partner_out_of_stock       INTEGER DEFAULT 0,
  dropship_open_returns               INTEGER DEFAULT 0,
  dropship_payable_next_7d            NUMERIC DEFAULT 0,

  -- E2 Reputação (preenchido pela próxima camada)
  reputation_level_id                 TEXT,
  reputation_power_seller_status      TEXT,
  reputation_complaints_pct           NUMERIC,
  reputation_cancellations_pct        NUMERIC,
  reputation_late_shipments_pct       NUMERIC,
  reputation_color                    TEXT,

  -- E4 Visitas (preenchido pela próxima camada)
  visits_7d                           INTEGER,
  visits_7d_change_pct                NUMERIC,
  conversion_rate_pct                 NUMERIC,

  -- E3 Logística (preenchido pela próxima camada)
  flex_active_listings                INTEGER DEFAULT 0,
  full_active_listings                INTEGER DEFAULT 0,
  full_storage_used_pct               NUMERIC,

  -- Top recomendações de alto impacto (F10 ml_listing_tasks)
  high_impact_recommendations_count   INTEGER DEFAULT 0,
  high_impact_total_estimated_brl     NUMERIC DEFAULT 0,

  -- Sync
  last_refresh_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_refresh_at                     TIMESTAMPTZ,
  refresh_duration_ms                 INTEGER,
  updated_at                          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dashboard_summary_unique
  ON public.ml_dashboard_summary(organization_id, seller_id);

-- 2. ml_sales_daily — histórico de vendas diárias (gráfico 7d/30d) ─────
CREATE TABLE IF NOT EXISTS public.ml_sales_daily (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  seller_id           BIGINT NOT NULL,
  date                DATE NOT NULL,

  orders_count        INTEGER DEFAULT 0,
  units_count         INTEGER DEFAULT 0,
  gmv                 NUMERIC DEFAULT 0,
  avg_ticket          NUMERIC,
  unique_buyers       INTEGER DEFAULT 0,

  -- Sempre 'mercadolivre' (sem underscore) — consistente com orders.platform
  platform            TEXT NOT NULL DEFAULT 'mercadolivre',

  -- Por canal logístico (preenchido em E3): { fulfillment, self_service, drop_off, xd_drop_off }
  ml_logistic_breakdown JSONB DEFAULT '{}'::jsonb,

  -- Top produtos do dia: [{ product_id, name, units, gmv }]
  top_products        JSONB DEFAULT '[]'::jsonb,

  computed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (organization_id, seller_id, date, platform)
);

CREATE INDEX IF NOT EXISTS idx_sales_daily_org_seller_date
  ON public.ml_sales_daily(organization_id, seller_id, date DESC);

-- 3. ml_dashboard_refresh_logs — auditoria de refreshes ────────────────
CREATE TABLE IF NOT EXISTS public.ml_dashboard_refresh_logs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL,
  seller_id           BIGINT,
  refresh_type        TEXT NOT NULL CHECK (refresh_type IN (
    'full',          -- tudo
    'aggregation',   -- só VIEW agregadora
    'reputation',    -- E2
    'logistics',     -- E3
    'visits',        -- E4
    'sales'          -- vendas diárias
  )),
  status              TEXT NOT NULL DEFAULT 'running' CHECK (status IN (
    'running', 'completed', 'failed', 'partial'
  )),
  api_calls_count     INTEGER DEFAULT 0,
  records_updated     INTEGER DEFAULT 0,
  error_message       TEXT,
  duration_ms         INTEGER,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_dashboard_refresh_logs_org_seller
  ON public.ml_dashboard_refresh_logs(organization_id, seller_id);
CREATE INDEX IF NOT EXISTS idx_dashboard_refresh_logs_started
  ON public.ml_dashboard_refresh_logs(started_at DESC);

-- 4. v_dashboard_aggregated_metrics — VIEW agregadora ─────────────────
-- Lê SEM duplicar dados dos módulos F7/F8/F10 + core. Mudanças neles
-- refletem automaticamente. O DashboardRefreshService consome essa VIEW
-- e mescla com snapshots de E2/E3/E4 ao fazer UPSERT no summary.
--
-- Multi-conta via CROSS JOIN LATERAL em public.ml_connections.
-- Anúncios ativos via EXISTS em product_listings (fonte da verdade do
-- estado real no ML, não catalog_status interno do SaaS).
CREATE OR REPLACE VIEW public.v_dashboard_aggregated_metrics AS
SELECT
  o.id AS organization_id,
  ml.seller_id,

  -- ── Vendas (orders) ──────────────────────────────────────────────
  (SELECT COUNT(*) FROM public.orders ord
     WHERE ord.seller_id = ml.seller_id
       AND ord.platform  = 'mercadolivre'
       AND ord.created_at >= now() - interval '7 days')           AS sales_7d_count,

  (SELECT COALESCE(SUM(ord.sale_price * ord.quantity), 0) FROM public.orders ord
     WHERE ord.seller_id = ml.seller_id
       AND ord.platform  = 'mercadolivre'
       AND ord.created_at >= now() - interval '7 days')           AS sales_7d_gmv,

  (SELECT COALESCE(SUM(ord.quantity), 0) FROM public.orders ord
     WHERE ord.seller_id = ml.seller_id
       AND ord.platform  = 'mercadolivre'
       AND ord.created_at >= now() - interval '7 days')           AS sales_7d_units,

  (SELECT COUNT(*) FROM public.orders ord
     WHERE ord.seller_id = ml.seller_id
       AND ord.platform  = 'mercadolivre'
       AND ord.created_at::date = CURRENT_DATE)                   AS sales_today_count,

  (SELECT COALESCE(SUM(ord.sale_price * ord.quantity), 0) FROM public.orders ord
     WHERE ord.seller_id = ml.seller_id
       AND ord.platform  = 'mercadolivre'
       AND ord.created_at::date = CURRENT_DATE)                   AS sales_today_gmv,

  -- ── Anúncios sincronizados do ML por seller (proxy de "ativos") ───
  -- USAVA `product_listings` mas descobriu-se que `account_id` é NULL
  -- em todas as linhas — não particiona por seller_id. Fallback é
  -- `ml_quality_snapshots` que tem `seller_id` populado em todas as linhas
  -- e é sincronizado por F7 pra todos os itens que o seller publicou no ML.
  -- Trade-off: depende de F7 sync estar atualizado.
  (SELECT COUNT(DISTINCT qs.ml_item_id) FROM public.ml_quality_snapshots qs
     WHERE qs.organization_id = o.id
       AND qs.seller_id       = ml.seller_id)                       AS total_active_listings,

  -- ── F7 Quality Center ─────────────────────────────────────────────
  (SELECT COUNT(*) FROM public.ml_quality_snapshots qs
     WHERE qs.organization_id = o.id
       AND qs.seller_id       = ml.seller_id
       AND qs.ml_score IS NOT NULL
       AND qs.ml_score < 60)                                       AS listings_quality_low,

  (SELECT COUNT(*) FROM public.ml_quality_snapshots qs
     WHERE qs.organization_id = o.id
       AND qs.seller_id       = ml.seller_id
       AND qs.ml_level        = 'basic')                           AS listings_quality_basic,

  (SELECT COUNT(*) FROM public.ml_quality_snapshots qs
     WHERE qs.organization_id = o.id
       AND qs.seller_id       = ml.seller_id
       AND qs.has_exposure_penalty = true)                         AS listings_with_penalty,

  (SELECT COUNT(*) FROM public.ml_quality_snapshots qs
     WHERE qs.organization_id = o.id
       AND qs.seller_id       = ml.seller_id
       AND qs.pending_count   > 0)                                 AS listings_incomplete_specs,

  -- ── F8 Campaign Center ────────────────────────────────────────────
  (SELECT COUNT(*) FROM public.ml_campaigns c
     WHERE c.organization_id = o.id
       AND c.seller_id       = ml.seller_id
       AND c.status          = 'started')                          AS active_campaigns,

  (SELECT COUNT(*) FROM public.ml_campaigns c
     WHERE c.organization_id = o.id
       AND c.seller_id       = ml.seller_id
       AND c.status IN ('pending', 'started')
       AND c.deadline_date IS NOT NULL
       AND c.deadline_date::date = CURRENT_DATE)                   AS campaigns_ending_today,

  (SELECT COUNT(*) FROM public.ml_campaigns c
     WHERE c.organization_id = o.id
       AND c.seller_id       = ml.seller_id
       AND c.status IN ('pending', 'started')
       AND c.deadline_date IS NOT NULL
       AND c.deadline_date BETWEEN now()
                                AND now() + interval '7 days')    AS campaigns_ending_this_week,

  (SELECT COUNT(*) FROM public.ml_campaign_recommendations cr
     WHERE cr.organization_id = o.id
       AND cr.seller_id       = ml.seller_id
       AND cr.status          = 'pending'
       AND cr.recommendation IN ('recommended', 'recommended_caution')) AS campaign_recommendations_pending,

  (SELECT COUNT(*) FROM public.ml_campaign_recommendations cr
     WHERE cr.organization_id   = o.id
       AND cr.seller_id         = ml.seller_id
       AND cr.status            = 'pending'
       AND cr.recommendation    = 'recommended'
       AND cr.opportunity_score >= 80)                             AS campaign_high_opportunities,

  -- ── F10 Listing Center — recomendações de alto impacto ────────────
  (SELECT COUNT(*) FROM public.ml_listing_tasks t
     WHERE t.organization_id = o.id
       AND t.seller_id       = ml.seller_id
       AND t.status          = 'open'
       AND t.severity IN ('critical', 'high')
       AND t.estimated_impact_brl IS NOT NULL
       AND t.estimated_impact_brl > 0)                             AS high_impact_recommendations_count,

  (SELECT COALESCE(SUM(t.estimated_impact_brl), 0) FROM public.ml_listing_tasks t
     WHERE t.organization_id = o.id
       AND t.seller_id       = ml.seller_id
       AND t.status          = 'open'
       AND t.severity IN ('critical', 'high')
       AND t.estimated_impact_brl IS NOT NULL
       AND t.estimated_impact_brl > 0)                             AS high_impact_total_estimated_brl

FROM public.organizations o
CROSS JOIN LATERAL (
  SELECT DISTINCT seller_id
    FROM public.ml_connections
    WHERE organization_id = o.id
) ml;

-- 5. GRANTs explícitos ─────────────────────────────────────────────────
-- Tabelas criadas via _admin_exec_sql RPC NÃO recebem default privileges
-- (gotcha feedback_grant_admin_exec_sql). Sem isso, RLS bloqueia tudo.
GRANT ALL                              ON public.ml_dashboard_summary       TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE   ON public.ml_dashboard_summary       TO authenticated;

GRANT ALL                              ON public.ml_sales_daily             TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE   ON public.ml_sales_daily             TO authenticated;

GRANT ALL                              ON public.ml_dashboard_refresh_logs  TO service_role;
GRANT SELECT, INSERT, UPDATE           ON public.ml_dashboard_refresh_logs  TO authenticated;

GRANT SELECT                           ON public.v_dashboard_aggregated_metrics TO service_role;
GRANT SELECT                           ON public.v_dashboard_aggregated_metrics TO authenticated;
