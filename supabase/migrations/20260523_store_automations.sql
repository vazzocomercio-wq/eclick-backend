-- ============================================================
-- Onda 4 / A3 — Automações Autônomas da Loja
-- A IA detecta situações no catálogo/vendas/estoque e propõe
-- ações que o lojista aprova (ou auto-executa conforme config).
-- ============================================================

CREATE TABLE IF NOT EXISTS store_automation_actions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  trigger_type TEXT NOT NULL CHECK (trigger_type IN (
    'low_stock','high_stock','sales_drop','sales_spike',
    'low_conversion','high_conversion',
    'competitor_price_drop','competitor_out_of_stock',
    'low_score','no_content','no_ads','ads_underperforming',
    'abandoned_carts_spike','new_product_ready',
    'seasonal_opportunity','margin_erosion','review_needed'
  )),

  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low','opportunity')),

  product_ids    UUID[] NOT NULL DEFAULT '{}',
  affected_count INTEGER NOT NULL DEFAULT 0,

  -- Ação proposta (shape varia por trigger_type)
  proposed_action JSONB NOT NULL DEFAULT '{}'::jsonb,

  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending','approved','executing','completed',
    'rejected','auto_executed','failed','expired'
  )),
  executed_at      TIMESTAMPTZ,
  execution_result JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Feedback do lojista (alimenta tuning)
  lojista_feedback TEXT CHECK (lojista_feedback IS NULL OR lojista_feedback IN (
    'util','nao_relevante','timing_ruim','acao_errada'
  )),

  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '3 days'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_store_actions_org      ON store_automation_actions(organization_id);
CREATE INDEX IF NOT EXISTS idx_store_actions_pending  ON store_automation_actions(organization_id, status)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_store_actions_trigger  ON store_automation_actions(trigger_type);
CREATE INDEX IF NOT EXISTS idx_store_actions_severity ON store_automation_actions(severity);
CREATE INDEX IF NOT EXISTS idx_store_actions_created  ON store_automation_actions(created_at);

-- Config de automação por org
CREATE TABLE IF NOT EXISTS store_automation_config (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,

  enabled            BOOLEAN NOT NULL DEFAULT true,
  analysis_frequency TEXT    NOT NULL DEFAULT 'daily'
    CHECK (analysis_frequency IN ('hourly','daily','weekly')),

  -- Triggers ativos (default: maioria dos seguros)
  active_triggers TEXT[] NOT NULL DEFAULT ARRAY[
    'low_stock','high_stock','sales_drop','sales_spike',
    'low_conversion','competitor_price_drop','low_score',
    'no_content','abandoned_carts_spike','seasonal_opportunity'
  ]::text[],

  -- Triggers que rodam SEM aprovação (default: nenhum — lojista decide
  -- quando confia)
  auto_execute_triggers TEXT[] NOT NULL DEFAULT '{}'::text[],

  notify_channel TEXT NOT NULL DEFAULT 'dashboard'
    CHECK (notify_channel IN ('dashboard','whatsapp','email','all')),
  notify_min_severity TEXT NOT NULL DEFAULT 'medium'
    CHECK (notify_min_severity IN ('opportunity','low','medium','high','critical')),

  max_auto_actions_per_day  INTEGER NOT NULL DEFAULT 10,
  max_price_change_auto_pct NUMERIC NOT NULL DEFAULT 5,
  max_budget_auto_brl       NUMERIC NOT NULL DEFAULT 50,

  last_analysis_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.set_store_automation_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_store_automation_config_updated ON store_automation_config;
CREATE TRIGGER trg_store_automation_config_updated
  BEFORE UPDATE ON store_automation_config
  FOR EACH ROW EXECUTE FUNCTION public.set_store_automation_updated_at();

-- RLS
ALTER TABLE store_automation_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_automation_config  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS store_actions_select ON store_automation_actions;
CREATE POLICY store_actions_select ON store_automation_actions FOR SELECT TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS store_actions_modify ON store_automation_actions;
CREATE POLICY store_actions_modify ON store_automation_actions FOR ALL TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()))
WITH CHECK (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS store_config_select ON store_automation_config;
CREATE POLICY store_config_select ON store_automation_config FOR SELECT TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS store_config_modify ON store_automation_config;
CREATE POLICY store_config_modify ON store_automation_config FOR ALL TO authenticated
USING (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()))
WITH CHECK (organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()));
