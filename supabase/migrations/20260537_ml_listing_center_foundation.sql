-- ============================================================
-- F10 ML Listing Center IA — Camada L1 Foundation + Agregação
-- Cria 3 tabelas (tasks, scan_logs, summary) + VIEW agregadora.
-- VIEW lê de F7 (ml_quality_snapshots), F8 (ml_campaign_*), F9
-- (supplier_products via seller_account_suppliers + product_listings).
-- Multi-conta natural via seller_id em todas as tabelas.
-- Spec canônica: docs/ml-listing-center-spec.md
-- ============================================================

-- 1. ml_listing_tasks ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ml_listing_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  seller_id BIGINT NOT NULL,
  ml_item_id TEXT NOT NULL,
  ml_user_product_id TEXT,
  product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,

  task_type TEXT NOT NULL CHECK (task_type IN (
    'OUT_OF_STOCK',
    'INACTIVE_PAUSED',
    'QUALITY_LOW',
    'QUALITY_INCOMPLETE',
    'PRICE_HIGH',
    'PRICE_AUTOMATION_AVAILABLE',
    'FISCAL_DATA_MISSING',
    'PROMOTION_AVAILABLE',
    'PROMOTION_HIGH_OPPORTUNITY',
    'DROPSHIP_PARTNER_OUT_OF_STOCK',
    'CATALOG_ELIGIBLE',
    'LOSING_BUY_BOX',
    'INACTIVE_BY_POLICY',
    'WRONG_DIMENSIONS',
    'SHIPPING_COST_CHANGED',
    'BUYER_EXPERIENCE_ISSUE',
    'FULL_ELIGIBLE'
  )),
  task_title TEXT NOT NULL,
  task_description TEXT,

  source TEXT NOT NULL CHECK (source IN (
    'aggregated_quality',
    'aggregated_campaign',
    'aggregated_dropship',
    'scanner_stock',
    'scanner_status',
    'scanner_pricing',
    'scanner_automation',
    'scanner_catalog',
    'scanner_fiscal',
    'scanner_dimensions',
    'scanner_shipping',
    'scanner_experience',
    'manual'
  )),

  source_record_id UUID,
  source_table TEXT,

  severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  priority_score INTEGER CHECK (priority_score >= 0 AND priority_score <= 100),

  impact_area TEXT[] DEFAULT '{}',
  estimated_impact_brl NUMERIC,
  estimated_impact_description TEXT,

  current_value JSONB DEFAULT '{}'::jsonb,
  suggested_value JSONB DEFAULT '{}'::jsonb,
  suggested_action TEXT,

  deeplink_url TEXT,
  deeplink_module TEXT,

  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
    'open', 'snoozed', 'in_progress',
    'resolved_auto', 'resolved_manual', 'dismissed', 'expired'
  )),
  snoozed_until TIMESTAMPTZ,
  resolution_notes TEXT,
  resolved_by UUID REFERENCES auth.users(id),
  resolved_at TIMESTAMPTZ,

  first_detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  detection_count INTEGER DEFAULT 1,

  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_listing_tasks_org_seller
  ON public.ml_listing_tasks(organization_id, seller_id);
CREATE INDEX IF NOT EXISTS idx_listing_tasks_item
  ON public.ml_listing_tasks(ml_item_id);
CREATE INDEX IF NOT EXISTS idx_listing_tasks_product
  ON public.ml_listing_tasks(product_id);
CREATE INDEX IF NOT EXISTS idx_listing_tasks_type
  ON public.ml_listing_tasks(task_type);
CREATE INDEX IF NOT EXISTS idx_listing_tasks_status_open
  ON public.ml_listing_tasks(status)
  WHERE status IN ('open', 'snoozed', 'in_progress');
CREATE INDEX IF NOT EXISTS idx_listing_tasks_priority
  ON public.ml_listing_tasks(priority_score DESC)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_listing_tasks_severity
  ON public.ml_listing_tasks(severity)
  WHERE status = 'open';

-- 1 tarefa ativa do mesmo tipo por item (idempotência)
CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_tasks_unique_active
  ON public.ml_listing_tasks(organization_id, seller_id, ml_item_id, task_type)
  WHERE status IN ('open', 'snoozed', 'in_progress');

-- 2. ml_listing_scan_logs ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ml_listing_scan_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  seller_id BIGINT,
  scan_type TEXT NOT NULL CHECK (scan_type IN (
    'full', 'aggregation_only',
    'scanner_stock', 'scanner_status',
    'scanner_pricing', 'scanner_automation', 'scanner_catalog',
    'scanner_fiscal', 'scanner_dimensions',
    'scanner_shipping', 'scanner_experience'
  )),
  items_scanned INTEGER DEFAULT 0,
  tasks_created INTEGER DEFAULT 0,
  tasks_updated INTEGER DEFAULT 0,
  tasks_resolved_auto INTEGER DEFAULT 0,
  api_calls_count INTEGER DEFAULT 0,
  errors_count INTEGER DEFAULT 0,
  error_details JSONB DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'partial')),
  duration_seconds INTEGER,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_listing_scan_logs_org_seller
  ON public.ml_listing_scan_logs(organization_id, seller_id);
CREATE INDEX IF NOT EXISTS idx_listing_scan_logs_status
  ON public.ml_listing_scan_logs(status);

