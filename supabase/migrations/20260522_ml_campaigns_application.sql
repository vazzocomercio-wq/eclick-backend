-- ============================================================
-- F8 ML Campaign Center IA — Camada 3 (K3)
-- Apply Service + Auditoria
-- ============================================================

-- ─── 1. ml_campaign_apply_jobs ────────────────────────────────
CREATE TABLE IF NOT EXISTS ml_campaign_apply_jobs (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seller_id                   bigint NOT NULL,
  user_id                     uuid NOT NULL,         -- auth.users(id) — sem FK

  -- Tipo de job
  job_type                    text NOT NULL CHECK (job_type IN (
    'apply_single',         -- 1 recomendacao
    'apply_batch',          -- multiplas recomendacoes selecionadas
    'remove_single',        -- sair de 1 campanha
    'validate'              -- dry-run sem aplicar
  )),

  -- Operacao ML pra cada item
  default_operation           text NOT NULL CHECK (default_operation IN (
    'POST',                 -- criar oferta
    'DELETE',               -- remover oferta
    'VALIDATE'              -- so valida
  )),

  -- Escopo
  recommendation_ids          uuid[] DEFAULT '{}',

  -- Modo: 'safe' para no primeiro erro, 'best_effort' aplica o que puder
  apply_mode                  text NOT NULL DEFAULT 'safe' CHECK (apply_mode IN (
    'safe', 'best_effort'
  )),

  -- Status
  status                      text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'validating', 'applying', 'completed', 'partial', 'failed', 'cancelled'
  )),

  -- Progresso
  total_count                 integer NOT NULL DEFAULT 0,
  validated_count             integer DEFAULT 0,
  applied_count               integer DEFAULT 0,
  failed_count                integer DEFAULT 0,
  skipped_count               integer DEFAULT 0,

  -- Resultados detalhados (1 entry por recomendacao)
  -- [{ recommendation_id, status: 'applied'|'failed'|'skipped',
  --    item_id, error_code?, error_message?, new_offer_id? }, ...]
  results                     jsonb DEFAULT '[]'::jsonb,

  -- Metricas
  estimated_revenue           numeric,
  estimated_margin            numeric,

  started_at                  timestamptz,
  completed_at                timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_apply_jobs_org_seller
  ON ml_campaign_apply_jobs(organization_id, seller_id);
CREATE INDEX IF NOT EXISTS idx_apply_jobs_active
  ON ml_campaign_apply_jobs(organization_id, status)
  WHERE status IN ('pending', 'validating', 'applying');
CREATE INDEX IF NOT EXISTS idx_apply_jobs_recent
  ON ml_campaign_apply_jobs(organization_id, created_at DESC);

-- ─── 2. ml_campaign_audit_log ────────────────────────────────
-- Audit log granular: 1 row por operacao executada (INSERT-only,
-- nunca UPDATE/DELETE pra preservar historico).
CREATE TABLE IF NOT EXISTS ml_campaign_audit_log (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seller_id                   bigint NOT NULL,
  job_id                      uuid REFERENCES ml_campaign_apply_jobs(id) ON DELETE SET NULL,
  recommendation_id           uuid REFERENCES ml_campaign_recommendations(id) ON DELETE SET NULL,
  campaign_id                 uuid REFERENCES ml_campaigns(id) ON DELETE SET NULL,
  product_id                  uuid REFERENCES products(id) ON DELETE SET NULL,
  user_id                     uuid,                  -- auth.users(id)

  -- Identificacao ML
  ml_item_id                  text NOT NULL,
  ml_campaign_id              text NOT NULL,
  ml_promotion_type           text NOT NULL,
  ml_offer_id_before          text,
  ml_offer_id_after           text,

  -- Operacao
  operation                   text NOT NULL CHECK (operation IN (
    'POST', 'PUT', 'DELETE', 'VALIDATE'
  )),
  action                      text NOT NULL CHECK (action IN (
    'join_campaign', 'leave_campaign', 'edit_offer',
    'price_change', 'quantity_change', 'validate_only'
  )),

  -- Dados antes/depois
  values_before               jsonb,
  values_after                jsonb NOT NULL,

  -- ML API
  ml_payload                  jsonb NOT NULL,
  ml_response                 jsonb,
  ml_response_status          integer,
  applied_successfully        boolean NOT NULL,
  error_code                  text,
  error_message               text,

  -- Metricas (preenchido apos sync pos-aplicacao)
  margin_impact_brl           numeric,
  margin_impact_pct           numeric,

  applied_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_org_seller
  ON ml_campaign_audit_log(organization_id, seller_id, applied_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_item
  ON ml_campaign_audit_log(organization_id, ml_item_id, applied_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_campaign
  ON ml_campaign_audit_log(organization_id, campaign_id, applied_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user
  ON ml_campaign_audit_log(organization_id, user_id, applied_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_failures
  ON ml_campaign_audit_log(organization_id, applied_at DESC)
  WHERE applied_successfully = false;

-- ─── GRANTs ───────────────────────────────────────────────────
DO $$
DECLARE
  tbl text;
  affected_tables text[] := ARRAY[
    'ml_campaign_apply_jobs',
    'ml_campaign_audit_log'
  ];
BEGIN
  FOREACH tbl IN ARRAY affected_tables LOOP
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', tbl);
  END LOOP;
END $$;