-- 3. ml_listing_summary ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ml_listing_summary (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  seller_id BIGINT NOT NULL,
  total_open_tasks INTEGER DEFAULT 0,
  total_critical INTEGER DEFAULT 0,
  total_high INTEGER DEFAULT 0,
  total_medium INTEGER DEFAULT 0,
  total_low INTEGER DEFAULT 0,
  tasks_by_type JSONB DEFAULT '{}'::jsonb,
  total_estimated_impact_brl NUMERIC DEFAULT 0,
  high_impact_tasks_count INTEGER DEFAULT 0,
  avg_resolution_hours NUMERIC,
  tasks_resolved_30d INTEGER DEFAULT 0,
  tasks_created_30d INTEGER DEFAULT 0,
  last_full_scan_at TIMESTAMPTZ,
  next_scan_scheduled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_summary_unique
  ON public.ml_listing_summary(organization_id, seller_id);

-- 4. v_listing_aggregated_signals — VIEW agregadora ──────────
-- Lê SEM duplicar dados dos módulos F7/F8/F9. Mudanças nos módulos
-- refletem automaticamente. Cron de aggregateSignals() consome essa
-- VIEW e cria/atualiza ml_listing_tasks.
CREATE OR REPLACE VIEW public.v_listing_aggregated_signals AS
-- F7 Quality Center
SELECT
  qs.organization_id,
  qs.seller_id,
  qs.ml_item_id,
  qs.product_id,
  'aggregated_quality'::text     AS source,
  qs.id                          AS source_record_id,
  'ml_quality_snapshots'::text   AS source_table,
  CASE
    WHEN qs.ml_score < 50      THEN 'QUALITY_LOW'
    WHEN qs.pending_count > 0  THEN 'QUALITY_INCOMPLETE'
    ELSE NULL
  END AS task_type,
  CASE
    WHEN qs.ml_score < 30 THEN 'critical'
    WHEN qs.ml_score < 50 THEN 'high'
    WHEN qs.ml_score < 70 THEN 'medium'
    ELSE 'low'
  END AS severity,
  qs.ml_score                    AS quality_score,
  qs.pending_count               AS missing_attrs_count,
  qs.has_exposure_penalty,
  qs.fetched_at                  AS source_updated_at
FROM public.ml_quality_snapshots qs
WHERE qs.ml_score < 70 OR qs.has_exposure_penalty = true OR qs.pending_count > 0

UNION ALL

-- F8 Campaign Center
SELECT
  cr.organization_id,
  cr.seller_id,
  ci.ml_item_id,
  cr.product_id,
  'aggregated_campaign'::text         AS source,
  cr.id                                AS source_record_id,
  'ml_campaign_recommendations'::text  AS source_table,
  CASE
    WHEN cr.recommendation = 'recommended' AND cr.opportunity_score >= 80 THEN 'PROMOTION_HIGH_OPPORTUNITY'
    WHEN cr.recommendation IN ('recommended', 'recommended_caution')      THEN 'PROMOTION_AVAILABLE'
    ELSE NULL
  END AS task_type,
  CASE
    WHEN cr.opportunity_score >= 90 THEN 'high'
    WHEN cr.opportunity_score >= 75 THEN 'medium'
    ELSE 'low'
  END AS severity,
  NULL::integer  AS quality_score,
  NULL::integer  AS missing_attrs_count,
  false          AS has_exposure_penalty,
  cr.created_at  AS source_updated_at
FROM public.ml_campaign_recommendations cr
JOIN public.ml_campaign_items ci ON ci.id = cr.campaign_item_id
WHERE cr.status = 'pending' AND cr.recommendation IN ('recommended', 'recommended_caution')

UNION ALL

-- F9 Dropship Center
-- supplier_products NÃO tem seller_id direto. Resolver via
-- seller_account_suppliers (mapeia marketplace+seller_id → supplier_id por org).
SELECT
  sas.organization_id,
  sas.seller_id,
  pl.listing_id                      AS ml_item_id,
  sp.product_id,
  'aggregated_dropship'::text        AS source,
  sp.id                              AS source_record_id,
  'supplier_products'::text          AS source_table,
  'DROPSHIP_PARTNER_OUT_OF_STOCK'    AS task_type,
  CASE
    WHEN sp.partner_available <= 0 THEN 'critical'
    WHEN sp.partner_available <= 3 THEN 'high'
    ELSE 'medium'
  END AS severity,
  NULL::integer                      AS quality_score,
  NULL::integer                      AS missing_attrs_count,
  false                              AS has_exposure_penalty,
  sp.last_stock_change_at            AS source_updated_at
FROM public.supplier_products sp
JOIN public.seller_account_suppliers sas
  ON  sas.supplier_id     = sp.supplier_id
  AND sas.organization_id = sp.organization_id
  AND sas.active_until IS NULL
  AND sas.marketplace     = 'mercado_livre'
JOIN public.product_listings pl
  ON  pl.product_id = sp.product_id
  AND pl.platform   = 'mercadolivre'
  AND pl.is_active  = true
WHERE sp.partner_available <= 3;

-- 5. GRANTs explícitos ────────────────────────────────────────
-- Tabelas criadas via _admin_exec_sql RPC NÃO recebem default privileges
-- (gotcha feedback_grant_admin_exec_sql). Sem isso, RLS bloqueia tudo.
GRANT ALL ON public.ml_listing_tasks                  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ml_listing_tasks TO authenticated;

GRANT ALL ON public.ml_listing_scan_logs              TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.ml_listing_scan_logs TO authenticated;

GRANT ALL ON public.ml_listing_summary                TO service_role;
GRANT SELECT ON public.ml_listing_summary             TO authenticated;

GRANT SELECT ON public.v_listing_aggregated_signals   TO service_role;
GRANT SELECT ON public.v_listing_aggregated_signals   TO authenticated;

-- Notify PostgREST pra ele detectar as novas tabelas/views
NOTIFY pgrst, 'reload schema';
